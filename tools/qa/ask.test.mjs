// tools/qa/ask.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAsk } from '../../worker/src/ask.mjs';
import { createLimiter } from '../../worker/src/quotas.mjs';
import { buildIndex } from '../../worker/src/retrieval.mjs';

const ENTRIES = [
  { id: '19-3', sec: 19, n: 3, title: '被裁员能拿多少经济补偿', human: '被裁员按工作年限拿补偿。', gain: 'N 的算法。', cost: '无', note: '', grade: 'A', section: '在职、离职和工伤' },
];
const index = buildIndex(ENTRIES);
// 测试语料只有一条，N=1 时分数偏低，阈值按测试语料校准传 5；
// 真书语料 N 为全书条目数（随上游更新变动，2026-10-14 时为 699），默认阈值 12 不适用这里。ask.mjs 走默认值。

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
          if (sql.startsWith('INSERT INTO usage_log')) {
            return { run: async () => { logs.push(a); } };
          }
          if (sql.startsWith('INSERT INTO qa_events')) {
            return { run: async () => { events.push(a); } };
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

const env = (over = {}) => ({
  DB: fakeD1(),
  QUOTA_SALT: 's3cret',
  QA_LIMIT_IP: '3',
  QA_ENABLED: '1',
  ...over,
});

const req = (body, ip = '1.2.3.4') => new Request('https://howtolivebetter.favorhub.top/api/qa/ask', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const agnesOk = () => async ({ messages }) => {
  const user = messages[1].content;
  const m = /\[([\d-]+)\]/.exec(user);
  return { ok: true, content: `{"answer":"按年限拿补偿。","cites":["${m[1]}"]}` };
};

test('正常回答：200 + cites + remaining 递减', async () => {
  const e = env();
  let calls = 0;
  const agnes = async (...a) => { calls++; return agnesOk()(...a); };
  const r1 = await handleAsk(req({ question: '被裁员能拿多少补偿' }), e, { agnes, index, threshold: 5, limiter: createLimiter(2) });
  const j1 = await r1.json();
  assert.equal(j1.type, 'answer');
  assert.deepEqual(j1.cites, [{ sec: 19, num: 3, title: '被裁员能拿多少经济补偿' }]);
  assert.equal(j1.remaining, 2);
  assert.equal(calls, 1);
  const r2 = await handleAsk(req({ question: '被裁员能拿多少补偿' }), e, { agnes, index, threshold: 5, limiter: createLimiter(2) });
  assert.equal((await r2.json()).remaining, 1);
  assert.equal(e.DB.logs.length, 2);
});

test('书外问题 no_hit，不调模型不扣次，写一行 qa_events', async () => {
  const e = env();
  let calls = 0;
  const agnes = async () => { calls++; return { ok: true, content: '{}' }; };
  const r = await handleAsk(req({ question: '明天买哪只股票会涨' }), e, { agnes, index, threshold: 5, limiter: createLimiter(2) });
  const j = await r.json();
  assert.equal(j.type, 'no_hit');
  assert.equal(calls, 0);
  assert.equal(e.DB.logs.length, 0);
  await new Promise(r2 => setTimeout(r2, 0)); // qa_events 是 fire-and-forget，等一个宏任务让 fakeD1 落账
  assert.equal(e.DB.events.length, 1);
  assert.equal(e.DB.events[0][1], 'no_hit');
});

test('超额 429，且不再调 Agnes', async () => {
  const e = env({ QA_LIMIT_IP: '1' });
  let calls = 0;
  const agnes = async () => { calls++; return agnesOk()({ messages: [{}, { content: '[19-3] x' }] }); };
  const opts = { agnes, index, threshold: 5, limiter: createLimiter(2) };
  const r1 = await handleAsk(req({ question: '被裁员能拿多少补偿' }), e, opts);
  assert.equal((await r1.json()).type, 'answer');
  const r2 = await handleAsk(req({ question: '被裁员能拿多少补偿' }), e, opts);
  assert.equal(r2.status, 429);
  assert.equal(calls, 1);
});

test('模型输出非法：重试一次后 type=fail，不扣次', async () => {
  const e = env();
  const seen = [];
  const agnes = async ({ messages }) => { seen.push(messages.length); return { ok: true, content: '我不会输出 JSON' }; };
  const r = await handleAsk(req({ question: '被裁员能拿多少补偿' }), e, { agnes, index, threshold: 5, limiter: createLimiter(2) });
  const j = await r.json();
  assert.equal(j.type, 'fail');
  assert.deepEqual(seen, [2, 4]); // 第二次带重试指令，消息多两条
  assert.equal(e.DB.logs.length, 0);
});

test('形状越界：超 500 字、空问题、坏 JSON、大 body', async () => {
  const e = env();
  const opts = { agnes: async () => agnesOk()({ messages: [{}, { content: '[19-3] x' }] }), index, threshold: 5, limiter: createLimiter(2) };
  assert.equal((await handleAsk(req({ question: 'a'.repeat(501) }), e, opts)).status, 400);
  assert.equal((await handleAsk(req({ question: '  ' }), e, opts)).status, 400);
  assert.equal((await handleAsk(req('{bad'), e, opts)).status, 400);
  assert.equal((await handleAsk(req('x'.repeat(9000)), e, opts)).status, 400);
});

test('QA_ENABLED=0 一律 503', async () => {
  const r = await handleAsk(req({ question: 'x' }), env({ QA_ENABLED: '0' }), { agnes: async () => { throw new Error('不该被调'); }, index, threshold: 5, limiter: createLimiter(2) });
  assert.equal(r.status, 503);
});

test('并发第 3 个请求 429', async () => {
  const e = env();
  const limiter = createLimiter(2);
  // 两路并发都停在 agnes 里占住名额，第三路应拿 429。
  // 两路请求的 ip 参数传的是同一个值——subject（按 ip 哈希）必须相同，
  // 并发闸是按 subject 计的，ip 不同就各占各的名额，测不出互斥。
  const opts = { index, threshold: 5, limiter };
  const mk = () => {
    const gate = { current: false };
    let entered = false;
    opts.agnes = async () => { entered = true; while (gate.current === false) await new Promise(r => setTimeout(r, 5)); return agnesOk()({ messages: [{}, { content: '[19-3] x' }] }); };
    return { gate, isEntered: () => entered, p: handleAsk(req({ question: '被裁员能拿多少补偿' }, '9.9.9.9'), e, opts) };
  };
  const w1 = mk();
  while (!w1.isEntered()) await new Promise(r => setTimeout(r, 10)); // 等第一个请求进入 agnes 等待
  const w2 = mk();
  while (!w2.isEntered()) await new Promise(r => setTimeout(r, 10)); // 第 2 个并发也放行（上限 2）
  const r3 = await handleAsk(req({ question: '被裁员能拿多少补偿' }, '9.9.9.9'), e, opts);
  assert.equal(r3.status, 429);
  w1.gate.current = true;
  w2.gate.current = true;
  await w1.p; await w2.p;
});

// 终审 I1：跨站 POST 的入口闸
test('content-type 不是 application/json → 400', async () => {
  const e = env();
  const opts = { agnes: async () => { throw new Error('不该被调'); }, index, threshold: 5, limiter: createLimiter(2) };
  const r = await handleAsk(new Request('https://howtolivebetter.favorhub.top/api/qa/ask', {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"question":"被裁员能拿多少补偿"}',
  }), e, opts);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).message, '请求格式不对');
});

