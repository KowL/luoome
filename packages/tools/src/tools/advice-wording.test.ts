import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P2-10 全链路文案回归（design §12.2）。
 *
 * 扫描研究 / 观察链路的用户可见文案与 tool description，禁止操作动词；
 * 真实交易登记、持仓校准与交易计划动作属于用户实际账本，不在本规则范围内。
 */

const ROOT = process.cwd();
const BANNED = /建议买入|建议卖出|建仓|加仓|减仓|清仓|满仓/;
const RESEARCH_DISCLAIMER = '仅技术研究，不构成投资建议';

const SCAN_PATHS = [
  'packages/plugins/analysis/src',
  'packages/toolkit/src/tools',
  'packages/tools/src/agent/scenarios.ts',
  'packages/cli/src',
  'packages/workflows/src/daily-advice.ts',
  'packages/workflows/src/daily-stock-briefs.ts',
  'packages/workflows/src/weekly-report.ts',
  'packages/core/src/entity/advice.ts',
  'apps/web/public/js',
  'apps/web/src/routes',
  'apps/web/public/index.html',
] as const;

/** 真实交易登记 / 持仓校准 / 交易计划：保留「建仓/加仓」等业务动作词。 */
const TRADE_SURFACE_FILES = new Set([
  'packages/toolkit/src/tools/add-trade.ts',
  'packages/toolkit/src/tools/add-holding.ts',
  'packages/toolkit/src/tools/update-holding.ts',
  'packages/toolkit/src/tools/close-holding.ts',
  'packages/tools/src/agent/draft-display.ts',
  'apps/web/public/js/holdings-actions.js',
  'apps/web/public/js/trading-plan-panel.js',
]);

/** pages.js 同时承载建议展示与真实持仓动作按钮，只放行后者所在行。 */
const TRADE_SURFACE_LINES: Readonly<Record<string, RegExp>> = {
  'apps/web/public/js/pages.js': /actionBtn\('(加仓|减仓)'/,
};

const ENTRY_FILES = [
  'packages/core/src/entity/advice.ts',
  'packages/toolkit/src/tools/get-stock-brief.ts',
  'packages/toolkit/src/tools/list-stock-briefs.ts',
  'packages/toolkit/src/tools/get-stock-facts.ts',
  'packages/toolkit/src/tools/stock-brief-view.ts',
  'packages/plugins/analysis/src/internal/prompts.ts',
  'packages/plugins/analysis/src/tools/analyze-stock.ts',
  'packages/plugins/analysis/src/tools/analyze-position.ts',
  'packages/plugins/analysis/src/tools/analyze-strategy-candidate.ts',
  'packages/plugins/analysis/src/tools/generate-stock-briefs.ts',
  'packages/plugins/analysis/src/tools/market-outlook.ts',
  'packages/tools/src/agent/scenarios.ts',
  'packages/cli/src/index.ts',
  'packages/workflows/src/daily-advice.ts',
  'packages/workflows/src/daily-stock-briefs.ts',
  'packages/workflows/src/weekly-report.ts',
  'apps/web/public/js/stock-brief.js',
  'apps/web/public/js/market-room.js',
  'apps/web/public/index.html',
] as const;

const isSourceFile = (path: string): boolean => /\.(ts|js|html)$/.test(path);
const isTestFile = (path: string): boolean => /\.(test|spec)\.(ts|js)$/.test(path);

const filesUnder = (path: string): string[] => {
  const absolute = join(ROOT, path);
  if (statSync(absolute).isFile()) return [path];
  return readdirSync(absolute).flatMap((name) => {
    const child = join(path, name);
    if (name === 'node_modules' || name === 'dist') return [];
    return statSync(join(ROOT, child)).isDirectory() ? filesUnder(child) : [child];
  });
};

const scannableFiles = (): string[] =>
  SCAN_PATHS.flatMap(filesUnder).filter(
    (path) => isSourceFile(path) && !isTestFile(path) && !TRADE_SURFACE_FILES.has(path),
  );

const bannedLines = (path: string): string[] => {
  const allowLine = TRADE_SURFACE_LINES[path];
  return readFileSync(join(ROOT, path), 'utf8')
    .split('\n')
    .filter((line) => BANNED.test(line) && allowLine?.test(line) !== true);
};

describe('P2-10 全链路文案回归', () => {
  it('研究 / 观察链路与 tool description 不出现操作动词', () => {
    const violations = scannableFiles().flatMap((path) =>
      bannedLines(path).map((line) => `${relative(ROOT, path)}: ${line.trim()}`),
    );
    expect(violations).toEqual([]);
  });

  it('所有研究 / 观察入口都带「仅技术研究，不构成投资建议」', () => {
    const missing = ENTRY_FILES.filter(
      (path) => !readFileSync(join(ROOT, path), 'utf8').includes(RESEARCH_DISCLAIMER),
    );
    expect(missing).toEqual([]);
  });
});
