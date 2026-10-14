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

export function search(index, query, { topK = 6, threshold = 30 } = {}) {
  const q = bigrams(query);
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
  if (hits.length === 0 || hits[0].score < threshold) return { hits: [], type: 'no_hit' };
  return { hits, type: 'hit' };
}
