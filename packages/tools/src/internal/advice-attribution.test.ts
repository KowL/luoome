import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type Advice,
  type AdviceOutcome,
  type Holding,
  money,
  type PortfolioContribution,
  PortfolioContributionSchema,
  quantity,
  type SignalObservation,
  STANDARD_DISCLAIMERS,
  type Trade,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import {
  ADVICE_ATTRIBUTION_METRIC_VERSION,
  ADVICE_ATTRIBUTION_SCHEMA_VERSION,
  AdviceAttributionRowSchema,
  type BuildAdviceAttributionInput,
  buildAdviceAttribution,
  ContributionSchema,
  GetAdviceAttributionOutput,
} from './advice-attribution.js';

const NOW = new Date('2026-10-31T06:00:00.000Z');
const DAY = 86_400_000;
const ACCOUNT = 'acct-1';

const advice = (overrides: Partial<Advice> & { id: string }): Advice =>
  ({
    subjectKind: 'stock',
    subjectId: '600519.SH',
    decision: 'buy',
    confidence: 60,
    horizon: 'short',
    reasoning: { premise: 'p', evidence: [], counterEvidence: ['反证'] },
    risks: ['风险'],
    disclaimers: [...STANDARD_DISCLAIMERS],
    basedOn: { dataAsOf: new Date('2026-10-01T00:00:00.000Z') },
    validFrom: new Date('2026-10-01T00:00:00.000Z'),
    validUntil: new Date('2026-11-30T00:00:00.000Z'),
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  }) as Advice;

const trade = (
  overrides: Partial<Trade> & Pick<Trade, 'id' | 'side' | 'quantity' | 'price' | 'executedAt'>,
): Trade =>
  ({
    accountId: ACCOUNT,
    stockId: '600519.SH',
    fee: money(0),
    createdAt: overrides.executedAt,
    ...overrides,
  }) as Trade;

const contribution = (input: {
  readonly stockId: string;
  readonly realized: number;
  readonly unrealized?: number;
  readonly dividends?: number;
}): PortfolioContribution =>
  PortfolioContributionSchema.parse({
    stockId: input.stockId,
    factIds: [`daily_bar:${input.stockId}:2026-10-30`],
    realizedPnl: input.realized,
    ...(input.unrealized === undefined ? {} : { unrealizedPnl: input.unrealized }),
    dividends: input.dividends ?? 0,
    contribution: input.realized + (input.unrealized ?? 0) + (input.dividends ?? 0),
    completeness: 'complete',
  });

const snapshotOf = (
  contributions: readonly PortfolioContribution[],
  unallocated = 0,
  cashCosts = 0,
) => {
  const sum = contributions.reduce((total, item) => total + item.contribution, 0);
  return {
    id: 'snap-1',
    from: new Date('2026-10-01T00:00:00.000Z'),
    to: NOW,
    inputFingerprint: 'fingerprint-1',
    calculatedAt: NOW,
    dataAsOf: NOW,
    totalPnl: money(sum + unallocated - cashCosts),
    contributions,
  };
};

const replayOf = (
  positions: Record<
    string,
    { quantity: number; averageCost: number; realizedPnl: number; dividends: number }
  >,
  facts: Record<string, string[]> = {},
) => ({
  positions: new Map(Object.entries(positions)),
  facts: new Map(Object.entries(facts)),
});

const build = (
  overrides: Partial<BuildAdviceAttributionInput> & {
    readonly advices: readonly Advice[];
  },
) =>
  buildAdviceAttribution({
    accountId: ACCOUNT,
    currency: 'CNY',
    asOf: NOW,
    window: { from: new Date('2026-10-01T00:00:00.000Z'), to: NOW },
    outcomes: new Map<string, AdviceOutcome>(),
    trades: [],
    reviewTradeIds: new Map<string, readonly string[]>(),
    observations: [],
    originFilter: 'user',
    ...overrides,
  });

const rowOf = (output: GetAdviceAttributionOutput, adviceId: string) => {
  const row = output.rows.find((item) => item.adviceId === adviceId);
  if (row === undefined) throw new Error(`row ${adviceId} missing`);
  return row;
};

// ---------------------------------------------------------------------------
// A. 单条贡献度（金额与占比）
// ---------------------------------------------------------------------------

