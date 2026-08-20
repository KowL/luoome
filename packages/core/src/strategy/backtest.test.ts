import { describe, expect, it } from 'vitest';

import {
  CURRENT_STRATEGY_EVALUATOR_IDENTITY,
  runStrictBacktest,
  type StrictBacktestMarketFact,
  StrictBacktestRunSchema,
  type StrictBacktestSpec,
  strictBacktestHash,
  strictBacktestSpecHash,
} from '../index.js';

const D1 = new Date('2026-08-13T00:00:00.000Z');
const D2 = new Date('2026-08-14T00:00:00.000Z');

const spec: StrictBacktestSpec = {
  schemaVersion: 1,
  strategyId: 'strict-fixture',
  strategyVersionId: 'strict-fixture-v1',
  evaluationSessionId: 'evaluation-fixture',
  from: D1,
  to: D2,
  initialCash: 100_000,
  benchmark: { stockId: '000300.SH', datasetVersion: '000300.SH:qfq:daily:v1' },
  execution: {
    model: 'next-open-full-rebalance-equal-weight-v1',
    lotSize: 100,
    maxPositions: 20,
  },
  fees: {
    model: 'ashare-fees-v1',
    commissionBps: 2.5,
    minimumCommission: 5,
    sellStampDutyBps: 5,
  },
  slippage: { model: 'fixed-bps-at-open-v1', buyBps: 10, sellBps: 10 },
};

const fact = (
  stockId: string,
  date: Date,
  open: number,
  close: number,
  overrides: Partial<StrictBacktestMarketFact> = {},
): StrictBacktestMarketFact => ({
  stockId,
  date,
  rawOpen: open,
  rawHigh: Math.max(open, close) + 1,
  rawLow: Math.min(open, close) - 1,
  rawClose: close,
  sessionStatus: 'open',
  buyAllowed: true,
  sellAllowed: true,
  buyRestriction: 'none',
  sellRestriction: 'none',
  corporateActionsStatus: 'complete',
  corporateActions: [],
  source: 'fixture',
  recordedAt: date,
  contentHash: strictBacktestHash({ stockId, date, open, close, ...overrides }),
  ...overrides,
});

describe('strict backtest core', () => {
  it('按 D+1 开盘、整手、费用和滑点确定性计算，不输出 Sharpe/胜率', () => {
    const result = runStrictBacktest({
      spec,
      targets: [
        { date: D1, stockIds: ['600519.SH'] },
        { date: D2, stockIds: [] },
      ],
      marketFacts: [fact('600519.SH', D1, 100, 110), fact('600519.SH', D2, 112, 111)],
      benchmarkFacts: [fact('000300.SH', D1, 4000, 4020), fact('000300.SH', D2, 4030, 4040)],
    });

    expect(result.tradeCount).toBe(2);
    expect(result.trades[0]).toMatchObject({ side: 'buy', quantity: 900 });
    expect(result.trades[1]).toMatchObject({ side: 'sell', quantity: 900 });
    expect(result.netReturnPct).toBeGreaterThan(9);
    expect(result.turnoverPct).toBeGreaterThan(180);
    expect(result).not.toHaveProperty('sharpe');
    expect(result).not.toHaveProperty('winRate');
  });

  it('卖出受限时保留仓位并按真实收盘估值', () => {
    const result = runStrictBacktest({
      spec,
      targets: [
        { date: D1, stockIds: ['600519.SH'] },
        { date: D2, stockIds: [] },
      ],
      marketFacts: [
        fact('600519.SH', D1, 100, 110),
        fact('600519.SH', D2, 90, 85, {
          sellAllowed: false,
          sellRestriction: 'limit-down',
        }),
      ],
      benchmarkFacts: [fact('000300.SH', D1, 4000, 4020), fact('000300.SH', D2, 4030, 4040)],
    });

    expect(result.tradeCount).toBe(1);
    expect(result.equityCurve[1]?.equity).toBeLessThan(result.equityCurve[0]?.equity ?? 0);
  });

  it('运行 schema 只允许全部门禁 complete 后携带 metrics', () => {
    const items = [
      'pit-universe',
      'daily-bar-revisions',
      'fees',
      'slippage',
      'tradability',
      'corporate-actions',
      'benchmark',
      'evaluator-code',
    ].map((key) => ({
      key,
      status: key === 'fees' ? 'complete' : 'unavailable',
      reason: 'fixture',
      evidenceRefs: [],
    }));
    expect(
      StrictBacktestRunSchema.safeParse({
        id: 'strict-backtest-unavailable',
        status: 'complete',
        resultAvailability: 'partial',
        spec,
        specHash: strictBacktestSpecHash(spec),
        inputFingerprint: strictBacktestHash('input'),
        evaluator: CURRENT_STRATEGY_EVALUATOR_IDENTITY,
        gateAudit: { status: 'partial', items, assessedAt: D2 },
        createdAt: D1,
        finishedAt: D2,
      }).success,
    ).toBe(true);
  });
});
