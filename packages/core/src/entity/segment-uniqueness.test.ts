import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ADVICE_CARD_SEGMENTS, ADVICE_SEGMENTS, segmentLabel } from './advice-card.js';
import { REPORT_ENVELOPE_SECTION_KEYS, REPORT_ENVELOPE_SLOTS } from './report-document.js';

/**
 * U2/U3 的**静态守卫**：段名/段键在全仓只有一份定义。
 *
 * 背景：`ENVELOPE_SECTION_KEYS` 曾有三份逐字相同的副本（core、workflows/internal、
 * workflows/morning-brief）。副本分叉时**不会报错**，只会让 `reportDocumentFromReport`
 * 在另一处抛「缺少 envelope 槽」，报错里指向一个没人写过的键——极难定位。
 * 所以用源码扫描把「第四次复制」变成红测试。
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.turbo']);

const sourceFiles = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|js|mjs)$/.test(entry) && !/\.test\.(ts|js)$/.test(entry)) out.push(full);
  }
  return out;
};

const LITERAL_KEY = /'envelope-(?:conclusion|counter-evidence|risks|validity|disclaimer)'/g;

describe('U2 段名只有一份定义（静态守卫）', () => {
  it('仓里只有 core 一处出现 envelope 段键的字面量（副本不许再出现）', () => {
    const files = sourceFiles(resolve(REPO_ROOT, 'packages'));
    const hits = files
      .map((file) => ({
        file: file.slice(REPO_ROOT.length + 1),
        count: (readFileSync(file, 'utf8').match(LITERAL_KEY) ?? []).length,
      }))
      .filter((item) => item.count > 0);

    // 只允许 core 的 report-document.ts 持有这 5 个字面量。
    expect(hits.map((item) => item.file)).toEqual(['packages/core/src/entity/report-document.ts']);
    expect(hits[0]?.count).toBe(5);
  });

  it('三个消费点都拿到同一份段键（引用相等，不是内容相等）', async () => {
    const envelope = await import('../../../workflows/src/internal/report-envelope.js');
    const brief = readFileSync(
      resolve(REPO_ROOT, 'packages/workflows/src/morning-brief.ts'),
      'utf8',
    );
    expect(envelope.ENVELOPE_SECTION_KEYS).toBe(REPORT_ENVELOPE_SECTION_KEYS);
    // morning-brief 也必须引用 core，而不是自带一份字面量。
    expect(brief).toContain('REPORT_ENVELOPE_SECTION_KEYS');
    expect(brief).not.toMatch(LITERAL_KEY);
  });

  it('五段/六槽/标签表三者的集合关系固定', () => {
    // 六槽 = 五段 + dataAsOf。
    expect(REPORT_ENVELOPE_SLOTS).toEqual([...ADVICE_SEGMENTS, 'dataAsOf']);
    // 兼容别名与主名是同一个引用。
    expect(ADVICE_CARD_SEGMENTS).toBe(ADVICE_SEGMENTS);
    // 段键映射覆盖全部五段（少一个就取不到段、渲染整份失败）。
    for (const segment of ADVICE_SEGMENTS)
      expect(Object.keys(REPORT_ENVELOPE_SECTION_KEYS)).toContain(segment);
    // 每一段都有中文标签（兜底文案靠它生成）。
    for (const segment of ADVICE_SEGMENTS) expect(segmentLabel(segment).length).toBeGreaterThan(0);
  });
});