describe('A 单条贡献度：金额与占比', () => {
  it('A1 一条建议关联买入+卖出 → traded，realized 与手算一致，占比可算', () => {
    const a = advice({ id: 'a1' });
    const buy = trade({
      id: 't-buy',
      side: 'buy',
      quantity: quantity(100),
      price: money(10),
      executedAt: new Date('2026-10-02T00:00:00.000Z'),
      adviceId: 'a1',
    });
    const sell = trade({
      id: 't-sell',
      side: 'sell',
      quantity: quantity(100),
      price: money(12),
      executedAt: new Date('2026-10-10T00:00:00.000Z'),
      adviceId: 'a1',
    });
    const output = build({
      advices: [a],
      trades: [buy, sell],
      // 重放到期末：均价 10，卖出后清零。
      replay: replayOf(
        { '600519.SH': { quantity: 0, averageCost: 0, realizedPnl: 200, dividends: 0 } },
        { '600519.SH': ['trade:t-buy', 'trade:t-sell'] },
      ),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 200 })]),
      priceOf: () => 12,
    });
    const row = rowOf(output, 'a1');
    expect(row.status).toBe('traded');
    if (row.status !== 'traded') return;
    // 累计已实现盈亏来自重放（期末均价清零后无法逐笔还原，所以逐笔值只是展示用）。
    if (row.contribution.status === 'unavailable') throw new Error('expected priced');
    expect(row.contribution.components.realized).toBeCloseTo(200, 6);
    expect(row.tradeLinks.map((link) => link.tradeId)).toEqual(['t-buy', 't-sell']);
    // 没有分红来源 → `partial`（值只在已归属子集成立），但 `value` 仍在。
    expect(row.contribution.status).toBe('partial');
    expect(row.contribution.value).toBeCloseTo(200, 6);
    if (row.contribution.status === 'partial')
      expect(row.contribution.coverageGap.dividendsUnattributable).toBe(true);
    expect(row.shareOfAccountContributionPct).toBeCloseTo(100, 6);
  });

  it('A2 两条建议各一只股票 → 份额之和 + 残差份额 = 100', () => {
    const a = advice({ id: 'a1', subjectId: '600519.SH' });
    const b = advice({ id: 'a2', subjectId: '000001.SZ' });
    const output = build({
      advices: [a, b],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(10),
          price: money(12),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          adviceId: 'a1',
        }),
        trade({
          id: 't2',
          side: 'sell',
          quantity: quantity(10),
          price: money(5),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          stockId: '000001.SZ',
          adviceId: 'a2',
        }),
        trade({
          id: 't3',
          side: 'sell',
          quantity: quantity(10),
          price: money(7),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          stockId: '600000.SH',
        }),
      ],
      replay: replayOf(
        {
          '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 20, dividends: 0 },
          '000001.SZ': { quantity: 0, averageCost: 5, realizedPnl: 0, dividends: 0 },
          '600000.SH': { quantity: 0, averageCost: 6, realizedPnl: 10, dividends: 0 },
        },
        { '600519.SH': ['trade:t1'], '000001.SZ': ['trade:t2'], '600000.SH': ['trade:t3'] },
      ),
      snapshot: snapshotOf([
        contribution({ stockId: '600519.SH', realized: 20 }),
        contribution({ stockId: '000001.SZ', realized: 0 }),
        contribution({ stockId: '600000.SH', realized: 10 }),
      ]),
      priceOf: () => 12,
    });
    const shares = output.rows
      .filter((row) => row.status === 'traded')
      .map((row) => (row.status === 'traded' ? (row.shareOfAccountContributionPct ?? 0) : 0));
    const total =
      shares.reduce((sum, value) => sum + value, 0) + (output.residual.residualSharePct ?? 0);
    expect(total).toBeCloseTo(100, 4);
  });

  it('A3 负例：账户整体亏损 → 占比分母不可用，所有行没有 shareOfAccountContributionPct 键', () => {
    const a = advice({ id: 'a1' });
    const output = build({
      advices: [a],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(10),
          price: money(9),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          adviceId: 'a1',
        }),
      ],
      replay: replayOf(
        { '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: -10, dividends: 0 } },
        { '600519.SH': ['trade:t1'] },
      ),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: -10 })]),
      priceOf: () => 9,
    });
    expect(output.denominator.status).toBe('unavailable');
    expect(output.denominator.reason).toBe('denominator-nonpositive');
    for (const row of output.rows)
      expect('shareOfAccountContributionPct' in row, `${row.adviceId} 不该有账户份额`).toBe(false);
    // 绝对份额仍然给（分母恒 ≥ 0）。
    const row = rowOf(output, 'a1');
    if (row.status !== 'traded') throw new Error('expected traded');
    // 绝对份额仍然给（分母恒 ≥ 0）。
    expect(row.shareOfAbsoluteContributionPct).toBeCloseTo(100, 6);
  });

  it('A4 观察块标 notActualPnl=true；restated 观察不进输出', () => {
    const a = advice({ id: 'a1' });
    const pit: SignalObservation = {
      id: 'a1:t1:obs',
      sourceKind: 'strategy-signal',
      sourceId: 'sig-1',
      stockId: '600519.SH',
      horizon: 't1',
      vintage: 'pit',
      status: 'complete',
      returnPct: 8.5,
      benchmarkReturnPct: 1.5,
      observedAt: new Date('2026-10-06T00:00:00.000Z'),
      createdAt: new Date('2026-10-06T00:00:00.000Z'),
    } as unknown as SignalObservation;
    const restated: SignalObservation = {
      ...pit,
      id: 'a1:t3:restated',
      horizon: 't3',
      vintage: 'restated',
      returnPct: 99,
    } as unknown as SignalObservation;
    const output = build({
      advices: [a],
      observations: [pit, restated],
      trades: [],
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 0, realizedPnl: 0, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 0 })]),
    });
    const row = rowOf(output, 'a1');
    expect(row.observations).toHaveLength(1);
    expect(row.observations[0]?.notActualPnl).toBe(true);
    expect(row.observations[0]?.returnPct).toBe(8.5);
    expect(JSON.stringify(output)).not.toContain('99');
  });
});

