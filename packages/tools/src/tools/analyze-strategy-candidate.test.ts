import { type DailyBar, money, quantity } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import {
  fetchStrategyCandidateBars,
  groundStrategyAdviceReasoning,
  groundStrategyAdviceRisks,
  normalizeStrategyCandidateDecision,
  quoteFromLatestStrategyBar,
} from './analyze-strategy-candidate.js';

describe('analyze_strategy_candidate quote fallback', () => {
  it('uses the newest persisted daily bar with an explicit fallback source', () => {
    const fetchedAt = new Date('2026-08-27T00:30:00.000Z');
    const bars: DailyBar[] = [
      {
        stockId: '600519.SH',
        date: new Date('2026-08-25T00:00:00.000Z'),
        open: money(9),
        high: money(10),
        low: money(8),
        close: money(9.5),
        volume: quantity(100),
        adjustment: 'qfq',
        source: 'fixture',
      },
      {
        stockId: '600519.SH',
        date: new Date('2026-08-26T00:00:00.000Z'),
        open: money(10),
        high: money(12),
        low: money(9),
        close: money(11),
        volume: quantity(200),
        adjustment: 'qfq',
        source: 'fuyao',
      },
    ];

    expect(quoteFromLatestStrategyBar(bars, fetchedAt)).toEqual({
      stockId: '600519.SH',
      observedAt: bars[1]?.date,
      fetchedAt,
      timestampSource: 'upstream',
      ts: bars[1]?.date,
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 200,
      source: 'daily-bar-fallback:fuyao',
    });
  });

  it('does not preserve position-only decisions when the account has no holding', () => {
    expect(normalizeStrategyCandidateDecision('hold', false)).toBe('watch');
    expect(normalizeStrategyCandidateDecision('sell', false)).toBe('avoid');
    expect(normalizeStrategyCandidateDecision('hold', true)).toBe('hold');
    expect(normalizeStrategyCandidateDecision('buy', false)).toBe('buy');
  });

  it('keeps optional indicator enrichment from blocking advice when daily bars fail', async () => {
    const bars = await fetchStrategyCandidateBars(
      {
        fetchDailyBars: async () => {
          throw new Error('provider timeout');
        },
      },
      '600519.SH',
      new Date('2026-08-27T00:30:00.000Z'),
    );

    expect(bars).toEqual([]);
  });

  it('projects user-visible evidence from deterministic strategy facts', () => {
    const reasoning = groundStrategyAdviceReasoning(
      {
        premise: '趋势仍偏多',
        evidence: ['MA20=8.60（更正：7.807）'],
        counterEvidence: ['所有观察 pending，无法回测验证'],
      },
      {
        runId: 'run-1',
        stockId: '600519.SH',
        selected: true,
        score: 85,
        rank: 1,
        ruleEvaluations: [],
        evidence: ['收盘=8.55 > MA20=7.807'],
        dataAsOf: new Date('2026-08-26T00:00:00.000Z'),
      },
      [],
      [],
    );

    expect(reasoning).toEqual({
      premise: '趋势仍偏多',
      evidence: [
        'StrategyResult run-1:600519.SH: selected=true; score=85; rank=1',
        'StrategyResult evidence: 收盘=8.55 > MA20=7.807',
      ],
      counterEvidence: [],
    });
    expect(groundStrategyAdviceRisks(['不是回测', '价格可能回落'])).toEqual(['价格可能回落']);
  });
});
