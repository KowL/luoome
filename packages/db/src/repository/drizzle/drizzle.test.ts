import { gzipSync } from 'node:zlib';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDrizzleRepos } from '../../client.js';
import { registerRepositoryContractTests } from '../contract-tests.js';
import type { DrizzleAdviceRepository } from './index.js';

/** Drizzle 实现（bun:sqlite :memory:）跑完整契约套件。 */
registerRepositoryContractTests('drizzle', () => {
  const handle = createDrizzleRepos(':memory:');
  return {
    repos: handle.repos,
    readOutcome: (adviceId: string) =>
      (handle.repos.advice as DrizzleAdviceRepository).getOutcome(adviceId),
    close: handle.close,
  };
});

describe('drizzle AdviceRepository 读兼容', () => {
  it('存量 basedOn JSON 含已下线的 tacticSignals key 时读出不 crash 且忽略该字段', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const basedOn = JSON.stringify({
        tacticSignals: [
          {
            tacticId: 'breakout-volume',
            tacticName: '放量突破',
            tacticTag: 'momentum',
            stockId: '600519.SH',
            ts: '2026-07-01T00:00:00.000Z',
            score: 80,
            direction: 'bullish',
            evidence: ['放量突破'],
          },
        ],
        dataAsOf: '2026-07-01T00:00:00.000Z',
      });
      handle.db.run(sql`
        INSERT INTO advices (
          id, subject_kind, subject_id, stock_name, decision, confidence, horizon,
          reasoning, risks, disclaimers, source_tool, source_workflow, based_on,
          valid_from, valid_until, created_at
        ) VALUES (
          'adv-legacy', 'stock', '600519.SH', NULL, 'buy', 80, 'short',
          '{"premise":"p","evidence":[],"counterEvidence":[]}', '[]', '["d"]',
          NULL, NULL, ${basedOn}, 1782748800000, 1782752400000, 1782748800000
        )
      `);
      const got = await handle.repos.advice.findById('adv-legacy');
      expect(got).not.toBeNull();
      expect(got?.basedOn.dataAsOf).toBeInstanceOf(Date);
      expect('tacticSignals' in (got?.basedOn ?? {})).toBe(false);
    } finally {
      handle.close();
    }
  });
});

describe('drizzle StrategyResult 读兼容', () => {
  it('逐股明细存于 strategy_runs.results_json，数组无 breakdown 时仍可读取', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const ruleEvaluations = [
        { ruleId: 'rule-1', status: 'matched', value: true, evidence: ['legacy'] },
      ];
      handle.db.run(sql`
        INSERT INTO strategy_runs (
          id, strategy_id, strategy_version_id, mode, coverage, data_as_of, started_at,
          finished_at, status, scope, input_snapshot_json, provider_statuses_json,
          results_json
        ) VALUES (
          'legacy-result-run', 'legacy-strategy', 'legacy-v1', 'scan', 'CN_A_SHARES_SH_SZ',
          1782748800000, 1782748800000, 1782748800000, 'complete', 'operational',
          '{"schemaVersion":2,"strategyVersionId":"legacy-v1","definitionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evaluatorVersion":"test","coverage":"CN_A_SHARES_SH_SZ","stockIds":["600519.SH"],"stockIdChecksum":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requestedBy":"manual"}',
          '[]',
          ${JSON.stringify([
            {
              runId: 'legacy-result-run',
              stockId: '600519.SH',
              selected: true,
              score: 50,
              rank: 1,
              ruleEvaluations,
              evidence: ['legacy'],
              dataAsOf: new Date(1782748800000).toISOString(),
            },
          ])}
        )
      `);

      const results = await handle.repos.strategyRun.listResults('legacy-result-run');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        runId: 'legacy-result-run',
        stockId: '600519.SH',
        score: 50,
        ruleEvaluations,
      });
      expect(results[0]).not.toHaveProperty('scoringBreakdown');
      expect(
        handle.db.get(
          sql`SELECT name FROM sqlite_master WHERE type='table' AND name='strategy_results'`,
        ),
      ).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  it('压缩存储的逐股明细可解压还原，且不再以明文 JSON 落盘', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const stored = [
        {
          runId: 'compressed-run',
          stockId: '600519.SH',
          selected: true,
          score: 61,
          rank: 1,
          ruleEvaluations: [{ ruleId: 'rule-1', status: 'matched', value: true, evidence: ['x'] }],
          evidence: ['compressed'],
          dataAsOf: new Date(1782748800000).toISOString(),
        },
      ];
      const compressed = `zlib+base64:${gzipSync(JSON.stringify(stored)).toString('base64')}`;
      handle.db.run(sql`
        INSERT INTO strategy_runs (
          id, strategy_id, strategy_version_id, mode, coverage, data_as_of, started_at,
          finished_at, status, scope, input_snapshot_json, provider_statuses_json,
          results_json
        ) VALUES (
          'compressed-run', 'compressed-strategy', 'compressed-v1', 'scan', 'CN_A_SHARES_SH_SZ',
          1782748800000, 1782748800000, 1782748800000, 'complete', 'operational',
          '{"schemaVersion":2,"strategyVersionId":"compressed-v1","definitionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evaluatorVersion":"test","coverage":"CN_A_SHARES_SH_SZ","stockIds":["600519.SH"],"stockIdChecksum":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requestedBy":"manual"}',
          '[]',
          ${compressed}
        )
      `);

      const results = await handle.repos.strategyRun.listResults('compressed-run');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        stockId: '600519.SH',
        score: 61,
        evidence: ['compressed'],
      });

      const raw = handle.db.all<{ results_json: string }>(
        sql`SELECT results_json FROM strategy_runs WHERE id='compressed-run'`,
      );
      expect(raw[0]?.results_json.startsWith('zlib+base64:')).toBe(true);
    } finally {
      handle.close();
    }
  });
});