// ---------------------------------------------------------------------------
// B. 三态
// ---------------------------------------------------------------------------

describe('B 区分「已成交 / 无成交事实 / 未回填」三态', () => {
  const outcome = (overrides: Partial<AdviceOutcome>): AdviceOutcome =>
    ({
      adviceId: 'a',
      tradeIds: [],
      outcome: 'ignored',
      recordedAt: new Date('2026-10-20T00:00:00.000Z'),
      ...overrides,
    }) as AdviceOutcome;

  it('B1 三态各一条 fixture，status 恰好三值，reason 分别正确', () => {
    const tradedAdvice = advice({ id: 'traded' });
    const ignoredAdvice = advice({ id: 'ignored' });
    const freshAdvice = advice({ id: 'fresh' });
    const output = build({
      advices: [tradedAdvice, ignoredAdvice, freshAdvice],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(5),
          price: money(12),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          adviceId: 'traded',
        }),
      ],
      outcomes: new Map([
        ['ignored', outcome({ adviceId: 'ignored', outcome: 'ignored', origin: 'user' })],
      ]),
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 10, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 10 })]),
      priceOf: () => 12,
    });
    expect(new Set(output.rows.map((row) => row.status))).toEqual(
      new Set(['traded', 'not-traded', 'not-backfilled']),
    );
    const ignoredRow = rowOf(output, 'ignored');
    expect(ignoredRow.status === 'not-traded' && ignoredRow.reason).toBe('outcome-ignored');
    const freshRow = rowOf(output, 'fresh');
    expect(freshRow.status === 'not-backfilled' && freshRow.reason).toBe('no-outcome');
    expect(output.totals).toMatchObject({ traded: 1, notTraded: 1, notBackfilled: 1 });
  });

  it('B2 负例：「无成交事实」与「未回填」都不能靠 value 缺席区分，只能靠 status + reason', () => {
    const ignoredAdvice = advice({ id: 'ignored' });
    const freshAdvice = advice({ id: 'fresh' });
    const output = build({
      advices: [ignoredAdvice, freshAdvice],
      outcomes: new Map([
        ['ignored', outcome({ adviceId: 'ignored', outcome: 'ignored', origin: 'user' })],
      ]),
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 0, realizedPnl: 0, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 0 })]),
    });
    for (const row of output.rows) {
      expect('contribution' in row, `${row.adviceId} 不该有 contribution`).toBe(false);
      expect(JSON.stringify(row)).not.toContain('"contribution"');
    }
    const a = rowOf(output, 'ignored');
    const b = rowOf(output, 'fresh');
    expect(a.status).not.toBe(b.status);
    expect(a.status === 'not-traded' && a.reason).toBe('outcome-ignored');
    expect(b.status === 'not-backfilled' && b.reason).toBe('no-outcome');
    // 差异必须落在 status / reason 上，不是别的字段兼职。
    expect(a.status).toBe('not-traded');
    expect(b.status).toBe('not-backfilled');
  });

  it('B3 负例：过期且无成交 → advice-expired-no-trade；未过期且无回填 → no-outcome', () => {
    const expired = advice({
      id: 'expired',
      validUntil: new Date('2026-10-20T00:00:00.000Z'),
    });
    const fresh = advice({ id: 'fresh' });
    const output = build({
      advices: [expired, fresh],
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 0, realizedPnl: 0, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 0 })]),
    });
    const expiredRow = rowOf(output, 'expired');
    expect(expiredRow.status === 'not-traded' && expiredRow.reason).toBe('advice-expired-no-trade');
    const freshRow = rowOf(output, 'fresh');
    expect(freshRow.status === 'not-backfilled' && freshRow.reason).toBe('no-outcome');
  });

  it('B4 负例：origin=model 的回填在 user 口径下不算「已知」，切 all 后才生效', () => {
    const only = advice({ id: 'only' });
    const modelOutcome = outcome({ adviceId: 'only', outcome: 'ignored', origin: 'model' });
    const base = {
      advices: [only],
      outcomes: new Map([['only', modelOutcome]]),
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 0, realizedPnl: 0, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 0 })]),
    };
    const userScope = build({ ...base, originFilter: 'user' });
    expect(rowOf(userScope, 'only').status).toBe('not-backfilled');
    const allScope = build({ ...base, originFilter: 'all' });
    const row = rowOf(allScope, 'only');
    expect(row.status === 'not-traded' && row.reason).toBe('outcome-ignored');
  });

  it('B5（裁定 T1）followed + tradeIds 为空 → not-traded + outcome-followed-without-trade-link + 标签「无成交事实」', () => {
    const followed = advice({ id: 'followed' });
    const output = build({
      advices: [followed],
      outcomes: new Map([
        [
          'followed',
          outcome({ adviceId: 'followed', outcome: 'followed', origin: 'user', tradeIds: [] }),
        ],
      ]),
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 0, realizedPnl: 0, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 0 })]),
    });
    const row = rowOf(output, 'followed');
    expect(row.status).toBe('not-traded');
    if (row.status !== 'not-traded') return;
    expect(row.reason).toBe('outcome-followed-without-trade-link');
    expect(row.contradiction).toBe('followed-without-trade');
    // 中文标签不是「未成交」：不能篡改用户陈述。
    expect(row.label).toBe('无成交事实');
    expect(row.note).toContain('用户回填为兑现，但没有关联成交记录；本工具不据此推断实际盈亏');
    expect(row).not.toHaveProperty('contribution');
  });

  it('B6 形状守卫：三支全 .strict()——给不存在的分支塞 contribution 键必须报错', () => {
    const notTraded = {
      adviceId: 'x',
      subjectKind: 'stock',
      subjectId: '600519.SH',
      decision: 'buy',
      confidence: 60,
      createdAt: NOW,
      validUntil: NOW,
      factIds: [],
      status: 'not-traded',
      label: '无成交事实',
      reason: 'outcome-ignored',
      note: 'n',
      observations: [],
      // 不允许出现金额。
      contribution: { status: 'available' },
    };
    expect(AdviceAttributionRowSchema.safeParse(notTraded).success).toBe(false);
    expect(ContributionSchema).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// C. 无成交 / 未回填 → 没有 contribution 键
// ---------------------------------------------------------------------------

describe('C 无成交或未回填：没有 contribution 键（不是 null / 0）', () => {
  it('C1/C2 两支都没有 contribution 键', () => {
    const output = build({
      advices: [advice({ id: 'a1' }), advice({ id: 'a2' })],
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 0, realizedPnl: 0, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 0 })]),
    });
    for (const row of output.rows) expect(JSON.stringify(row)).not.toContain('"contribution"');
  });

  it('C3 负例：traded 但无快照 → contribution.unavailable + remedy，且没有 value 键', () => {
    const a = advice({ id: 'a1' });
    const output = build({
      advices: [a],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(5),
          price: money(12),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          adviceId: 'a1',
        }),
      ],
      // 无 snapshot，但重放仍在
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 10, dividends: 0 },
      }),
      priceOf: () => 12,
    });
    const row = rowOf(output, 'a1');
    expect(row.status).toBe('traded');
    if (row.status !== 'traded') return;
    // 无快照时金额仍来自重放（有 replay），但账户层对账不可用。
    expect(output.reconciliation.status).toBe('unavailable');
    expect(output.reconciliation.status === 'unavailable' && output.reconciliation.reason).toBe(
      'no-snapshot',
    );
    // 缺重放时金额才是 unavailable，且没有 value 键。
    const noReplay = build({
      advices: [a],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(5),
          price: money(12),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          adviceId: 'a1',
        }),
      ],
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 10 })]),
      priceOf: () => 12,
    });
    const noReplayRow = rowOf(noReplay, 'a1');
    if (noReplayRow.status !== 'traded') throw new Error('expected traded');
    expect(noReplayRow.contribution.status).toBe('unavailable');
    expect('value' in noReplayRow.contribution).toBe(false);
    expect(
      noReplayRow.contribution.status === 'unavailable' && noReplayRow.contribution.remedy.length,
    ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// D. 不得用观察收益冒充实际盈亏
// ---------------------------------------------------------------------------

describe('D 禁止用观察收益冒充实际盈亏', () => {
  const observation = (): SignalObservation =>
    ({
      id: 'a1:t1:obs',
      sourceKind: 'strategy-signal',
      sourceId: 'sig-1',
      stockId: '600519.SH',
      horizon: 't1',
      vintage: 'pit',
      status: 'complete',
      returnPct: 8.5,
      observedAt: new Date('2026-10-06T00:00:00.000Z'),
      createdAt: new Date('2026-10-06T00:00:00.000Z'),
    }) as unknown as SignalObservation;

  const holding: Holding = {
    id: 'h-1',
    accountId: ACCOUNT,
    stockId: '600519.SH',
    quantity: 100,
    availableQuantity: 100,
    avgCost: money(10),
    openedAt: new Date('2026-10-01T00:00:00.000Z'),
    closedAt: null,
  };

  it('D1 未成交建议：只给每股收益率，不给金额——输出里不存在被折算出的 8500', () => {
    // 刻意让 8.5% × 10 元 × 100 股 = 85 元 / 850 元 / 8500 这类「诱人数字」存在于世界里。
    expect(holding.quantity * 10 * 8.5).toBeCloseTo(8500, 6);
    const output = build({
      advices: [advice({ id: 'a1' })],
      observations: [observation()],
      replay: replayOf({
        '600519.SH': { quantity: 100, averageCost: 10, realizedPnl: 0, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 0, unrealized: 0 })]),
      priceOf: () => 10,
    });
    const row = rowOf(output, 'a1');
    expect('contribution' in row).toBe(false);
    if (row.status !== 'not-backfilled') throw new Error('expected not-backfilled');
    expect(row.hypothetical?.returnPct).toBe(8.5);
    expect(row.hypothetical?.notActualPnl).toBe(true);
    expect(row.hypothetical?.notConvertedToAmountReason).toBe('no-position-size');
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('8500');
    expect(serialized).not.toContain('850');
  });

  it('D2 用户自填的结果不能顶替账本金额（账本 320 优先于用户 500）', () => {
    const a = advice({ id: 'a1' });
    const output = build({
      advices: [a],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(32),
          price: money(20),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          adviceId: 'a1',
        }),
      ],
      outcomes: new Map<string, AdviceOutcome>([
        [
          'a1',
          {
            adviceId: 'a1',
            tradeIds: ['t1'],
            outcome: 'followed',
            origin: 'user',
            pnl: money(500),
            recordedAt: new Date('2026-10-20T00:00:00.000Z'),
          } as AdviceOutcome,
        ],
      ]),
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 320, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 320 })]),
      priceOf: () => 20,
    });
    const row = rowOf(output, 'a1');
    if (row.status !== 'traded') throw new Error('expected traded');
    if (row.contribution.status === 'unavailable') throw new Error('expected priced');
    expect(row.contribution.components.realized).toBeCloseTo(320, 6);
    expect(row.userReported?.reportedResult).toBe(500);
    // 对账等式用的是账本 320，不是用户填的 500。
    expect(output.reconciliation.status).toBe('available');
    if (output.reconciliation.status === 'available') {
      expect(output.reconciliation.adviceContributionSum).toBeCloseTo(320, 6);
      expect(JSON.stringify(output.reconciliation)).not.toContain('500');
    }
  });

  it('D3 静态守卫：观察相关字段名集合与 {pnl, contribution, amount} 不相交', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'advice-attribution.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // 观察块里不得出现承载金额的字段名。
    for (const forbidden of ['observationPnl', 'observationAmount', 'hypotheticalPnl'])
      expect(code).not.toContain(forbidden);
    // 不得用仓位或总资产把观察折算成金额。
    expect(code).not.toContain('targetPositionPct');
    expect(code).not.toContain('totalAssets');
  });
});

