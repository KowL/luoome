// 文案字典守卫（REQ-M1-05 §3）：用户可见的旧名不得回流。
//
// 被摘除的两个名字，各自对应一次「名实不符」：
// - 「严格」+「回测」—— 对外入口在门禁恒 partial 时永远拿不到 metrics，这个名字承诺了
//   跑得出组合绩效的能力。定名改为「组合回测（门禁审计）」；执行入口已降为内部工具。
// - 「模拟」+「回测」—— 实际是逐日选股重放（无组合收益、无成本），定名改为「历史评估（逐日重放）」。
//
// 两个旧名在下面的表里用码点写出：本文件必须能判定它们，但自己不该命中判定（否则守卫
// 一落地就红）。读代码时按右侧的现行说法理解即可。
//
// 这是**运行时文案**的守卫：扫源码、技能正文与面板脚本，不扫测试文件（负例断言本身就要
// 写出被禁的字面量）也不扫文档（`docs/` 的历史记录与设计稿在 PRD 白名单里）。
//
// 与 `surface-consistency.test.ts` 的关系：那条守「谁可达」，这条守「叫什么」。两者都不
// 写死数量，只断言集合关系 —— 新增一处旧名即红。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');

/** 运行时文案可能出现的根：领域工具描述、插件宿主与面板、随包技能、遗留 Web 面与验收脚本。 */
const SCAN_ROOTS = [
  'packages/tools/src',
  'packages/dsh-luoome/src',
  'packages/dsh-luoome/skills',
  'apps/web/src',
  'apps/web/public/js',
  'infra/dsh',
] as const;

const SCAN_SUFFIXES = ['.ts', '.js', '.md'] as const;

/** 被摘除的名字 → 现行说法。新增旧名请先想清楚「它现在叫什么」。 */
const BANNED_COPY: ReadonlyMap<string, string> = new Map([
  ['\u4e25\u683c\u56de\u6d4b', '组合回测（门禁审计）'],
  ['\u4e25\u683c\u7ec4\u5408\u56de\u6d4b', '组合回测（门禁审计）'],
  ['\u6a21\u62df\u56de\u6d4b', '历史评估（逐日重放）'],
]);

const isTestFile = (path: string): boolean =>
  /\.(test|spec)\.[cm]?[jt]s$/.test(path) || path.includes('/testing/');

const collectFiles = (): readonly string[] => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        walk(path);
      } else if (SCAN_SUFFIXES.some((suffix) => path.endsWith(suffix)) && !isTestFile(path)) {
        files.push(path);
      }
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO, root));
  return files;
};

const hits = (): readonly string[] => {
  const found: string[] = [];
  for (const file of collectFiles()) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (const [banned, replacement] of BANNED_COPY)
      for (const [index, line] of lines.entries())
        if (line.includes(banned))
          found.push(`${relative(REPO, file)}:${index + 1}: 「${banned}」→ 应为「${replacement}」`);
  }
  return found;
};

describe('文案字典 · 名实不符整改后的旧名不得回流', () => {
  it('扫到的运行时文案文件非空（扫描根写错时要报错，而不是静默通过）', () => {
    expect(collectFiles().length).toBeGreaterThan(100);
  });

  it('运行时文案与技能正文里没有被摘除的两个旧名', () => {
    expect(hits()).toEqual([]);
  });
});
