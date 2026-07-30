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
