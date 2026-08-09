import type { LimitUpLadderManagerLike } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { marketOutlookTool } from './market-outlook.js';

describe('tool/market_outlook', () => {
  it('生成大盘观点 advice 并落库', async () => {
    const ctx = await buildTestContext();
    const r = await marketOutlookTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.advice.subjectKind).toBe('market');
    expect(['buy', 'sell', 'hold', 'watch', 'avoid']).toContain(r.data.advice.decision);
    expect(r.data.advice.disclaimers.length).toBeGreaterThan(0);
    expect(typeof r.data.evaluatedStocks).toBe('number');
  });

  it('theme 指定 → subjectId 包含 theme', async () => {
    const ctx = await buildTestContext();
    const r = await marketOutlookTool.execute({ theme: '新能源' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.advice.subjectId).toBe('新能源');
  });

  it('把结构化天梯摘要带入观点和 Advice 快照', async () => {
    const ladder = {
      date: '2026-07-28',
      total: 2,
      maxLevel: 3,
      source: 'eastmoney' as const,
      levels: [
        {
          level: 3,
          name: '3 连板',
          count: 1,
          stocks: [],
        },
        { level: 1, name: '首板', count: 1, stocks: [] },
      ],
      warnings: [],
      asOf: new Date('2026-07-28T08:00:00Z'),
    };
    const manager: LimitUpLadderManagerLike = {
      name: 'limit-up-ladder',
      sources: ['eastmoney'],
      fetchLadder: async () => ({ ok: true, data: ladder }),
      compareLadder: async () => ({
        ok: true,
        data: {
          curr: ladder,
          prev: ladder,
          diff: {
            totalDelta: 0,
            maxLevelDelta: 0,
            topLevelAdded: [],
            topLevelRemoved: [],
            topLevelRetained: [],
          },
        },
      }),
    };
    const ctx = await buildTestContext({ limitUpLadder: manager });
    const result = await marketOutlookTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ladder).toMatchObject({ status: 'available', snapshot: { maxLevel: 3 } });
    expect(result.data.advice.basedOn.ladder).toMatchObject({ total: 2, maxLevel: 3 });
  });
});
