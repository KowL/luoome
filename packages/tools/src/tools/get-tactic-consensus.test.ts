import { BUILTIN_TACTICS, type StockGroup, type TacticSignal } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getTacticConsensusTool } from './get-tactic-consensus.js';

const NOW = new Date('2026-07-29T08:00:00.000Z');
const PREVIOUS = new Date('2026-07-28T08:00:00.000Z');
const STOCK_ID = '002594.SZ';

describe('tool/get_tactic_consensus', () => {
  it('只聚合同日非 stale 的公式分组，保留反向信号并按确定公式排序', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const tacticById = new Map(BUILTIN_TACTICS.map((tactic) => [tactic.id, tactic]));
    const seed = async (
      groupId: string,
      tacticId: string,
      score: number,
      dataAsOf = NOW,
      createdAt = NOW,
      includeResearchFields = true,
    ) => {
      const tactic = tacticById.get(tacticId);
      if (tactic === undefined) throw new Error(`missing fixture tactic ${tacticId}`);
      const group: StockGroup = {
        id: groupId,
        name: groupId,
        resolver: { kind: 'formula', tacticId, lookbackDays: 30 },
        refreshPolicy: 'daily',
        enabled: true,
        createdAt: PREVIOUS,
        updatedAt: PREVIOUS,
      };
      await ctx.repos.stockGroup.save(group);
      const signal: TacticSignal = {
        tacticId,
        tacticName: tactic.name,
        tacticTag: tactic.tag,
        stockId: STOCK_ID,
        ts: dataAsOf,
        score,
        direction: tactic.direction,
        evidence: [`${groupId} evidence`],
      };
      await ctx.repos.tactic.saveSignal(signal);
      await ctx.repos.groupMember.saveBatch([
        {
          id: `snapshot-${groupId}`,
          groupId,
          stockId: STOCK_ID,
          refreshId: `refresh-${groupId}`,
          reason: `${groupId} hit`,
          evidence: includeResearchFields ? [...signal.evidence] : [],
          ...(includeResearchFields
            ? {
                score,
                dataAsOf,
                tacticSignalRef: { tacticId, ts: dataAsOf },
              }
            : {}),
          createdAt,
        },
      ]);
    };

    await seed('trend-breakout', 'breakout-volume', 80);
    await seed('trend-ma', 'ma-bullish-alignment', 70);
    await seed('risk-divergence', 'volume-price-divergence', 60);
    await seed('stale-group', 'sector-resonance', 65, NOW, PREVIOUS);
    await seed('different-day', 'sector-resonance', 65, PREVIOUS);
    await seed('unknown-fields', 'sector-resonance', 65, NOW, NOW, false);

    const result = await getTacticConsensusTool.execute({ minGroups: 2, topN: 20 }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.marketDate).toBe('2026-07-29');
    expect(result.data.groups.map((group) => group.groupId).sort()).toEqual([
      'risk-divergence',
      'trend-breakout',
      'trend-ma',
    ]);
    expect(result.data.matches).toHaveLength(1);
    expect(result.data.matches[0]).toMatchObject({
      stockId: STOCK_ID,
      rankScore: 50,
      groupIds: ['risk-divergence', 'trend-breakout', 'trend-ma'],
    });
    expect(result.data.matches[0]?.supportingSignals).toHaveLength(2);
    expect(result.data.matches[0]?.opposingSignals).toHaveLength(1);
    expect(result.data.excludedGroups).toEqual(
      expect.arrayContaining([
        { groupId: 'stale-group', reason: 'stale' },
        { groupId: 'different-day', reason: 'different-market-date' },
        { groupId: 'unknown-fields', reason: 'unknown-coverage' },
      ]),
    );
  });
});
