import { describe, expect, it } from 'vitest';

import {
  CURRENT_STRATEGY_EVALUATOR_IDENTITY,
  runStrictBacktest,
  type StrictBacktestMarketFact,
  StrictBacktestRunSchema,
  type StrictBacktestSpec,
  strictBacktestHash,
  strictBacktestSpecHash,
  tradabilityLimitPct,
  tradabilityLimitPrices,
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

  it('卖出受限旧仓占用 maxPositions 槽位时不再买入新仓', () => {
    const cappedSpec: StrictBacktestSpec = {
      ...spec,
      execution: { ...spec.execution, maxPositions: 1 },
    };
    const result = runStrictBacktest({
      spec: cappedSpec,
      targets: [
        { date: D1, stockIds: ['600519.SH'] },
        { date: D2, stockIds: ['300001.SZ', '000001.SZ'] },
      ],
      marketFacts: [
        fact('600519.SH', D1, 100, 110),
        fact('600519.SH', D2, 90, 85, {
          sellAllowed: false,
          sellRestriction: 'limit-down',
        }),
        fact('300001.SZ', D2, 20, 21),
        fact('000001.SZ', D2, 30, 31),
      ],
      benchmarkFacts: [fact('000300.SH', D1, 4000, 4020), fact('000300.SH', D2, 4030, 4040)],
    });

    expect(result.trades.filter((trade) => trade.date.getTime() === D2.getTime())).toEqual([]);
    expect(result.tradeCount).toBe(1);
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

// ---------- T22 / REQ-M3-04：5 股 × 3 日手算对账（1e-6） ----------
//
// 手算口径（与引擎的模型定义一致，但数值全部手写，不用另一份代码复算）：
//   初始现金 100,000；5 只股票；整手 100；佣金 10bps（最低 5 元）；卖出印花税 10bps；
//   买入滑点 1%（×1.01）；卖出滑点 1%（×0.99）。
//   Day1 买入：预算 = 现金/剩余只数；数量 = floor(预算/执行价/100)×100；
//     现金 100,000 → 20,000/10.10 → 1,900 股（19,190 + 佣金 19.19）→ 现金 80,790.81
//     → 20,197.7025/10.10 → 1,900 → 61,581.62
//     → 20,527.2067/10.10 → 2,000 股（20,200 + 20.20）→ 41,361.42
//     → 20,680.71/10.10 → 2,000 → 21,141.22
//     → 21,141.22/10.10 → 2,000 → 现金 921.02
//     收盘 10.50：权益 = 921.02 + 1,900×10.5×2 + 2,000×10.5×3 = 103,821.02
//   Day2 卖出（开盘 11.00×0.99 = 10.89）：
//     1,900 股：20,691 − 佣金 20.691 − 印花 20.691 = 20,649.618 ×2
//     2,000 股：21,780 − 21.78 − 21.78 = 21,736.44 ×3 → 现金 107,429.576
//     买入（11.00×1.01 = 11.11）：21,485.9152/11.11 → 1,900（21,109+21.109）×4；
//     22,909.14/11.11 → 2,000（22,220+22.22）→ 现金 666.92
//     收盘 11.20：权益 = 666.92 + 1,900×11.2×4 + 2,000×11.2 = 108,186.92
//   Day3 卖出（12.00×0.99 = 11.88）：
//     1,900 股：22,572 − 22.572 − 22.572 = 22,526.856 ×4
//     2,000 股：23,760 − 23.76 − 23.76 = 23,712.48 → 现金 114,486.824
//     买入（12.00×1.01 = 12.12）：22,897.3648/12.12 → 1,800（21,816+21.816）；
//     23,162.252/12.12 → 1,900（23,028+23.028）×4 → 现金 444.896
//     收盘 11.50：权益 = 444.896 + 1,800×11.5 + 1,900×11.5×4 = 108,544.896
//   基准：首日 open 1,000 → 末日 close 1,010 ⇒ +1.0%
//   成交额：98,980（D1 买）+ 106,722（D2 卖）+ 106,656（D2 买）
//          + 114,048（D3 卖）+ 113,928（D3 买）= 540,334 ⇒ 换手 540.334%
//   回撤：权益单调上升 ⇒ 0%
describe('T22 5 股 × 3 日手算对账', () => {
  const D1 = new Date('2026-08-13T00:00:00.000Z');
  const D2 = new Date('2026-08-14T00:00:00.000Z');
  const D3 = new Date('2026-08-17T00:00:00.000Z');
  const stocks = ['600519.SH', '000001.SZ', '600036.SH', '000002.SZ', '601398.SH'];
  const spec: StrictBacktestSpec = {
    schemaVersion: 1,
    strategyId: 't22-hand-calc',
    strategyVersionId: 't22-hand-calc-v1',
    evaluationSessionId: 't22-hand-calc-session',
    from: D1,
    to: D3,
    initialCash: 100_000,
    benchmark: { stockId: '000300.SH', datasetVersion: '000300.SH:qfq:daily:v1' },
    execution: { model: 'next-open-full-rebalance-equal-weight-v1', lotSize: 100, maxPositions: 5 },
    fees: {
      model: 'ashare-fees-v1',
      commissionBps: 10,
      minimumCommission: 5,
      sellStampDutyBps: 10,
    },
    slippage: { model: 'fixed-bps-at-open-v1', buyBps: 100, sellBps: 100 },
  };
  const day = (date: Date, open: number, close: number): StrictBacktestMarketFact[] =>
    stocks.map((stockId) => fact(stockId, date, open, close));
  const marketFacts = [...day(D1, 10, 10.5), ...day(D2, 11, 11.2), ...day(D3, 12, 11.5)];
  const benchmarkFacts = [
    fact('000300.SH', D1, 1000, 1000),
    fact('000300.SH', D2, 1005, 1008),
    fact('000300.SH', D3, 1009, 1010),
  ];
  const targets = [D1, D2, D3].map((date) => ({ date, stockIds: stocks }));

  it('metrics 每项等于手算值（1e-6），含佣金/最低佣金/印花税/滑点分解', () => {
    const metrics = runStrictBacktest({ spec, targets, marketFacts, benchmarkFacts });
    expect(metrics.equityCurve.map((point) => point.equity)).toEqual([
      expect.closeTo(103_821.02, 1e-6),
      expect.closeTo(108_186.92, 1e-6),
      expect.closeTo(108_544.896, 1e-6),
    ]);
    expect(metrics.equityCurve.map((point) => point.cash)).toEqual([
      expect.closeTo(921.02, 1e-6),
      expect.closeTo(666.92, 1e-6),
      expect.closeTo(444.896, 1e-6),
    ]);
    expect(metrics.finalEquity).toBeCloseTo(108_544.896, 6);
    expect(metrics.netReturnPct).toBeCloseTo(8.544896, 6);
    expect(metrics.maxDrawdownPct).toBeCloseTo(0, 6);
    expect(metrics.benchmarkReturnPct).toBeCloseTo(1, 6);
    expect(metrics.excessReturnPct).toBeCloseTo(7.544896, 6);
    expect(metrics.turnoverPct).toBeCloseTo(540.334, 6);
    expect(metrics.tradeCount).toBe(25);

    // 四项费用分解（逐笔）：最低佣金 5 元从未触发（每笔佣金都 > 5）。
    const buys = metrics.trades.filter((trade) => trade.side === 'buy');
    const sells = metrics.trades.filter((trade) => trade.side === 'sell');
    expect(buys).toHaveLength(15);
    expect(sells).toHaveLength(10);
    // D1 第一笔：1,900 股 × 10.10 = 19,190；佣金 = 19,190 × 10bps = 19.19；买入无印花税。
    expect(buys[0]).toMatchObject({ quantity: 1_900, executionPrice: 10.1 });
    expect(buys[0]?.notional).toBeCloseTo(19_190, 6);
    expect(buys[0]?.fees).toBeCloseTo(19.19, 6);
    // D2 第一笔卖出：1,900 股 × 10.89 = 20,691；佣金 20.691 + 印花 20.691 = 41.382。
    expect(sells[0]).toMatchObject({ quantity: 1_900, executionPrice: 10.89 });
    expect(sells[0]?.notional).toBeCloseTo(20_691, 6);
    expect(sells[0]?.fees).toBeCloseTo(41.382, 6);
  });

  it('最低佣金路径：小额成交按 5 元计（单独一笔 1,000 元买入）', () => {
    const smallSpec: StrictBacktestSpec = {
      ...spec,
      initialCash: 1_000,
      execution: { ...spec.execution, maxPositions: 1 },
      fees: { ...spec.fees, commissionBps: 1, minimumCommission: 5 },
      slippage: { model: 'fixed-bps-at-open-v1', buyBps: 0, sellBps: 0 },
    };
    const metrics = runStrictBacktest({
      spec: smallSpec,
      targets: [{ date: D1, stockIds: ['600519.SH'] }],
      marketFacts: [fact('600519.SH', D1, 10, 10)],
      benchmarkFacts: [fact('000300.SH', D1, 1000, 1000)],
    });
    // 预算 1,000 → 10.00 → 100 股（1,000 + 佣金 5 = 1,005 > 1,000 → 退一手 → 0 股？）
    // 实际：qty=100 时 notional+fee=1,005 > 1,000，循环退到 0，因此没有成交。
    expect(metrics.tradeCount).toBe(0);
    // 改成 1,010 元本金：100 股 = 1,000 + 最低佣金 5 = 1,005 ≤ 1,010。
    const funded = runStrictBacktest({
      spec: { ...smallSpec, initialCash: 1_010 },
      targets: [{ date: D1, stockIds: ['600519.SH'] }],
      marketFacts: [fact('600519.SH', D1, 10, 10)],
      benchmarkFacts: [fact('000300.SH', D1, 1000, 1000)],
    });
    expect(funded.trades[0]?.fees).toBeCloseTo(5, 6);
  });
});

describe('T22 涨跌停幅度表 tradability-rule-v1', () => {
  it('按板块与 ST 状态取幅度；ST unknown 不猜', () => {
    expect(tradabilityLimitPct({ stockId: '600519.SH', stStatus: 'non-st' })).toBe(0.1);
    expect(tradabilityLimitPct({ stockId: '600519.SH', stStatus: 'st' })).toBe(0.05);
    expect(tradabilityLimitPct({ stockId: '600519.SH', stStatus: 'unknown' })).toBeNull();
    expect(tradabilityLimitPct({ stockId: '688981.SH', stStatus: 'unknown' })).toBe(0.2);
    expect(tradabilityLimitPct({ stockId: '300750.SZ', stStatus: 'non-st' })).toBe(0.2);
    expect(tradabilityLimitPct({ stockId: '830799.BJ', stStatus: 'non-st' })).toBe(0.3);
    expect(tradabilityLimitPct({ stockId: '900901.SH', stStatus: 'non-st' })).toBeNull();
  });

  it('涨跌停价 = 前收盘 × (1±幅度)，四舍五入到两位小数', () => {
    expect(tradabilityLimitPrices(10, 0.1)).toEqual({ up: 11, down: 9 });
    expect(tradabilityLimitPrices(10.05, 0.05)).toEqual({ up: 10.55, down: 9.55 });
    expect(tradabilityLimitPrices(3.33, 0.2)).toEqual({ up: 4, down: 2.66 });
  });
});
