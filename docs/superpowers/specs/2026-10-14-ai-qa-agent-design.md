# AI 问答 + 会员系统设计（/agent）

日期：2026-10-14
状态：已经用户逐项确认，待实施
参照：Fangx-AI/better-life 的问答模式（服务端检索 + LLM 带引用回答 + 会员计量）

## 背景与目标

站点 howtolivebetter.favorhub.top（Cloudflare Pages，生产分支 `cloudflare-deploy`，由 sync-upstream workflow 每 10 分钟从 main 重生成并强推）。目标：读者在 `/agent` 页面对书的内容提问，系统检索书内条目、由 LLM 生成**必须引用条目**的回答；会员经爱发电订阅开通，获得更高配额。

**定位：严格书内助手。** 检索无命中就直接回答「这本书没写」，不调模型、不花钱；有命中时回答必须被条目原文支持，引用可点击跳回书目。书外问题一律拒答。

## 已定决策（用户逐项拍板）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 模型调用 | Cloudflare Worker 代理，key 只存 Worker secret |
| 2 | 问答定位 | 严格书内助手，无命中即拒答（不调模型） |
| 3 | 入口形态 | 独立页面 `agent.html`，路由 `/agent`，顶栏按钮跳转 |
| 4 | 模型 | Agnes 网关 `https://apihub.agnes-ai.com/v1`，`agnes-3.0-flash`（OpenAI 兼容，与 ai-daily-pulse 同款） |
| 5 | 检索位置 | 服务端（Worker），防伪造请求保护付费配额 |
| 6 | 收款 | 爱发电会员（无固定费，抽成约 6% 含通道费；支付模块做成 adapter 可日后换微信官方商户） |
| 7 | 存储 | Cloudflare D1（免费档 SQLite） |
| 8 | 配额 | **无全局熔断**（用户定）；三层常规限额 + 手动总闸环境变量 |
| 9 | 账号 | 用户名 + 密码（PBKDF2），不做短信/邮箱 |
| 10 | 聊天历史 | 仅浏览器内存，刷新即失，不上云 |

## 总体架构

```
浏览器
  ├─ /            index.html（检索页；main 不动，部署分支注入「问一问」按钮）
  ├─ /agent       agent.html（新页面：问答 UI、登录/会员状态、配额、引用卡片）
  └─ /api/*       Worker 路由（howtolivebetter.favorhub.top 同域，无 CORS）
       ├─ POST /api/qa/ask    校验→限流→鉴权→配额→检索→Agnes→验引用→记用量
       ├─ /api/auth/*         注册/登录/登出（会话存 D1）
       └─ /api/pay/*          爱发电验证开通 + webhook 续费
  ▼
Cloudflare D1：users / sessions / usage / memberships
  ▼
Agnes 网关（AGNES_API_KEY 存 secret；base_url 与模型名用 vars）
```

## 关键约束：fork 的「merge 永不冲突」不变量

main 除 `sync-upstream.yml` 外与上游保持一致，README 差异靠改写重放。因此：

- **不改 main 上的 index.html**。顶栏「问一问」按钮由 sync-upstream.yml 的 cloudflare-deploy 改写步骤**注入**（幂等 perl：`.nav-r` 区域插入 `<a href="/agent">`，已含 `/agent` 则跳过）。上游对 index.html 的任何改动都不受影响。
- agent.html、worker/、tools/qa/、qa.yml 均为**新增文件**，上游没有同名文件，merge 永不冲突。
- qa.yml 随现有「固定 workflows 为 fork 版」机制保留（GITHUB_TOKEN 推不了 workflow 变更的限制不受影响——由用户本地 push）。
- README 导航表加「问一问」行：先手工加；若上游改导航表导致重放丢失，手工补一行（不加 replay 规则，保持改写简单）。
- sitemap.xml 加 `/agent` 一行（低冲突，丢了手工补）。
- **离线单文件版零处理**：它从 main 的 index.html 构建，而 main 的 index.html 没有按钮，离线版天然无问答入口。agent.html 不参与离线构建。
- agent.html 内容不得触碰残留校验 grep 的词表（googletagmanager|mcyyy|wechat-reward|赞赏|tip-*|group ad）。

## 问答核心流程

### 语料：构建期产物（不用运行时解析）

- `tools/qa/build-corpus.mjs`（Node）**复用 `tools/lib/book.mjs` 的解析逻辑**生成 `corpus.json`：每条 `{id: "节-条", sec, num, title, cost, human, gain, note, grade, section}`。来源栏全文不进语料（token 控制）。
- qa.yml 在部署 Worker 前重建 corpus 并打进 Worker bundle（估算 gzip 后 200–300KB，免费档 3MB 内；超了迁 R2）。
- 书更新 → main push → qa.yml 重建重部署，语料与正文天然同步。

### 检索（Worker 内）

- 字符 bigram（CJK）+ 词元（Latin/数字）的 IDF 加权打分；标题命中加权最高，说人话、收益次之。
- top 6 条入 prompt；**top1 分数低于阈值（env 可调）→ 返回 `{type:"no_hit"}`，不调模型**。
- 后续用固定问题集做离线评估（书内问题要命中、书外问题要拒答），命中不达标再加同义词/别名映射，不预先过度设计。

### 生成与校验

- Prompt：系统提示词（只能依据给定条目、说人话风格与书一致、必须引用条目号、不足以回答就直说「书里没写」）+ 6 条原文 + 最近 3 轮对话摘要（明确标注为不可信历史，结论必须由本轮条目支持）。
- 强制 JSON 输出 `{answer, cites:[{sec,num}]}`；Worker 校验每条 cite ⊆ 本轮送入条目。校验失败：带更严格提示重试一次；再失败返回兜底文案，**绝不输出无引用回答**。
- 支持 client 中止：`req.signal` 透传给 Agnes fetch，读者点停止就停烧 token。
- 回答前端固定展示「AI 摘要，以书目原文为准」。

