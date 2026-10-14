// LLM 网关客户端：OpenAI 兼容 /chat/completions。45s 超时；网络错/5xx 重试一次。
// key 只从 env（secret）取，绝不进日志、不进响应。

const TIMEOUT_MS = 45_000;

export async function chatComplete({ messages, env, signal, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const body = JSON.stringify({
    model: env.AGNES_MODEL,
    messages,
    max_tokens: 2000,
    temperature: 0.3,
  });
  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${env.AGNES_API_KEY}`,
  };
  let lastReason = '未知错误';
  for (let attempt = 0; attempt < 2; attempt++) {
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(new Error('timeout')), TIMEOUT_MS);
    try {
      const res = await doFetch(`${env.AGNES_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: signal ?? timer.signal,
      });
      if (res.status >= 500) { lastReason = `上游 ${res.status}`; continue; }
      if (!res.ok) return { ok: false, reason: `上游 ${res.status}` };
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) return { ok: false, reason: '响应缺 content' };
      return { ok: true, content };
    } catch (e) {
      if (e?.name === 'AbortError' || e?.message === 'timeout') return { ok: false, reason: '超时或中止' };
      lastReason = e?.message || '网络错误';
    } finally {
      clearTimeout(t);
    }
  }
  return { ok: false, reason: lastReason };
}