// ---------------------------------------------------------------------------
// E. 三条可对账等式
// ---------------------------------------------------------------------------

describe('E 三条等式：E1 逐股 / E2 账户闭合 / E3 头条', () => {
  const m = (value: number): number => Math.round(value * 10000) / 10000;

  /** 单股票全归因：残差为 0，三条等式全过。 */
  const fullyAttributed = () => {
    const a = advice({ id: 'a1' });
    const trades = [
      trade({
        id: 't1',
        side: 'sell',
        quantity: quantity(10),
        price: money(12),
        executedAt: new Date('2026-10-05T00:00:00.000Z'),
        adviceId: 'a1',
      }),
    ];
    const contributions = [contribution({ stockId: '600519.SH', realized: 20 })];
    return build({
      advices: [a],
      trades,
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 20, dividends: 0 },
      }),
      snapshot: snapshotOf(contributions),
      priceOf: () => 12,
    });
  };

  it('E1 单股票全归因 → E1/E2/E3 成立，reconciliation available 且 difference ≈ 0', () => {
    const output = fullyAttributed();
    const snapshot = snapshotOf([contribution({ stockId: '600519.SH', realized: 20 })]);
    // E1：Σ_A contrib(A,s) + residual(s) ≈ snapshot.contributions[s]
    const row = rowOf(output, 'a1');
    if (row.status !== 'traded') throw new Error('expected traded');
    const contributed = row.contribution.status === 'unavailable' ? 0 : row.contribution.value;
    const firstContribution = snapshot.contributions[0]?.contribution ?? Number.NaN;
    expect(m(contributed + 0)).toBeCloseTo(m(firstContribution), 6);
    // E2：Σ_s snapshot.contributions + unallocated − cashCosts ≈ totalPnl
    expect(
      m(snapshot.contributions.reduce((sum, item) => sum + item.contribution, 0) + 0 - 0),
    ).toBeCloseTo(m(snapshot.totalPnl ?? Number.NaN), 6);
    // E3：头条
    expect(output.reconciliation.status).toBe('available');
    if (output.reconciliation.status !== 'available') return;
    const expected = m(
      output.reconciliation.adviceContributionSum +
        output.reconciliation.residualSum +
        output.reconciliation.unallocatedDividends -
        output.reconciliation.cashCosts,
    );
    expect(expected).toBeCloseTo(m(output.reconciliation.accountTotalPnl), 6);
    expect(output.reconciliation.difference).toBeCloseTo(0, 6);
  });

  it('E2 有未归因成交 + 未分配分红 + fee → 等式仍成立，residual 三项照实给', () => {
    const a = advice({ id: 'a1' });
    const contributions = [
      contribution({ stockId: '600519.SH', realized: 20 }),
      contribution({ stockId: '600000.SH', realized: 10 }),
    ];
    const output = build({
      advices: [a],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(10),
          price: money(12),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          adviceId: 'a1',
        }),
        trade({
          id: 't2',
          side: 'sell',
          quantity: quantity(10),
          price: money(7),
          stockId: '600000.SH',
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
        }),
      ],
      replay: replayOf(
        {
          '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 20, dividends: 0 },
          '600000.SH': { quantity: 0, averageCost: 6, realizedPnl: 10, dividends: 0 },
        },
        { '600519.SH': ['trade:t1'], '600000.SH': ['trade:t2'] },
      ),
      snapshot: snapshotOf(contributions, 45, 10),
      unallocatedDividends: 45,
      cashCosts: 10,
      priceOf: () => 12,
    });
    expect(output.reconciliation.status).toBe('available');
    if (output.reconciliation.status !== 'available') return;
    expect(output.reconciliation.unallocatedDividends).toBeCloseTo(45, 6);
    expect(output.reconciliation.cashCosts).toBeCloseTo(10, 6);
    expect(output.reconciliation.residualSum).toBeCloseTo(10, 6);
    expect(output.residual.unattributedTrades.map((item) => item.stockId)).toEqual(['600000.SH']);
    expect(output.residual.residualTotal).toBeCloseTo(10 + 45 - 10, 6);
  });

  it('E3 负例：快照与重放对不上 → partial + difference 非零，不是 available', () => {
    const a = advice({ id: 'a1' });
    const output = build({
      advices: [a],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(10),
          price: money(12),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          adviceId: 'a1',
        }),
      ],
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 20, dividends: 0 },
      }),
      // 快照说账户赚了 19.99，而重放说 20：残差算出 19.99−20 = −0.01，头条差 0.01。
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 19.99 })]),
      priceOf: () => 12,
    });
    expect(output.reconciliation.status).toBe('partial');
    if (output.reconciliation.status !== 'partial') return;
    expect(Math.abs(output.reconciliation.difference)).toBeGreaterThan(1e-6);
    expect(output.reconciliation.expected).not.toBe(output.reconciliation.actual);
  });

  it('E4 负例：快照 totalPnl 不可用（缺价）→ reconciliation unavailable + coverage-gap，rows 仍返回', () => {
    const a = advice({ id: 'a1' });
    const incomplete = snapshotOf([contribution({ stockId: '600519.SH', realized: 20 })]);
    const output = build({
      advices: [a],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(10),
          price: money(12),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          adviceId: 'a1',
        }),
      ],
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 20, dividends: 0 },
      }),
      snapshot: { ...incomplete, totalPnl: undefined } as unknown as ReturnType<typeof snapshotOf>,
      priceOf: () => 12,
    });
    expect(output.reconciliation.status).toBe('unavailable');
    expect(output.reconciliation.status === 'unavailable' && output.reconciliation.reason).toBe(
      'coverage-gap',
    );
    // 账户级缺口不吞逐条事实。
    expect(output.rows).toHaveLength(1);
  });

  it('E5 负例：禁止摊派——difference 非零时没有任何一行的 contribution 被改动', () => {
    const a = advice({ id: 'a1' });
    const base = {
      advices: [a],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(10),
          price: money(12),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          adviceId: 'a1',
        }),
      ],
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 20, dividends: 0 },
      }),
      priceOf: () => 12,
    };
    const matched = build({
      ...base,
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 20 })]),
    });
    const mismatched = build({
      ...base,
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 19.99 })]),
    });
    const contributionValueOf = (output: GetAdviceAttributionOutput) => {
      const row = rowOf(output, 'a1');
      if (row.status !== 'traded') return undefined;
      return row.contribution.status === 'unavailable' ? undefined : row.contribution.value;
    };
    // 差值 0.01 没有被摊到那一行上。
    expect(contributionValueOf(mismatched)).toBe(contributionValueOf(matched));
    expect(mismatched.reconciliation.status).toBe('partial');
  });

  it('E6 同一成交被两条建议链接 → 只进一个 Σ，另一行标 sharedWithAdviceIds', () => {
    const a = advice({ id: 'a1' });
    const b = advice({ id: 'a2' });
    const shared = trade({
      id: 't1',
      side: 'sell',
      quantity: quantity(10),
      price: money(12),
      executedAt: new Date('2026-10-05T00:00:00.000Z'),
      adviceId: 'a1',
    });
    const output = build({
      advices: [a, b],
      trades: [shared],
      reviewTradeIds: new Map([['a2', ['t1']]]),
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 20, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 20 })]),
      priceOf: () => 12,
    });
    expect(output.warnings.join('；')).toContain('被多条建议链接');
    const owner = output.rows.find((row) => row.status === 'traded');
    expect(owner?.adviceId).toBe('a2'); // review.tradeIds 优先级更高
    const loser = output.rows.find((row) => row.adviceId === 'a1');
    expect(loser?.status).not.toBe('traded');
    if (owner?.status === 'traded')
      expect(owner.tradeLinks[0]?.sharedWithAdviceIds).toEqual(['a1']);
  });
});

