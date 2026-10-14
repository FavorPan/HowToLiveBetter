import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, MAX_QUESTION, MAX_HISTORY } from '../../worker/src/prompt.mjs';

const hits = [{ entry: { id: '19-3', sec: 19, n: 3, title: '被裁员能拿多少经济补偿', cost: '无', human: '按年限拿补偿。', gain: 'N 的算法。', note: '', grade: 'A', section: '在职、离职和工伤' }, score: 12 }];

test('系统提示词约束书内作答与 JSON 字段', () => {
  const msgs = buildMessages({ question: '被裁能拿多少钱', hits, history: [] });
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content.includes('只能依据'), true);
  assert.equal(msgs[0].content.includes('"answer"'), true);
  assert.equal(msgs[0].content.includes('"cites"'), true);
});

test('条目原文块带 id、节条号与标题', () => {
  const msgs = buildMessages({ question: 'q', hits, history: [] });
  assert.equal(msgs[1].content.includes('[19-3]'), true);
  assert.equal(msgs[1].content.includes('被裁员能拿多少经济补偿'), true);
  assert.equal(msgs[1].content.includes('读者的问题：q'), true);
});

test('历史截到最近 3 轮并标注不可信', () => {
  const h = Array.from({ length: 5 }, (_, i) => ({ q: '问题' + i, a: '回答' + i }));
  const msgs = buildMessages({ question: '现在这个问题', hits, history: h });
  assert.equal(msgs[1].content.includes('不可信'), true);
  assert.equal(msgs[1].content.includes('问题4'), true);
  assert.equal(msgs[1].content.includes('问题2'), true);
  assert.equal(msgs[1].content.includes('问题1'), false);
  assert.equal(MAX_HISTORY, 3);
});

test('空问题抛错、超 500 字抛错、超长被截到 500', () => {
  assert.throws(() => buildMessages({ question: '   ', hits, history: [] }), /问题为空/);
  assert.throws(() => buildMessages({ question: 'a'.repeat(501), hits, history: [] }), /500/);
  assert.equal(MAX_QUESTION, 500);
});
