import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatComplete } from '../../worker/src/agnes.mjs';

const env = { AGNES_BASE_URL: 'https://x.example/v1', AGNES_MODEL: 'm-1', AGNES_API_KEY: 'k' };
const okRes = () => new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"好","cites":[]}' } }] }), { status: 200 });

function mockFetch(statusOrFn) {
  const calls = [];
  const fn = typeof statusOrFn === 'function' ? statusOrFn
    : () => new Response('oops', { status: statusOrFn });
  const impl = (url, init) => { calls.push({ url, init }); return fn(url, init); };
  impl.calls = calls;
  return impl;
}

test('拼 OpenAI 兼容请求并提取 content', async () => {
  const f = mockFetch(() => okRes());
  const r = await chatComplete({ messages: [{ role: 'user', content: 'q' }], env, fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(r.content).answer, '好');
  assert.equal(f.calls.length, 1);
});

test('5xx 重试一次后成功', async () => {
  let n = 0;
  const f = () => { n++; return n < 2 ? new Response('err', { status: 502 }) : okRes(); };
  const r = await chatComplete({ messages: [], env, fetchImpl: f });
  assert.equal(r.ok, true);
});

test('4xx 不重试直接失败', async () => {
  const f = mockFetch(401);
  const r = await chatComplete({ messages: [], env, fetchImpl: f });
  assert.equal(r.ok, false);
});

test('请求带 Authorization 和模型名', async () => {
  let captured;
  const f = (url, init) => { captured = { url, init }; return okRes(); };
  await chatComplete({ messages: [{ role: 'user', content: 'q' }], env, fetchImpl: f });
  assert.equal(captured.url, 'https://x.example/v1/chat/completions');
  assert.equal(captured.init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'm-1');
  assert.equal(body.max_tokens, 2000);
});

test('响应缺 choices 返回失败', async () => {
  const f = () => new Response('{"error":"x"}', { status: 200 });
  const r = await chatComplete({ messages: [], env, fetchImpl: f });
  assert.equal(r.ok, false);
});