// ---------------------------------------------------------------------------
// F. 可追溯
// ---------------------------------------------------------------------------

describe('F 每条结论可追到 adviceId + tradeId', () => {
  it('F1 traded 行的 tradeId 与 factIds 均可回表', () => {
    const output = build({
      advices: [advice({ id: 'a1' })],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(10),
          price: money(12),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
          adviceId: 'a1',
        }),
      ],
      replay: replayOf(
        { '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 20, dividends: 0 } },
        { '600519.SH': ['trade:t1'] },
      ),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 20 })]),
      priceOf: () => 12,
    });
    const row = rowOf(output, 'a1');
    if (row.status !== 'traded') throw new Error('expected traded');
    expect(row.tradeLinks[0]?.tradeId).toBe('t1');
    expect(row.factIds).toContain('trade:t1');
  });

  it('F2 负例：链接指向不存在的成交 → 进 unknowns（不静默丢弃）', () => {
    const output = build({
      advices: [advice({ id: 'a1' })],
      reviewTradeIds: new Map([['a1', ['missing-trade']]]),
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 0, realizedPnl: 0, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 0 })]),
    });
    expect(output.unknowns.join('；')).toContain('missing-trade');
    expect(rowOf(output, 'a1').status).not.toBe('traded');
  });

  it('F3 负例：tradeIds 被清空后重算 → 掉出 traded（只读当前修订）', () => {
    const before = build({
      advices: [advice({ id: 'a1' })],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(10),
          price: money(12),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
        }),
      ],
      reviewTradeIds: new Map([['a1', ['t1']]]),
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 20, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 20 })]),
      priceOf: () => 12,
    });
    expect(rowOf(before, 'a1').status).toBe('traded');
    const after = build({
      advices: [advice({ id: 'a1' })],
      trades: [
        trade({
          id: 't1',
          side: 'sell',
          quantity: quantity(10),
          price: money(12),
          executedAt: new Date('2026-10-05T00:00:00.000Z'),
        }),
      ],
      reviewTradeIds: new Map([['a1', []]]),
      replay: replayOf({
        '600519.SH': { quantity: 0, averageCost: 10, realizedPnl: 20, dividends: 0 },
      }),
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 20 })]),
      priceOf: () => 12,
    });
    expect(rowOf(after, 'a1').status).not.toBe('traded');
  });
});