test('content-type 带 charset 参数照常放行', async () => {
  const e = env();
  const opts = { agnes: agnesOk(), index, threshold: 5, limiter: createLimiter(2) };
  const r = await handleAsk(new Request('https://howtolivebetter.favorhub.top/api/qa/ask', {
    method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"question":"被裁员能拿多少补偿"}',
  }), e, opts);
  assert.equal((await r.json()).type, 'answer');
});

test('白名单外 Origin → 403；白名单内与无 Origin 放行', async () => {
  const e = env();
  const opts = { agnes: agnesOk(), index, threshold: 5, limiter: createLimiter(2) };
  const mk = origin => new Request('https://evil.example.com/api/qa/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: '{"question":"被裁员能拿多少补偿"}',
  });
  const bad = await handleAsk(mk('https://evil.example.com'), e, opts);
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).message, '来源不被允许');
  assert.equal((await handleAsk(mk('https://favorpan.github.io'), e, opts)).status, 200);
  assert.equal((await handleAsk(mk('http://localhost:5173'), e, opts)).status, 200);
  assert.equal((await handleAsk(mk(null), e, opts)).status, 200); // curl 无 Origin
});

// 终审 M3：两类 429 带 reason，前端只在 daily 时清零显示
test('并发 429 带 reason=concurrent', async () => {
  const e = env();
  const limiter = createLimiter(1); // 只留 1 个名额：w1 占住后 w2 必拿 429
  const gate = { current: false };
  let entered = false;
  const opts = { index, threshold: 5, limiter, agnes: async () => { entered = true; while (!gate.current) await new Promise(r => setTimeout(r, 5)); return agnesOk()({ messages: [{}, { content: '[19-3] x' }] }); } };
  const w1 = handleAsk(req({ question: '被裁员能拿多少补偿' }, '9.9.9.9'), e, opts);
  while (!entered) await new Promise(r => setTimeout(r, 10)); // 等 w1 进 agnes、占住名额
  const r2 = await handleAsk(req({ question: '被裁员能拿多少补偿' }, '9.9.9.9'), e, opts);
  assert.equal(r2.status, 429);
  assert.equal((await r2.json()).reason, 'concurrent');
  gate.current = true;
  await w1;
});

