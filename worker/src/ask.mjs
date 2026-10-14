// worker/src/ask.mjs
// /api/qa/ask 主流程。扣次语义：模型成功产出带有效引用的回答才扣；
// no_hit、校验失败兜底、上游报错、客户端中止一律不扣。
// 先查次后调模型、成功才写 D1——并发下极少量超用可接受，不做预留释放。

import { search } from './retrieval.mjs';
import { buildMessages, MAX_QUESTION, MAX_HISTORY } from './prompt.mjs';
import { parseModelOutput } from './validate.mjs';
import { chatComplete } from './agnes.mjs';
import { createLimiter, dayKey, tierFor } from './quotas.mjs';
import { clientIp, ipHash, json, originAllowed } from './util.mjs';

const MAX_BODY = 8 * 1024;
const RETRY_NOTE = '你上一次的输出不是合法 JSON 或引用无效。重新只输出一个 JSON 对象 {"answer":"...","cites":["节-条"]}，引用只能用给出的条目 id。';
const defaultLimiter = createLimiter(2); // deps 未传 limiter 时的兜底；生产路径由 index.mjs 传入 isolate 级共享实例

export async function handleAsk(request, env, deps = {}) {
  const origin = deps.origin ?? null;
  if (env.QA_ENABLED === '0') return json({ error: 'disabled', message: '问答功能维护中，暂时停用。' }, 503, origin);
  if (request.method !== 'POST') return json({ error: 'bad_request', message: '只接受 POST。' }, 400, origin);

  // 服务端闸（终审 I1）：跨站表单能不带预检就发 POST，必须校验 content-type、拒绝白名单外 Origin。
  const ct = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') return json({ error: 'bad_request', message: '请求格式不对' }, 400, origin);
  if (!originAllowed(request)) return json({ error: 'forbidden', message: '来源不被允许' }, 403, origin);

  // 超大 body 先看 content-length 挡在读体之前（终审 M5）；缺头才落到读后再查的路径。
  const declaredLen = parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY) return json({ error: 'bad_request', message: '请求过大。' }, 400, origin);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'bad_request', message: '请求过大。' }, 400, origin);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'bad_request', message: '请求不是合法 JSON。' }, 400, origin); }
  const { question, history } = body ?? {};
  if (typeof question !== 'string' || question.trim().length === 0) return json({ error: 'bad_request', message: '问题不能为空。' }, 400, origin);
  if (question.length > MAX_QUESTION) return json({ error: 'bad_request', message: '问题不能超过 500 字。' }, 400, origin);
  if (history !== undefined && !Array.isArray(history)) return json({ error: 'bad_request', message: 'history 格式不对。' }, 400, origin);
  // 只放行成对的合法 {q,a} 项（q/a 均须为非空字符串），非法项在此拒绝而非静默丢弃。
  const cleanHistory = history ?? [];
  if (cleanHistory.some(h => !h || typeof h.q !== 'string' || typeof h.a !== 'string' || h.q.trim().length === 0 || h.a.trim().length === 0))
    return json({ error: 'bad_request', message: 'history 里每一项都要有问和答。' }, 400, origin);

  const limiter = deps.limiter ?? defaultLimiter;
  const day = dayKey();
  const subject = 'ip:' + await ipHash(env.QUOTA_SALT ?? 'dev', day, clientIp(request));
  if (!limiter.enter(subject)) return json({ error: 'rate_limited', reason: 'concurrent', message: '请求太密了，等几秒再问。' }, 429, origin);
  try {
    const limit = tierFor(env).limit; // 档位统一从 tierFor 取（终审 I5），第 2 期扩档只改 quotas.mjs
    const row = await env.DB.prepare('SELECT count FROM usage WHERE day = ?1 AND subject = ?2').bind(day, subject).first();
    if ((row?.count ?? 0) >= limit) return json({ error: 'rate_limited', reason: 'daily', message: '今天在这个网络的免费次数用完了，明天早上 8 点后再来。' }, 429, origin);

    const index = deps.index;
    const agnes = deps.agnes ?? ((args) => chatComplete(args));
    const searchOpts = deps.threshold !== undefined ? { threshold: deps.threshold } : {};
    const hits = search(index, question, searchOpts);
    if (hits.type === 'no_hit') {
      // 观测（终审 I4）：不存问题文本，只记当天、类型和 top1 分数，供阈值再标定。best-effort。
      logEvent(env, day, 'no_hit', hits.hits[0]?.score ?? null);
      return json({ type: 'no_hit', message: '这本书没写这个问题，可以在检索页搜关键词试试。' }, 200, origin);
    }
    const validIds = new Set(hits.hits.map(h => h.entry.id));
    const callArgs = () => ({ messages: buildMessages({ question, hits: hits.hits, history: cleanHistory.slice(-MAX_HISTORY) }), env, signal: request.signal });

    let res = await safeCall(agnes, callArgs());
    if (!res.ok) {
      logEvent(env, day, 'fail', hits.hits[0]?.score ?? null);
      return json({ type: 'fail', message: '生成失败了，等一下再试。' }, 200, origin);
    }
    let parsed = parseModelOutput(res.content, validIds);
    if (!parsed.ok) {
      const retryArgs = callArgs();
      retryArgs.messages.push({ role: 'assistant', content: res.content.slice(0, 2000) });
      retryArgs.messages.push({ role: 'user', content: RETRY_NOTE });
      res = await safeCall(agnes, retryArgs);
      if (!res.ok) {
        logEvent(env, day, 'fail', hits.hits[0]?.score ?? null);
        return json({ type: 'fail', message: '生成失败了，等一下再试。' }, 200, origin);
      }
      parsed = parseModelOutput(res.content, validIds);
    }
    if (!parsed.ok) {
      logEvent(env, day, 'fail', hits.hits[0]?.score ?? null);
      return json({ type: 'fail', message: '生成失败了，等一下再试。' }, 200, origin);
    }

    const upRow = await env.DB.prepare(
      'INSERT INTO usage (day, subject, count) VALUES (?1, ?2, 1) ON CONFLICT (day, subject) DO UPDATE SET count = count + 1 RETURNING count'
    ).bind(day, subject).first();
    // 扣次已发生，日志写失败不能让读者 500（终审 M2）。
    logUsageOk(env, day, subject, question.length, parsed.answer.length);

    const titles = new Map(hits.hits.map(h => [h.entry.id, h.entry.title]));
    return json({
      type: 'answer',
      answer: parsed.answer,
      cites: parsed.cites.map(c => ({ sec: c.sec, num: c.num, title: titles.get(c.id) || c.id })),
      remaining: Math.max(0, limit - (upRow?.count ?? 1)),
    }, 200, origin);
  } finally {
    limiter.exit(subject);
  }
}

// no_hit / fail 观测行（qa_events 表，migration 0002）。绝不存问题文本。
// 整段 best-effort：D1 抖动不能影响读者拿到的回答。
function logEvent(env, day, type, top1) {
  // 不 await：观测行在响应返回后由 Workers 延长执行落库。同步抛错（D1 绑定异常、
  // 表不存在）也一样吞掉——终审 I4 的铁律：观测绝不改变读者拿到的回答。
  try {
    env.DB.prepare('INSERT INTO qa_events (day, type, top1, at) VALUES (?1, ?2, ?3, ?4)')
      .bind(day, type, top1, new Date().toISOString()).run().catch(() => {});
  } catch { /* 同上 */ }
}

function logUsageOk(env, day, subject, qchars, achars) {
  try {
    env.DB.prepare('INSERT INTO usage_log (ts, subject, qchars, achars, ok) VALUES (?1, ?2, ?3, ?4, 1)')
      .bind(Date.now(), subject, qchars, achars).run().catch(() => {});
  } catch { /* 同上（终审 M2） */ }
}

async function safeCall(agnes, args) {
  try { return await agnes(args); } catch { return { ok: false, reason: '调用异常' }; }
}