// ---------------------------------------------------------------------------
// 口径与形状
// ---------------------------------------------------------------------------

describe('口径与形状', () => {
  it('输出带 schemaVersion / metricVersion / windowBasis=cumulative 与四条 limitations', () => {
    const output = build({
      advices: [advice({ id: 'a1' })],
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 0 })]),
    });
    expect(output.schemaVersion).toBe(ADVICE_ATTRIBUTION_SCHEMA_VERSION);
    expect(output.metricVersion).toBe(ADVICE_ATTRIBUTION_METRIC_VERSION);
    expect(output.windowBasis).toBe('cumulative');
    expect(output.limitations.join('；')).toContain('累计至 to');
    expect(output.limitations.join('；')).toContain('不摊派');
    expect(output.limitations.join('；')).toContain('双链并认');
    expect(GetAdviceAttributionOutput.safeParse(output).success).toBe(true);
  });

  it('不可映射的 subjectKind 不进 rows，只计数', () => {
    const output = build({
      advices: [
        advice({ id: 'a1', subjectKind: 'market', subjectId: 'CN_A_SHARES' }),
        advice({ id: 'a2' }),
      ],
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 0 })]),
    });
    expect(output.rows.map((row) => row.adviceId)).toEqual(['a2']);
    expect(output.excludedSubjects.unattributableSubjectKind).toBe(1);
  });

  it('窗口外的建议不进 rows', () => {
    const output = build({
      advices: [advice({ id: 'future', createdAt: new Date(NOW.getTime() + 10 * DAY) })],
      snapshot: snapshotOf([contribution({ stockId: '600519.SH', realized: 0 })]),
    });
    expect(output.rows).toEqual([]);
    expect(output.excludedSubjects.afterWindow).toBe(1);
  });
});
