// tools/qa/quotas.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierFor, createLimiter, dayKey } from '../../worker/src/quotas.mjs';

test('档位与限额：Phase 1 只有 ip 档', () => {
  assert.deepEqual(tierFor({ QA_LIMIT_IP: '7' }), { kind: 'ip', limit: 7 });
  assert.deepEqual(tierFor({}), { kind: 'ip', limit: 3 });
});

test('并发限制：同 key 超过 2 拒绝，exit 后恢复', () => {
  const l = createLimiter(2);
  assert.equal(l.enter('a'), true);
  assert.equal(l.enter('a'), true);
  assert.equal(l.enter('a'), false);
  l.exit('a');
  assert.equal(l.enter('a'), true);
  l.exit('a'); l.exit('a');
  assert.equal(l.enter('a'), true); // 清干净后可再进
});

test('不同 key 互不影响', () => {
  const l = createLimiter(1);
  assert.equal(l.enter('x'), true);
  assert.equal(l.enter('y'), true);
  assert.equal(l.enter('x'), false);
});

test('dayKey 是 UTC 日期', () => {
  assert.match(dayKey(), /^\d{4}-\d{2}-\d{2}$/);
});