## 配额与防滥用（env 可调；无全局熔断）

| 层 | 默认 | 实现 |
|---|---|---|
| 匿名 | 3 次/天/IP | D1 计数，IP 只存「salt+day+ip」的 SHA-256，不存明文 |
| 登录用户 | 10 次/天 | D1 按用户计数；注册接口按 IP 限 3 账号/天，防脚本注册扩配额 |
| 会员 | 100 次/天 | 到期自动回落登录档 |
| 手动总闸 | QA_ENABLED env | 关闭时 /agent 与 /api 返回停用文案（运维总闸，非配额） |
| 请求形状 | 问题 ≤500 字、body ≤8KB、单 IP 并发 2（isolate 内存近似） | 入口校验 |

计量规则：模型调用**成功返回才扣次**；无命中拒答、校验失败兜底均不扣。

## 账号与会员

- users：用户名 3–20 字符、密码 ≥8 位；PBKDF2-SHA256（WebCrypto，10 万次迭代，随机盐）。v1 无找回密码（丢了重新注册）。
- sessions：32 字节随机 sid，HttpOnly + Secure + SameSite=Lax，7 天滑动过期，D1 存储。
- 爱发电绑定流程：会员页「去爱发电订阅」→ 付款后回站输入爱发电用户 ID（或粘贴主页链接解析）→ Worker 调爱发电 open API（`/api/open/query-sponsors`，user_id + token）验证对本站 plan_id 的有效订阅 → 写 memberships。webhook（`/api/pay/afdian-webhook`，校验 `md5(token+params)` 签名）处理续费/升级/过期。
- PaymentProvider adapter：`/api/pay/*` 只依赖「验证某爱发电用户是否有效订阅」+「处理 webhook」两个接口；换官方商户号时只换 adapter 文件。
- 爱发电收费事实（2026-10-14 查证）：创作者免费、无固定月费；抽成约 6%（含微信 0.6%/支付宝 0.55% 通道费）；提现可能按笔 1 元上下；结算 T+1 或更长。plan 定价由用户在爱发电后台自定，代码只认 plan_id。

## 前端 agent.html

- 与 index.html 同一设计语言（CSS 变量、卡片风格）；顶栏返回检索页。
- 元素：对话线程、输入框（500 字计数）、发送/停止/新对话、登录注册弹层、配额剩余展示、引用 chips、会员购买指引（爱发电链接 + 绑定入口）。
- 引用卡片 → 相对链接 `?q=标题特征词`（index.html 现有 `?q=` 参数直接过滤出该条目卡片，跨部署路径兼容：主站 `/agent` 与 GH Pages `/HowToLiveBetter/agent.html` 都对）。
- CORS：Worker 允许 `favorpan.github.io`（GH Pages 版直连主站 API）；主站同域无 CORS。

## 部署与 CI

- `worker/wrangler.toml`：route `howtolivebetter.favorhub.top/api/*`，D1 binding，vars（AGNES_BASE_URL、AGNES_MODEL、QA_ENABLED、各档配额数、爱发电 USER_ID/PLAN_ID）；secrets（AGNES_API_KEY、AFDIAN_API_TOKEN、AFDIAN_WEBHOOK_TOKEN）用 `wrangler secret put`。
- D1 建库一次（`wrangler d1 create`）；migration SQL 入库 `worker/migrations/`。
- `.github/workflows/qa.yml`：PR 只跑测试（`node --test tools/qa/`）；main push 跑测试 → 构建 corpus → wrangler deploy（repo secret `CLOUDFLARE_API_TOKEN`）。不碰 book.yml 发布链。
- 本地开发：`wrangler dev` + `.dev.vars`（gitignore）。
- 监控：usage 表按日聚合调用量；与 Agnes 后台对账。

## 测试（tools/qa/，node:test）

解析（book.mjs 复用后的 corpus 产物结构）、bigram 打分与阈值双向（书内命中/书外拒答）、prompt 组装快照、响应校验（伪造引用、缺 answer、非 JSON）、爱发电 sign 验证、配额扣减与回落、注册限频。固定评估集：20 个书内问题 + 10 个书外问题。

## 分期实施（每期独立可上线）

| 期 | 内容 | 验收 |
|---|---|---|
| 1 | 问答闭环：Worker + D1 + corpus + 检索 + Agnes + agent.html + 匿名配额 | 匿名每天 3 次，无命中拒答，引用可跳转 |
| 2 | 账号：注册/登录/会话 + 登录配额 | cookie 会话、限频生效 |
| 3 | 会员：爱发电绑定 + webhook + 会员配额 + 会员页 | 付费全自动开通，无需人工 |

## 非目标（v1 明确不做）

聊天记录云端存储与多设备同步；邮箱/短信登录与找回密码；流式输出（用 loading 态 + 可中止代替）；多语言；App/小程序。

## 已识别风险

1. **Workers 免费档 CPU 10ms**：已通过「构建期生成 corpus + 打包」绕开（请求时只做查表打分，微秒级）。若 corpus 超免费 bundle 上限，迁 R2。
2. **Agnes 网关可用性/费率变动**：base_url 与模型名都是 env；调用失败重试一次后兜底文案；adapter 抽象同支付。
3. **上游改动撞 README/sitemap**：按既定策略手工补行，不自动化。
4. **D1 免费档写配额 10 万/天**：每次问答 3–5 次写，当前流量富余两个数量级。
