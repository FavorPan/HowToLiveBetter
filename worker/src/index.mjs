// worker/src/index.mjs
// 入口：路由、CORS、全局开关。请求期只做查表检索（corpus 构建期已生成）。
import corpus from './corpus.json' with { type: 'json' }; // Workers 和 Node ≥22.13 都认这个属性（spec 要求 Node ≥22.13）
import { buildIndex } from './retrieval.mjs';
import { handleAsk } from './ask.mjs';
import { createLimiter, dayKey, tierFor } from './quotas.mjs';
import { pickOrigin, json, corsPreflight, clientIp, ipHash } from './util.mjs';

const _index = buildIndex(corpus.entries); // isolate 生命周期内只建一次
const _limiter = createLimiter(2);         // 并发闸是 isolate 内的近似值（spec 已知）

// env 里的阈值必须是正数才透传；写了非法值就当没写，不能让 NaN 静默改变工作点（终审 C1.3 旋钮）。
function thresholdFrom(env) {
  const n = Number(env.QA_THRESHOLD);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export default {
  async fetch(request, env) {
    try {
      const origin = pickOrigin(request);
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') return corsPreflight(origin);
      if (env.QA_ENABLED === '0') return json({ error: 'disabled', message: '问答功能维护中，暂时停用。' }, 503, origin);

      if (url.pathname === '/api/qa/ask' && request.method === 'POST') {
        const deps = { origin, index: _index, limiter: _limiter };
        const th = thresholdFrom(env);
        if (th !== undefined) deps.threshold = th;
        return handleAsk(request, env, deps);
      }

      if (url.pathname === '/api/qa/quota' && request.method === 'GET') {
        const day = dayKey();
        const subject = 'ip:' + await ipHash(env.QUOTA_SALT ?? 'dev', day, clientIp(request));
        const limit = tierFor(env).limit; // 档位统一从 tierFor 取（终审 I5），与 ask.mjs 同一来源
        const row = await env.DB.prepare('SELECT count FROM usage WHERE day = ?1 AND subject = ?2').bind(day, subject).first();
        return json({ remaining: Math.max(0, limit - (row?.count ?? 0)), limit }, 200, origin);
      }

      return json({ error: 'not_found' }, 404, origin);
    } catch {
      // 兜底（终审 M6）：D1 抖动等未捕获异常不能让读者拿到 CF 1101 的 HTML 页。
      return json({ type: 'fail', message: '生成失败了，等一下再试。' }, 500);
    }
  },
};
