首次部署才需要，之后 qa.yml 自动部署。

## 一次性部署（本地终端跑，只有第一次需要）

合并到 main 之后、跑完下面的步骤（`wrangler d1 create` 并把 database_id 回填 wrangler.toml）之前，
qa.yml 的 deploy job 会因为 database_id 还是占位值而红，属预期，不用管（台账 R16①）。

```bash
cd worker
npx wrangler login                      # 或直接用 CLOUDFLARE_API_TOKEN 环境变量
npx wrangler d1 create hltb-qa          # 输出 database_id，回填 wrangler.toml
npx wrangler d1 execute hltb-qa --remote --file=migrations/0001_usage.sql
npx wrangler d1 execute hltb-qa --remote --file=migrations/0002_qa_events.sql
npx wrangler secret put AGNES_API_KEY   # 粘贴 Agnes key
npx wrangler secret put QUOTA_SALT      # openssl rand -hex 16
node ../tools/qa/build-corpus.mjs
npx wrangler deploy
```

验证（每条都要过）：
```bash
curl -s https://howtolivebetter.favorhub.top/api/qa/quota
# 期望 {"remaining":3,"limit":3}（从本机 IP 算）；若返回 404 说明路由没挂上，检查 wrangler.toml route
curl -s -X POST https://howtolivebetter.favorhub.top/api/qa/ask \
  -H 'content-type: application/json' -d '{"question":"被裁员能拿多少补偿"}'
# 期望 type:"answer" 带 cites；「怎么练钢琴」这类核心书外问题应得 no_hit，
# 「明天买哪只股票会涨」「养狗怎么养」这种命中但答不了的会进模型、
# 由模型输出 {"no_answer":true}，服务端转成 no_hit 文案且不扣次（记 miss 观测行）
```

排障：deploy 若报 corpus 相关的打包错误，先查 src/index.mjs 那行
`import corpus from './corpus.json' with { type: 'json' }` 的 import attributes
（Node ≥22.13 和当前 wrangler 都认，本地测试 Node 版本要够）。

## 端到端验收（线上）

1. push main 后等 sync-upstream 下一轮（≤10 分钟）确认部署分支 index.html 出现「AI 问答」链接（`gh api repos/FavorPan/HowToLiveBetter/contents/index.html?ref=cloudflare-deploy --jq .content | base64 -d | grep agent`）。
2. 打开 https://howtolivebetter.favorhub.top/agent → 问书内问题 → 回答带引用 chip → 点 chip 落到检索页对应条目卡片。
3. 书外问题 → 拒答文案；第 4 问 → 429 文案。
4. GitHub 仓库 Settings → Secrets 配好 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`；之后书更新会由 qa.yml 自动重建语料并部署。
5. 确认 main 分支 index.html 无任何改动：`git diff upstream/main -- index.html` 应为空。