test('日配额 429 带 reason=daily', async () => {
  const e = env({ QA_LIMIT_IP: '1' });
  const opts = { index, threshold: 5, limiter: createLimiter(2), agnes: agnesOk() };
  await handleAsk(req({ question: '被裁员能拿多少补偿' }, '8.8.8.8'), e, opts);
  const r = await handleAsk(req({ question: '被裁员能拿多少补偿' }, '8.8.8.8'), e, opts);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).reason, 'daily');
});

// 终审 I4 + M2：观测写失败绝不影响主流程
test('qa_events 写入抛错，no_hit 照样 200', async () => {
  const e = env();
  const orig = e.DB.prepare;
  e.DB.prepare = (sql) => {
    if (sql.startsWith('INSERT INTO qa_events')) throw new Error('D1 抖动');
    return orig.call(e.DB, sql);
  };
  const r = await handleAsk(req({ question: '明天买哪只股票会涨' }), e, { agnes: async () => { throw new Error('不该被调'); }, index, threshold: 5, limiter: createLimiter(2) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).type, 'no_hit');
  await new Promise(r2 => setTimeout(r2, 0)); // fire-and-forget 的日志路径抛错也不能冒泡成 unhandledRejection
});

// 线上实测（2026-10-16）：Workers 运行时会掐掉未挂 ctx.waitUntil 的裸 promise，
// qa_events/usage_log 线上空表。生产契约：ctx 存在时观测任务必须经 waitUntil 注册。
test('生产路径：no_hit 观测行经 ctx.waitUntil 注册并落账', async () => {
  const e = env();
  const tasks = [];
  const ctx = { waitUntil: p => tasks.push(p) };
  const opts = { agnes: async () => { throw new Error('不该被调'); }, index, threshold: 5, limiter: createLimiter(2), ctx };
  const r = await handleAsk(req({ question: '明天买哪只股票会涨' }), e, opts);
  assert.equal(r.status, 200);
  assert.equal(tasks.length, 1); // 恰好注册一个观测任务
  await tasks[0];                // 任务本身要能跑完（假 D1 落账）
  assert.equal(e.DB.events.length, 1);
  assert.equal(e.DB.events[0][1], 'no_hit');
});

test('生产路径：usage_log 经 ctx.waitUntil 注册并落账', async () => {
  const e = env();
  const tasks = [];
  const ctx = { waitUntil: p => tasks.push(p) };
  const opts = { agnes: agnesOk(), index, threshold: 5, limiter: createLimiter(2), ctx };
  const r = await handleAsk(req({ question: '被裁员能拿多少补偿' }), e, opts);
  assert.equal((await r.json()).type, 'answer');
  assert.equal(tasks.length, 1); // usage_log 一个任务
  await tasks[0];
  assert.equal(e.DB.logs.length, 1);
});

test('usage_log 写入抛错，answer 照样 200', async () => {
  const e = env();
  const orig = e.DB.prepare;
  e.DB.prepare = (sql) => {
    if (sql.startsWith('INSERT INTO usage_log')) throw new Error('D1 抖动');
    return orig.call(e.DB, sql);
  };
  const r = await handleAsk(req({ question: '被裁员能拿多少补偿' }), e, { agnes: agnesOk(), index, threshold: 5, limiter: createLimiter(2) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).type, 'answer');
});

// 终审 I5：日配额 limit 统一走 tierFor——改 QA_LIMIT_IP 即生效，两处内联已删
test('QA_LIMIT_IP=1 时日配额 429（limit 来自 tierFor）', async () => {
  const e = env({ QA_LIMIT_IP: '1' });
  const opts = { index, threshold: 5, limiter: createLimiter(2), agnes: agnesOk() };
  const r1 = await handleAsk(req({ question: '被裁员能拿多少补偿' }, '7.7.7.7'), e, opts);
  assert.equal((await r1.json()).type, 'answer');
  const r2 = await handleAsk(req({ question: '被裁员能拿多少补偿' }, '7.7.7.7'), e, opts);
  assert.equal(r2.status, 429);
});
