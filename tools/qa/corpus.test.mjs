import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCorpus } from './build-corpus.mjs';

const README = `# 高性价比人生指南
## 目录
1. [测试节](book/01-测试节.md)
## 正文
`;
const BOOK1 = `[← 回总目录](../README.md)

# 1. 测试节

节首引言，不算条目。

### 1. 别买小作坊散装油

<!-- 成本标签: 钱=0 时间=少 毅力=否 收益=大 口径=死亡率 -->
- **建议**：别买小作坊散装自榨花生油。
- 成本：不花钱，去正规超市买。
- 说人话：散装花生油黄曲霉毒素超标的风险高。买正规厂的瓶装油就行。
- 收益：把肝癌风险源头砍掉一大块。
- 证据等级：B
- 来源：
  - 某论文 doi:10.1000/fake
- 备注：黄曲霉毒素是肝癌确认致癌物。

### 2. 做饭开抽油烟机

<!-- 成本标签: 钱=少 时间=少 毅力=些 收益=中 口径=死亡率 -->
- **建议**：做饭开抽油烟机。
- 成本：电费，忽略不计。
- 说人话：炒菜的烟是明确的致癌物暴露，开着它就对了。
- 收益：肺癌风险下降。
- 证据等级：B
- 备注：争议：部分研究只看到烧煤人家。
`;

test('按 README 目录解析节和条目', () => {
  const c = buildCorpus({ readmeText: README, readBookFile: () => BOOK1 });
  assert.equal(c.entries.length, 2);
  const e1 = c.entries[0];
  assert.equal(e1.id, '1-1');
  assert.equal(e1.sec, 1);
  assert.equal(e1.n, 1);
  assert.equal(e1.title, '别买小作坊散装油');
  assert.equal(e1.section, '测试节');
  assert.equal(e1.grade, 'B');
  assert.equal(e1.human.includes('黄曲霉毒素'), true);
  assert.equal(e1.level, '大');
  assert.equal(e1.will, '否');
  assert.equal(c.entries[1].id, '1-2');
});

test('来源栏内容不进语料，备注正常保留', () => {
  const c = buildCorpus({ readmeText: README, readBookFile: () => BOOK1 });
  const j = JSON.stringify(c.entries);
  assert.equal(j.includes('doi'), false);
  assert.equal(c.entries[0].note.includes('黄曲霉毒素是'), true);
});
