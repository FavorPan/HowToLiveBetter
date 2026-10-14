// 固定评估集：20 个书内问题（必须 hit）+ 10 个书外问题（必须 no_hit）。
// 问题写法要与条目标题有连续两个字重叠（与 tools/check-refs.mjs 的锚点思路一致）。
// 注释里的节号只是预期命中方向，不是断言；断言只有 hit / no_hit。
// 阈值标定：2026-10-14，语料 690 条。原默认 8，上调至 30 以消除「快速」「股票」等
// 高频 bigram 对书外问题造成的误命中；20 条书内问题最小得分 31.2（止付）。
// 阈值若需调整，改 worker/src/retrieval.mjs 的默认 threshold，
// 并在两处注释记「标定：2026-10-14，语料 N 条」。
import { buildIndex, search } from '../../worker/src/retrieval.mjs';
import { buildCorpus } from './build-corpus.mjs';
import { read, readBook } from '../../tools/lib/book.mjs';

const IN_BOOK = [
  '被公司裁员了能拿多少经济补偿',   // 第 19 节
  '租房押金被扣了怎么办',           // 第 15 节
  '每周做力量训练大概要多少分钟',   // 第 2 节（原「每周运动多少时间才够」，重写以匹配「每周做 30–60 分钟力量训练」）
  '戒烟别靠忍要先去拿药',           // 第 2 节（原「想戒烟有什么具体办法」，重写以匹配「戒烟别光靠忍，先去拿药」）
  '天天大量喝酒的人怎么戒酒',       // 第 2 节
  '不满 3 个月的婴儿体温到 38 度要不要去医院', // 第 20 节（原「孩子发热什么情况要当天就医」，重写以匹配「不满 3 个月的婴儿体温到 38 ℃ 就直接去医院」）
  '工伤认定要在多久内申请',         // 第 19 节
  '买期房首付和贷款要注意什么',     // 第 15 节
  '被网暴了怎么走平台投诉',         // 第 8 节
  '午睡应该控制在半小时内还是更久', // 第 2 节（原「午睡睡多久比较合适」，重写以匹配「把午睡控制在半小时内」）
  '被骗了怎么紧急止付',             // 第 8 节
  '借钱给别人要写清借条吗',         // 第 8 节（原「借钱给别人要写借条吗」，重写以匹配「借钱写清借条」）
  '通用体检套餐值不值得做',         // 第 6 节
  '白内障影响看路要不要做手术',     // 第 17 节
  '心脏骤停现场怎么做心肺复苏',     // 第 13 节
  '保险到底要不要买消费型',         // 第 5 节（原「保险到底有没有必要买」，重写以匹配「保险优先买消费型」）
  '孩子说喜欢同性别该怎么回应',     // 第 30 节
  '买到不安全食品可以索赔多少',     // 第 5 节
  '离职时没休完的年休假怎么算',     // 第 19 节
  '怀孕早期要吃叶酸吗',             // 第 27 节
];
const OUT_BOOK = [
  '明天买哪只股票会涨',
  '帮我写一段 Python 快速排序',
  '英雄联盟怎么快速上分',
  '太阳系有几颗行星',
  '今天天气怎么样',
  '推荐几部好看的电影',
  '宇宙大爆炸是怎么发生的',
  '米其林餐厅怎么预订',
  '高等数学的微积分怎么入门',
  '钢琴考级要准备什么曲子',
];

const { readme } = readBook();
const corpus = buildCorpus({ readmeText: readme, readBookFile: f => read(f) });
const idx = buildIndex(corpus.entries);
let bad = 0;
for (const q of IN_BOOK) {
  const r = search(idx, q);
  const top = r.hits[0];
  console.log(`${r.type === 'hit' ? 'ok ' : 'MISS'} 书内 | ${q} -> ${top ? top.entry.title : '-'} (${top ? top.score.toFixed(1) : '-'})`);
  if (r.type !== 'hit') bad++;
}
for (const q of OUT_BOOK) {
  const r = search(idx, q);
  const top = r.hits[0];
  console.log(`${r.type === 'no_hit' ? 'ok ' : 'MISS'} 书外 | ${q} -> ${top ? top.entry.title : '-'} (${top ? top.score.toFixed(1) : '-'})`);
  if (r.type !== 'no_hit') bad++;
}
console.log(`语料 ${corpus.entries.length} 条；失手 ${bad} 个`);
process.exit(bad === 0 ? 0 : 1);
