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
// 真书语料 buildIndex 后 N 上千，默认阈值 30 不适用这里。ask.mjs 走默认值。

function fakeD1() {
  const counts = new Map();
  const logs = [];
  return {
    logs,
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

test('书外问题 no_hit，不调模型不扣次', async () => {
  const e = env();
  let calls = 0;
  const agnes = async () => { calls++; return { ok: true, content: '{}' }; };
  const r = await handleAsk(req({ question: '明天买哪只股票会涨' }), e, { agnes, index, threshold: 5, limiter: createLimiter(2) });
  const j = await r.json();
  assert.equal(j.type, 'no_hit');
  assert.equal(calls, 0);
  assert.equal(e.DB.logs.length, 0);
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
