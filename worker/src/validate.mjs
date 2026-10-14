// 模型输出校验：唯一放行口——没过引用校验的回答一个字都不出。

export function parseModelOutput(text, validIds) {
  if (typeof text !== 'string') return { ok: false, reason: '输出不是字符串' };
  const cleaned = text.replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return { ok: false, reason: '没找到 JSON' };
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return { ok: false, reason: 'JSON 不完整' };
  let obj;
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return { ok: false, reason: 'JSON 解析失败' };
  }
  if (typeof obj.answer !== 'string' || obj.answer.length === 0) return { ok: false, reason: 'answer 缺失' };
  if (obj.answer.length > 4000) return { ok: false, reason: 'answer 过长' };
  if (!Array.isArray(obj.cites)) return { ok: false, reason: 'cites 缺失' };
  const cites = [];
  for (const c of obj.cites) {
    if (typeof c !== 'string') return { ok: false, reason: 'cites 元素不是字符串' };
    const m = /^(\d+)-(\d+)$/.exec(c);
    if (!m) return { ok: false, reason: 'cites 格式错' };
    if (!validIds.has(c)) return { ok: false, reason: `引用 ${c} 不在本轮条目里` };
    cites.push({ sec: +m[1], num: +m[2], id: c });
  }
  return { ok: true, answer: obj.answer.trim(), cites };
}
