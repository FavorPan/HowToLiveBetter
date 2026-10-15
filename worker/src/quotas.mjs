// worker/src/quotas.mjs
// 配额纯决策 + isolate 内存并发闸。日计数落 D1（Task 7），这里只做判断。

export function dayKey() {
  return new Date().toISOString().slice(0, 10); // UTC 日界=北京时间早 8 点重置
}

export function tierFor(env) {
  const limit = Math.max(1, parseInt(env.QA_LIMIT_IP ?? '3', 10) || 3);
  return { kind: 'ip', limit }; // 第 2/3 期扩 user/member 档
}

export function createLimiter(maxPerKey = 2) {
  const m = new Map();
  return {
    enter(key) {
      const c = (m.get(key) || 0) + 1;
      if (c > maxPerKey) return false;
      m.set(key, c);
      return true;
    },
    exit(key) {
      const c = (m.get(key) || 1) - 1;
      if (c <= 0) m.delete(key);
      else m.set(key, c);
    },
  };
}
