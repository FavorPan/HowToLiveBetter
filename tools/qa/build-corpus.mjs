// 语料构建：复用 tools/lib/book.mjs 的 read/readBook（README 结构、LF 归一）。
// 条目行解析与 selfcheck.html 的 parse() 同一套格式，补上「- 收益：」一行。
// 「- 来源：」及列表不进语料。输出 worker/src/corpus.json（gitignore，部署前由 CI 生成）。
import { read, readBook } from '../lib/book.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const stripMd = s => s
  .replace(/\*\*/g, '')
  .replace(/\\([*_])/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .trim();

const TAG_KEYS = { '钱': 'money', '时间': 'time', '毅力': 'will', '收益': 'level', '口径': 'lens' };

export function buildCorpus({ readmeText, readBookFile }) {
  // 只取 README 目录段（和 readBook 同口径），不扫「这本书想回答的问题」表里的链接。
  const dir = readmeText.match(/## 目录[\s\S]*?## 正文/);
  const contentsMd = dir ? dir[0].replace(/## 正文/, '') : '';
  const matched = [...(contentsMd || '').matchAll(/\]\((book\/[^)#]+\.md)\)/g)].map(m => m[1]);
  const bookFiles = [...new Set(matched)].sort();
  const entries = [];
  for (const f of bookFiles) {
    let sec = null, secName = '', e = null;
    for (const raw of readBookFile(f).split('\n')) {
      const line = raw.trimEnd();
      let m;
      if ((m = /^#{1,2} (\d+)\. (.+)$/.exec(line))) { sec = +m[1]; secName = m[2].trim(); e = null; continue; }
      if ((m = /^### (\d+)\. (.+)$/.exec(line)) && sec) {
        e = { sec, n: +m[1], title: stripMd(m[2]), cost: '', human: '', gain: '', note: '', grade: '', section: secName };
        entries.push(e);
        continue;
      }
      if (!e) continue;
      if ((m = /^\x3c!--\s*成本标签:\s*(.*?)\s*-->\s*$/.exec(line))) {
        for (const kv of m[1].split(/\s+/)) {
          const [k, v] = kv.split('=');
          const p = TAG_KEYS[k];
          if (p) e[p] = v;
        }
      }
      else if ((m = /^- 成本：(.*)$/.exec(line))) e.cost = stripMd(m[1]);
      else if ((m = /^- 说人话：(.*)$/.exec(line))) e.human = stripMd(m[1]);
      else if ((m = /^- 收益：(.*)$/.exec(line))) e.gain = stripMd(m[1]);
      else if ((m = /^- 证据等级：\s*([ABC])/.exec(line))) e.grade = m[1];
      else if ((m = /^- 备注：(.*)$/.exec(line))) e.note = stripMd(m[1]);
    }
  }
  for (const x of entries) x.id = `${x.sec}-${x.n}`;
  return { builtAt: new Date().toISOString(), entries };
}

function main() {
  const { readme } = readBook();
  const corpus = buildCorpus({ readmeText: readme, readBookFile: f => read(f) });
  const outPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../worker/src/corpus.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(corpus));
  console.log(`corpus.json：${corpus.entries.length} 条，写入 ${outPath}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
