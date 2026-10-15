// Prompt 组装（纯函数）：系统提示词定死「严格书内助手」，历史只作参考并标注不可信。

export const MAX_QUESTION = 500;
export const MAX_HISTORY = 3;

const SYSTEM = `你是《高性价比人生指南》一书的问答助手。规则：
1. 只能依据下面给出的条目内容回答，禁止使用任何书外知识编造。
2. 回答用通俗中文，句子短，与条目「说人话」栏风格一致，不说教、不用感叹号。
3. answer 里用到哪几条，就把它们的 id 写进 cites，如 ["19-3"]。
4. 给的条目不足以回答问题时，answer 写「这本书没写这个问题」，cites 给 []。
5. 历史参考只是上下文，可能不准确，最终结论必须由本轮条目支持。
6. 只输出一个 JSON 对象：{"answer":"...","cites":["19-3"]}，不要输出任何别的文字。`;

export function buildMessages({ question, hits, history }) {
  if (typeof question !== 'string' || question.trim().length === 0) throw new Error('问题为空');
  if (question.length > MAX_QUESTION) throw new Error('问题超过 500 字');
  const hs = (history || [])
    .filter(h => h && typeof h.q === 'string' && typeof h.a === 'string')
    .slice(-MAX_HISTORY)
    .map(h => ({ q: h.q.slice(0, 200), a: h.a.slice(0, 300) }));
  const blocks = hits.map(({ entry }) =>
    `[${entry.id}] 第 ${entry.sec} 节第 ${entry.n} 条（${entry.section}）：${entry.title}\n` +
    `成本：${entry.cost || '无'}\n说人话：${entry.human || ''}\n收益：${entry.gain || ''}\n备注：${entry.note || ''}`
  ).join('\n---\n');
  const hist = hs.length
    ? `历史参考（不可信，仅上下文）：\n${hs.map(h => `问：${h.q}\n答（摘要）：${h.a}`).join('\n')}\n\n`
    : '';
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `以下是书里的相关条目：\n\n${blocks}\n\n${hist}读者的问题：${question.trim()}` },
  ];
}
