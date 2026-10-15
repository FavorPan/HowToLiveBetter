// tools/qa/index.test.mjs
// 生产粘合层冒烟测试（终审 I2）：路由、CORS、开关、错误信封，外加一条副产品——
// import worker/src/index.mjs 本身就验证 corpus.json 的 import attributes 在 Node 侧可加载
// （wrangler 侧打包首验仍在 DEPLOY.md Step 3）。
// 跑之前必须先有 worker/src/corpus.json（CI 里 build-corpus 在前，本地 `node tools/qa/build-corpus.mjs`）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/src/index.mjs';

function fakeD1() {
  const counts = new Map();
  const logs = [];
  const events = [];
  return {
    logs,
    events,
    prepare(sql) {
      return {
        bind(...a) {
          if (sql.includes('ON CONFLICT')) {
            const [day, subject] = a;
            const key = day + '|' + subject;
            return {
              first: async () => {
                counts.set(`${day}|${subject}`, (counts.get(`${day}|${subject}`) || 0) + 1);
                return { count: counts.get(`${day}|${subject}`) };
              },
            };
          }
          if (sql.startsWith('INSERT INTO usage_log') || sql.startsWith('INSERT INTO qa_events')) {
            return { run: async () => { (sql.startsWith('INSERT INTO qa_events') ? events : logs).push(a); } };
          }
          if (sql.startsWith('SELECT count')) {
            const [day, subject] = a;
            return { first: async () => counts.has(`${day}|${subject}`) ? { count: counts.get(`${day}|${subject}`) } : null };
          }
          throw new Error('未知 SQL: ' + sql);
        },
      };
    },
  };
}

const BASE = 'https://howtolivebetter.favorhub.top';
const env = (over = {}) => ({
  DB: fakeD1(),
  QUOTA_SALT: 's3cret',
  QA_LIMIT_IP: '3',
  QA_ENABLED: '1',
  ...over,
});

const post = (body, headers = {}) => new Request(BASE + '/api/qa/ask', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

// chatComplete 的失败（连接被拒）走 ask.mjs 的 fail 信封——冒烟层要测的是路由和信封形状，
// 不是模型行为；agnes 的注入归 ask.test。env 里给一个本地拒连端口，绝不外发。
const OFFLINE = { AGNES_BASE_URL: 'http://127.0.0.1:9/v1', AGNES_MODEL: 'smoke', AGNES_API_KEY: 'smoke-key' };

function mockFetchOk() {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const m = /\[([\d-]+)\]/.exec(body.messages[1].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: `{"answer":"按年限拿补偿。","cites":["${m[1]}"]}` } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = saved; };
}

// 真实语料下「酒驾被查到会怎么处罚」稳定 hit（tools/qa/eval.mjs 自然问法层同款题）。
// agnes 从 env.AGNES_BASE_URL 读配置：给一个本地拒连端口，call 必失败，
// no_hit/fail 路径不碰网络；answer 路径需要 mock fetch（见 answer 测试）。
test('OPTIONS 预检：白名单 Origin 返回 CORS 头', async () => {
  const res = await worker.fetch(new Request(BASE + '/api/qa/ask', {
    method: 'OPTIONS', headers: { origin: 'https://favorpan.github.io' },
  }), env());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://favorpan.github.io');
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
});

test('POST ask：content-type 不对 → 400 信封', async () => {
  const res = await worker.fetch(post('{"question":"酒驾被查到会怎么处罚"}', { 'content-type': 'text/plain' }), env());
  assert.equal(res.status, 400);
  assert.equal((await res.json()).message, '请求格式不对');
});

test('POST ask：白名单外 Origin → 403 信封', async () => {
  const res = await worker.fetch(post({ question: '酒驾被查到会怎么处罚' }, { origin: 'https://evil.example.com' }), env());
  assert.equal(res.status, 403);
  assert.equal((await res.json()).message, '来源不被允许');
});

test('POST ask：核心书外问题 → 200 no_hit', async () => {
  const res = await worker.fetch(post({ question: '怎么练钢琴' }), env(OFFLINE));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).type, 'no_hit');
});

test('POST ask：书内问题走通 answer 信封（mock fetch，不外发）', async () => {
  const restore = mockFetchOk();
  try {
    const res = await worker.fetch(post({ question: '酒驾被查到会怎么处罚' }), env(OFFLINE));
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.type, 'answer');
    assert.ok(j.cites.length > 0 && j.cites[0].title);
    assert.equal(j.remaining, 2);
  } finally { restore(); }
});

test('GET quota → 200 {remaining,limit}', async () => {
  const res = await worker.fetch(new Request(BASE + '/api/qa/quota', {
    headers: { 'cf-connecting-ip': '1.2.3.4' },
  }), env());
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.deepEqual(j, { remaining: 3, limit: 3 });
});

test('未知路径 → 404', async () => {
  const res = await worker.fetch(new Request(BASE + '/api/qa/nope'), env());
  assert.equal(res.status, 404);
});

test('QA_ENABLED=0 → 503', async () => {
  const res = await worker.fetch(post({ question: '酒驾被查到会怎么处罚' }), env({ QA_ENABLED: '0' }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, 'disabled');
});

test('D1 抛错 → 500 JSON 信封，不是 CF 1101 的 HTML（终审 M6）', async () => {
  const e = env();
  e.DB.prepare = () => { throw new Error('D1 抖动'); };
  const res = await worker.fetch(new Request(BASE + '/api/qa/quota', {
    headers: { 'cf-connecting-ip': '1.2.3.4' },
  }), e);
  assert.equal(res.status, 500);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal((await res.json()).type, 'fail');
});

test('env QA_THRESHOLD 透传：阈值钉到 1e9 后书内问题也 no_hit', async () => {
  const res = await worker.fetch(post({ question: '酒驾被查到会怎么处罚' }), env({ ...OFFLINE, QA_THRESHOLD: '1000000000' }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).type, 'no_hit');
});

test('env QA_THRESHOLD 非法值回退默认（书内问题照 hit，mock fetch）', async () => {
  const restore = mockFetchOk();
  try {
    const res = await worker.fetch(post({ question: '酒驾被查到会怎么处罚' }), env({ ...OFFLINE, QA_THRESHOLD: 'abc' }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).type, 'answer');
  } finally { restore(); }
});
