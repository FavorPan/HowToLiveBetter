// 查表式检索：语料在构建期已解析好（corpus.json），请求期只做 bigram/IDF 查表打分。
// Workers 免费档单请求 CPU 10ms，绝不在请求期解析 markdown。

const CJK = /[一-鿿]/;
const LATIN = /[a-z0-9]+/g;

function bigrams(text) {
  const t = (text || '').toLowerCase();
  const out = new Set();
  for (const w of t.match(LATIN) || []) out.add(w);
  const chars = [...t];
  for (let i = 0; i < chars.length - 1; i++) {
    if (CJK.test(chars[i]) && CJK.test(chars[i + 1])) out.add(chars[i] + chars[i + 1]);
  }
  return out;
}

export function buildIndex(entries) {
  const docs = entries.map(e => ({
    entry: e,
    title: bigrams(e.title),
    body: bigrams([e.human, e.gain, e.cost, e.note, e.section].filter(Boolean).join(' ')),
  }));
  const df = new Map();
  for (const d of docs) {
    for (const g of d.title) df.set(g, (df.get(g) || 0) + 1);
    for (const g of d.body) if (!d.title.has(g)) df.set(g, (df.get(g) || 0) + 1);
  }
  return { docs, df, N: docs.length };
}

// 工作点标定（终审 C1 修复波，2026-10-14，语料 690 条，查询侧停用词生效后复测）：
// - 书外问题 top1 分布：中位约 11，尾部可到 28.9（「明天买哪只股票会涨」）。
// - 书内自然问法 top1 分布：目前最低 13.0（「第一次买房要注意什么」）；
//   「押金不给退找谁」top1 17.2，正确条目（第 15 节第 1 条）排第 5、得分 12.7。
// 两个分布在 12 到 28 区间大面积重叠，不存在能分开它们的阈值——15 会把「押金不给退找谁」
// 误拒（正确条目 12.7），所以工作点定 12。相邻域的书外问题（股票、考驾照这类词汇与书内条目相邻的）在 12 下会 hit，
// 交给 prompt 规则 4（「条目不足以回答就写书里没写」）兜底拒答；单 IP 每天封顶 3 次、
// flash 模型成本极低，误撞的暴露有限。
// 上线后按 qa_events 表的 no_hit 分布再标定；no_hit 率仍高优先加同义词/别名映射（spec 预留方向），
// 不是再动阈值。调参走 env QA_THRESHOLD（index.mjs 透传），不用改码重新部署。
export const DEFAULT_THRESHOLD = 12;

// 查询侧停用词：只收「带疑问词缀的高频 bigram」（怎么办/要不要这类）。
// 不收「多少」「怎么」这种裸疑问词——「能给多少钱」「怎么处理」是自然问法里的内容词，
// 书里经济补偿条目也靠这些字命中，收了会把正确条目的分打下去（终审实测）。
// 掩蔽式命中（切点两侧 bigram 一起废掉），不是删字符串：直接删字符串会让跨边界的字
// 拼出无关的新 bigram（删掉「要不要」后「针要不要打」会拼出「针要」）。
// 只作用于查询侧，语料侧不动。
const QUERY_STOPWORDS = [
  '要不要', '该不该', '能不能', '是不是', '有没有', '可不可以', '行不行', '算不算',
  '怎么办', '怎么样', '怎么弄', '怎么算', '叫什么', '是多少', '为什么', '是什么', '如何',
];
const STOP_RX = new RegExp(QUERY_STOPWORDS.join('|'), 'g');

export function search(index, query, { topK = 6, threshold = DEFAULT_THRESHOLD } = {}) {
  const q = bigrams((query || '').replace(STOP_RX, ' '));
  if (q.size === 0) return { hits: [], type: 'no_hit' };
  const N = index.N;
  const scored = index.docs.map(d => {
    let s = 0;
    for (const g of q) {
      if (!d.title.has(g) && !d.body.has(g)) continue;
      const idf = Math.log(1 + N / (1 + (index.df.get(g) || 0)));
      s += (d.title.has(g) ? 3 : 1) * idf;
    }
    return { entry: d.entry, score: s };
  });
  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, topK).filter(h => h.score > 0);
  // 契约（终审 C1）：永远返回 top-K 排名结果，threshold 只决定 type 字段。
  // 生产调用方（ask.mjs）只看 type；评估层用低 threshold 单独看排名。
  if (hits.length === 0 || hits[0].score < threshold) return { hits, type: 'no_hit' };
  return { hits, type: 'hit' };
}
