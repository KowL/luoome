import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workflow architecture boundary', () => {
  it('production workflows do not access repositories or adapters directly', () => {
    const root = resolve(import.meta.dirname);
    const files = readdirSync(root).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    for (const file of files) {
      const source = readFileSync(resolve(root, file), 'utf8');
      expect(source, file).not.toMatch(/ctx\.(repos|adapters)\b/);
    }
  });

  it('只保留 13 个注册 workflow；其余可复用管线用 defineOperation', () => {
    const root = resolve(import.meta.dirname);
    const files = readdirSync(root).filter(
      (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
    );
    const definitions: string[] = [];
    for (const file of files) {
      if (file === 'define-workflow.ts') continue;
      const source = readFileSync(resolve(root, file), 'utf8');
      for (const match of source.matchAll(/export const (\w+Workflow) = defineWorkflow</g)) {
        definitions.push(match[1] as string);
      }
    }
    expect(definitions.sort()).toEqual([
      'closingReportCutoffWorkflow',
      'dailyAdviceWorkflow',
      'intradayWatchWorkflow',
      'postMarketDataWorkflow',
      'replayStrategyRangeWorkflow',
      'reportWorkflow',
      'riskReportWorkflow',
      'snapshotAccountPerformanceWorkflow',
      'strategyWorkflow',
      'syncMarketWorkflow',
      'syncPortfolioWatchlistsWorkflow',
      'syncResearchVaultWorkflow',
      'syncSectorCatalogWorkflow',
    ]);
  });
});
