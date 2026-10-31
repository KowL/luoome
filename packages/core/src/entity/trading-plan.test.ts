import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import {
  assertTradingPlanInvariants,
  assertTradingPlanReadable,
  DEFAULT_TRADING_PLAN_VOLATILITY_POLICY,
  evaluateTradingPlanCondition,
  evaluateTradingPlanEntryConditions,
  isMaterialTradingPlanChange,
  isUsableVolatilityPct,
  narrowTradingPlanRange,
  resolveTradingPlanVolatilityPolicy,
  selectTradingPlans,
  symmetricRangeAroundMid,
  TRADING_PLAN_VOLATILITY_MAX_STALENESS_TRADING_DAYS,
  TRADING_PLAN_VOLATILITY_METRIC,
  TRADING_PLAN_VOLATILITY_MIN_PCT,
  TRADING_PLAN_VOLATILITY_TIERS,
  TRADING_PLAN_VOLATILITY_WINDOW,
  type TradingPlan,
  TradingPlanSchema,
  TradingPlanV2Schema,
  toTradingPlanRead,
  tradingPlanDeltaPcts,
  tradingPlanExpiresAt,
  tradingPlanInvalidation,
  tradingPlanMonitoring,
  tradingPlanPickedPct,
  tradingPlanRangeWidthCap,
  tradingPlanVersionId,
  tradingPlanView,
  volatilityScaledRangePick,
} from './trading-plan.js';

const fixture = {
  id: 'account:a:stock:600519.SH',
  version: 1,
  accountId: 'a',
  stockId: '600519.SH',
  industry: '食品饮料',
  status: 'draft',
  action: 'enter',
  entryPriceLow: 100,
  entryPriceHigh: 105,
  entryConditions: [
    {
      id: 'entry-price',
      kind: 'price-range',
      phase: 'entry',
      metric: 'price',
      comparator: 'between',
      value: 100,
      valueTo: 105,
      description: '价格在入场区间内',
    },
  ],
  invalidEntryConditions: [],
  position: {
    currentPct: 0,
    targetPctRange: { min: 10, max: 10 },
    appliedPct: 10,
    fallbackPct: 10,
    rangePick: { ruleId: 'lower-bound' },
    constraintStatus: 'passed',
    constraintReasons: [],
    prerequisiteActions: ['用户手动执行后更新账户快照'],
  },
  holding: {
    minTradingDays: 3,
    maxTradingDays: 10,
    nextReviewAt: new Date('2026-09-14T00:00:00.000Z'),
    earlyExitConditions: ['跌破止损'],
    extensionBasis: ['市场前提仍成立'],
  },
  exit: {
    stopLoss: 95,
    takeProfit: 120,
    conditions: ['跌破止损或达到目标'],
    canSellNow: false,
  },
  validFrom: new Date('2026-09-08T00:00:00.000Z'),
  validUntil: new Date('2026-09-30T00:00:00.000Z'),
  invalidationConditions: ['行情证据过期'],
  invalidationRules: [
    {
      id: 'invalidate-stop',
      kind: 'price-threshold',
      phase: 'risk',
      metric: 'price',
      comparator: 'lte',
      value: 95,
      description: '跌破止损，原计划前提失效',
    },
  ],
  accountFactsAsOf: new Date('2026-09-08T00:00:00.000Z'),
  accountFactsDigest: 'account-facts-test-digest',
  marketFacts: [
    {
      id: 'fact-price',
      stockId: '600519.SH',
      metric: 'price',
      value: 102,
      unit: 'CNY',
      source: 'fixture',
      observedAt: new Date('2026-09-08T02:00:00.000Z'),
      fetchedAt: new Date('2026-09-08T02:00:01.000Z'),
      timestampSource: 'upstream',
      frequency: 'quote',
      status: 'available',
    },
  ],
  evidence: [
    {
      id: 'evidence-1',
      kind: 'market',
      source: 'fixture',
      observedAt: new Date('2026-09-08T02:00:00.000Z'),
      factIds: ['fact-price'],
      summary: '行情事实',
    },
  ],
  source: {
    strategyIds: [],
    strategyVersionIds: [],
    runIds: [],
    signalIds: [],
    adviceIds: ['advice-1'],
  },
  explanation: {
    supportingEvidenceIds: ['evidence-1'],
    counterEvidence: ['市场宽度未覆盖'],
    risks: ['价格波动'],
    unknowns: [],
  },
  confidence: 65,
  createdAt: new Date('2026-09-08T02:01:00.000Z'),
};

const plan = (overrides: Record<string, unknown> = {}) => {
  const base = fixture as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base, ...overrides };
  if (overrides.position !== undefined) {
    const position = {
      ...(base.position as Record<string, unknown>),
      ...(overrides.position as Record<string, unknown>),
    };
    const range = position.targetPctRange as { min: number; max: number } | null;
    if (range === null) {
      position.appliedPct = null;
      position.fallbackPct = null;
      position.rangePick = null;
    } else if ((position.rangePick as { ruleId?: string } | null | undefined)?.ruleId !== 'mid') {
      position.appliedPct = range.min;
      position.fallbackPct = range.min;
      position.rangePick = position.rangePick ?? { ruleId: 'lower-bound' };
    }
    merged.position = position;
  }
  return TradingPlanSchema.parse(merged);
};

describe('TradingPlan invariants and condition evaluation', () => {
  it('requires an entry range and target for active enter/add plans', () => {
    const invalid = { ...plan({ entryPriceHigh: undefined }), status: 'active' as const };
    expect(() => assertTradingPlanInvariants(invalid)).toThrow(InvariantError);
  });

  it('allows a draft enter plan to retain missing prerequisites', () => {
    expect(() =>
      assertTradingPlanInvariants(
        plan({
          entryPriceLow: undefined,
          entryPriceHigh: undefined,
          position: {
            ...plan().position,
            targetPctRange: null,
            appliedPct: null,
            fallbackPct: null,
            rangePick: null,
          },
        }),
      ),
    ).not.toThrow();
  });

  it('rejects active plans that contain unavailable market facts', () => {
    const invalid = {
      ...plan({ marketFacts: [{ ...plan().marketFacts[0], status: 'unavailable' }] }),
      status: 'active' as const,
    };
    expect(() => assertTradingPlanInvariants(invalid)).toThrow(/unavailable/);
  });

  it('rejects inverted between conditions', () => {
    expect(() =>
      plan({
        entryConditions: [
          {
            id: 'inverted',
            kind: 'price-range',
            phase: 'entry',
            metric: 'price',
            comparator: 'between',
            value: 110,
            valueTo: 100,
            description: '无效区间',
          },
        ],
      }),
    ).toThrow('between condition value must not exceed valueTo');
  });

  it('evaluates numeric conditions and returns null when the fact is missing', () => {
    const condition = plan().entryConditions[0];
    if (condition === undefined) throw new Error('fixture condition missing');
    expect(
      evaluateTradingPlanCondition(
        condition,
        new Map([['entry-price', { metric: 'price', value: 102 }]]),
      ),
    ).toBe(true);
    expect(
      evaluateTradingPlanCondition(
        condition,
        new Map([['entry-price', { metric: 'price', value: 108 }]]),
      ),
    ).toBe(false);
    expect(evaluateTradingPlanCondition(condition, new Map())).toBe(null);
  });

  it('keeps version identity stable and detects material changes', () => {
    const previous = plan();
    const next = TradingPlanSchema.parse({
      ...previous,
      version: 2,
      entryPriceHigh: 110,
      supersedesVersionId: tradingPlanVersionId(previous),
    });
    expect(tradingPlanVersionId(previous)).toBe('account:a:stock:600519.SH:v1');
    expect(isMaterialTradingPlanChange(previous, next)).toBe(true);
  });

  it('新的 Advice 和条件 ID 不构成修订，相同减仓条件也不重复发布', () => {
    const previous = plan({ status: 'active', action: 'reduce' });
    const next = plan({
      ...previous,
      version: 2,
      createdAt: new Date('2026-09-09T02:01:00Z'),
      entryConditions: previous.entryConditions.map((condition) => ({
        ...condition,
        id: 'new-id',
      })),
      source: { ...previous.source, adviceIds: ['new-advice'], runIds: ['new-run'] },
    });
    expect(isMaterialTradingPlanChange(previous, next)).toBe(false);
    expect(
      isMaterialTradingPlanChange(
        previous,
        plan({ ...next, accountFactsDigest: 'changed-digest' }),
      ),
    ).toBe(true);
    expect(
      isMaterialTradingPlanChange(
        previous,
        plan({ ...next, exit: { ...next.exit, stopLoss: 96 } }),
      ),
    ).toBe(true);
    expect(
      isMaterialTradingPlanChange(
        previous,
        plan({ ...next, explanation: { ...next.explanation, risks: ['新风险'] } }),
      ),
    ).toBe(true);
  });

  it('维持持仓时市值百分比漂移不是新目标，明确调整目标或市场前提则需要新版本', () => {
    const previous = plan({
      status: 'active',
      action: 'hold',
      position: { ...plan().position, currentPct: 25, targetPctRange: { min: 25, max: 25 } },
    });
    const next = plan({
      ...previous,
      position: { ...previous.position, currentPct: 27, targetPctRange: { min: 27, max: 27 } },
    });
    expect(isMaterialTradingPlanChange(previous, next)).toBe(false);
    expect(
      isMaterialTradingPlanChange(
        previous,
        plan({ ...next, position: { ...next.position, targetPctRange: { min: 26, max: 26 } } }),
      ),
    ).toBe(true);
    const marketPlan = plan({
      entryConditions: [
        {
          id: 'market-1',
          kind: 'market-fact',
          phase: 'market',
          factId: 'fact-price',
          description: '确认市场前提',
        },
      ],
    });
    expect(
      isMaterialTradingPlanChange(
        marketPlan,
        plan({
          ...marketPlan,
          marketFacts: marketPlan.marketFacts.map((fact) => ({ ...fact, value: 103 })),
        }),
      ),
    ).toBe(true);
  });
});

describe('当前计划版本', () => {
  const now = new Date('2026-09-09T02:00:00Z');
  it('新草案保留旧生效计划；草案过期后不再作为修订候选展示', () => {
    const active = plan({ status: 'active' });
    const draft = plan({ version: 2, createdAt: now });
    expect(tradingPlanView([draft, active], now, null)).toEqual({
      planId: active.id,
      versionId: tradingPlanVersionId(active),
      kind: 'current',
      draftVersionId: tradingPlanVersionId(draft),
    });
    expect(
      tradingPlanView([draft, active], tradingPlanExpiresAt(draft), null)?.draftVersionId,
    ).toBeUndefined();
    expect(selectTradingPlans([draft, active], { activeOnly: true, asOf: now })).toEqual([active]);
  });

  it('旧生效版已过期或账户已变时展示未过期新草案，不复活更旧版本', () => {
    const active = plan({ status: 'active', validUntil: now });
    const draft = plan({ version: 2, createdAt: now });
    expect(tradingPlanView([active, draft], now, null)?.versionId).toBe(
      tradingPlanVersionId(draft),
    );
    expect(
      tradingPlanView([plan({ status: 'active' }), draft], now, { digest: 'new-digest' })
        ?.versionId,
    ).toBe(tradingPlanVersionId(draft));
    expect(
      selectTradingPlans(
        [plan({ status: 'active' }), plan({ status: 'active', version: 2, validUntil: now })],
        { activeOnly: true, asOf: now },
      ),
    ).toEqual([]);
  });

  it('计划明确撤销后停止监控', () => {
    const active = plan({ status: 'active' });
    const revoked = plan({ version: 2, status: 'revoked' });
    expect(selectTradingPlans([active, revoked], { activeOnly: true })).toEqual([]);
    expect(tradingPlanView([active, revoked], now, null)?.kind).toBe('history');
  });

  it('数量限制优先保留仍有效计划，近期过期草案不能挤掉它', () => {
    const active = plan({ status: 'active' });
    const expired = plan({ id: 'expired', createdAt: now, validUntil: now });
    expect(
      selectTradingPlans([expired, active], { currentOnly: true, asOf: now, limit: 1 }),
    ).toEqual([active]);
  });

  it('截至指定日期的当前版本不能被之后的修订或撤销遮住', () => {
    const active = plan({ status: 'active' });
    const future = plan({
      version: 2,
      status: 'revoked',
      createdAt: new Date('2026-09-11T00:00:00Z'),
    });
    expect(selectTradingPlans([active, future], { currentOnly: true, createdUntil: now })).toEqual([
      active,
    ]);
  });
});

describe('交易计划的监控资格与组合条件', () => {
  const now = new Date('2026-09-10T00:00:00Z');
  it.each(['active', 'revoked'] as const)('新 %s 版本使旧生效版和草案停止监控', (status) => {
    const active = plan({ status: 'active' });
    const draft = plan({ version: 2, createdAt: now });
    const latest = plan({ status, version: 3, createdAt: now });
    const versions = [active, draft, latest];
    const facts = { digest: active.accountFactsDigest, status: 'complete' as const };
    expect(tradingPlanMonitoring(active, facts, now, undefined, versions).status).toBe('inactive');
    expect(tradingPlanMonitoring(draft, facts, now, undefined, versions).status).toBe('inactive');
  });

  it('修订草案保留原生效版的监控资格，更旧草案归为历史', () => {
    const active = plan({ status: 'active' });
    const oldDraft = plan({ version: 2, createdAt: now });
    const draft = plan({ version: 3, createdAt: now });
    const versions = [active, oldDraft, draft];
    const facts = { digest: active.accountFactsDigest, status: 'complete' as const };
    expect(tradingPlanMonitoring(active, facts, now, undefined, versions).status).toBe('ready');
    expect(tradingPlanMonitoring(draft, facts, now, undefined, versions).status).toBe('draft');
    expect(tradingPlanMonitoring(oldDraft, facts, now, undefined, versions).status).toBe(
      'inactive',
    );
  });

  it('草案超过有效期后归为已过期，不能永久停留在待补全', () => {
    const draft = plan({ validUntil: now });
    expect(tradingPlanMonitoring(draft, null, now).status).toBe('expired');
  });

  it('存量草案即使有效期很长，也只保留首次生成后的两个交易日', () => {
    const draft = plan();
    expect(tradingPlanMonitoring(draft, null, new Date('2026-09-10T02:01:00Z')).status).toBe(
      'expired',
    );
  });

  it('草案期限跨周末，复核到期不会让生效计划过期', () => {
    const draft = plan({ createdAt: new Date('2026-07-17T07:00:00Z') });
    expect(tradingPlanExpiresAt(draft)).toEqual(new Date('2026-07-21T07:00:00Z'));
    expect(tradingPlanMonitoring(draft, null, new Date('2026-07-19T07:00:00Z')).status).toBe(
      'draft',
    );
    const active = plan({ status: 'active', holding: { ...plan().holding, nextReviewAt: now } });
    expect(
      tradingPlanMonitoring(active, { digest: active.accountFactsDigest, status: 'complete' }, now)
        .status,
    ).toBe('ready');
  });

  it('生效状态不等于可监控；账户变化优先给出重新生成入口', () => {
    const active = plan({ status: 'active' });
    expect(
      tradingPlanMonitoring(active, { digest: active.accountFactsDigest, status: 'complete' }, now)
        .status,
    ).toBe('ready');
    expect(
      tradingPlanMonitoring(active, { digest: 'new-digest', status: 'unavailable' }, now).status,
    ).toBe('account-changed');
    expect(tradingPlanMonitoring(active, null, now).status).toBe('unavailable');
    expect(tradingPlanMonitoring(active, null, active.validUntil).status).toBe('expired');
    expect(tradingPlanMonitoring(plan(), null, now).status).toBe('draft');
  });
  it('所有入场条件满足才就绪，未知前提不能通过', () => {
    const active = plan();
    const facts = new Map([['entry-price', { metric: 'price' as const, value: 102 }]]);
    expect(evaluateTradingPlanEntryConditions(active, facts)).toBe(true);
    expect(
      evaluateTradingPlanEntryConditions(
        {
          ...active,
          entryConditions: [
            ...active.entryConditions,
            {
              id: 'manual',
              kind: 'manual-confirmation',
              phase: 'entry',
              description: '等待确认',
            },
          ],
        },
        facts,
      ),
    ).toBeNull();
    expect(evaluateTradingPlanEntryConditions({ ...active, entryConditions: [] }, facts)).toBe(
      false,
    );
  });
});

// ---------- T21 / REQ-M3-03 验收：区间量纲、宽度、选点、deltaPct、指纹 ----------

const v2 = (overrides: Record<string, unknown> = {}) =>
  TradingPlanV2Schema.safeParse({ ...(fixture as Record<string, unknown>), ...overrides });

const withPosition = (
  range: { min: number; max: number } | null,
  extra: Record<string, unknown> = {},
  action: TradingPlan['action'] = 'add',
) => ({
  action,
  position: {
    currentPct: 0,
    targetPctRange: range,
    appliedPct: range === null ? null : range.min,
    fallbackPct: range === null ? null : range.min,
    rangePick: range === null ? null : { ruleId: 'lower-bound' },
    constraintStatus: 'passed',
    constraintReasons: [],
    prerequisiteActions: [],
    ...extra,
  },
});

describe('T21 量纲与 action 分档', () => {
  it('exit {0,0} 通过', () => {
    const parsed = v2(withPosition({ min: 0, max: 0 }, {}, 'exit'));
    expect(parsed.success).toBe(true);
  });

  it('add {0,5} 拒绝', () => {
    expect(v2(withPosition({ min: 0, max: 5 })).success).toBe(false);
  });

  it('add {0,4} 仅因 min=0 被拒（宽度合法）', () => {
    const parsed = v2(withPosition({ min: 0, max: 4 }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.message).toContain('min > 0');
    }
  });

  it('hold {0,4} 拒绝 / hold {7,10} 通过', () => {
    expect(v2(withPosition({ min: 0, max: 4 }, {}, 'hold')).success).toBe(false);
    expect(v2(withPosition({ min: 7, max: 10 }, {}, 'hold')).success).toBe(true);
  });

  it('exit {0,4} 拒绝（exit 必须是 {0,0}）', () => {
    expect(v2(withPosition({ min: 0, max: 4 }, {}, 'exit')).success).toBe(false);
  });

  it('拒绝比例单位 {0.1,0.3}', () => {
    const parsed = v2(withPosition({ min: 0.1, max: 0.3 }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.message).toContain('百分点');
    }
  });

  it('observe {0,0} 通过（未设置条件仓位）', () => {
    expect(v2(withPosition({ min: 0, max: 0 }, {}, 'observe')).success).toBe(true);
  });
});

describe('T21 H4 实际宽度上限 = min(分层, 0.30×max)', () => {
  it('max=10 宽 3 过 / 3.01 拒；宽 4 被相对规则拒', () => {
    expect(v2(withPosition({ min: 7, max: 10 })).success).toBe(true);
    expect(v2(withPosition({ min: 6.99, max: 10 })).success).toBe(false);
    expect(v2(withPosition({ min: 6, max: 10 })).success).toBe(false);
  });

  it('max=25 宽 7.5 过 / 7.51 拒', () => {
    expect(v2(withPosition({ min: 17.5, max: 25 })).success).toBe(true);
    const over = v2(withPosition({ min: 17.49, max: 25 }));
    expect(over.success).toBe(false);
    if (!over.success) expect(over.error.message).toContain('宽度');
  });

  it('max=20 宽 6 过 / 6.01 拒（两口径相等）', () => {
    expect(v2(withPosition({ min: 14, max: 20 })).success).toBe(true);
    expect(v2(withPosition({ min: 13.99, max: 20 })).success).toBe(false);
  });

  it('max=30 宽 8 过 / 8.01 拒（分层绑定）', () => {
    expect(v2(withPosition({ min: 22, max: 30 })).success).toBe(true);
    expect(v2(withPosition({ min: 21.99, max: 30 })).success).toBe(false);
  });

  it('实际宽度上限函数：cap(10)=3 / cap(20)=6 / cap(25)=7.5 / cap(30)=8', () => {
    expect(tradingPlanRangeWidthCap(10)).toBe(3);
    expect(tradingPlanRangeWidthCap(20)).toBe(6);
    expect(tradingPlanRangeWidthCap(25)).toBe(7.5);
    expect(tradingPlanRangeWidthCap(30)).toBe(8);
  });
});

describe('T21 选点与落库取值', () => {
  it('缺 rangePick 拒绝', () => {
    const position = {
      ...withPosition({ min: 7, max: 10 }).position,
      rangePick: null,
    };
    const parsed = v2({ action: 'add', position });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain('rangePick');
  });

  it('volatility-scaled 缺 tiers / 缺 volatilityPct 均拒绝', () => {
    const base = withPosition({ min: 7, max: 10 });
    const noTiers = {
      action: 'add',
      position: {
        ...base.position,
        rangePick: { ruleId: 'volatility-scaled', volatilityMetric: 'atr14', volatilityPct: 1.2 },
        appliedPct: 7,
      },
    };
    expect(v2(noTiers).success).toBe(false);
    const noVol = {
      action: 'add',
      position: {
        ...base.position,
        rangePick: {
          ruleId: 'volatility-scaled',
          volatilityMetric: 'atr14',
          tiers: [{ volatilityUpToPct: 2, bandFractionPct: 50 }],
        },
        appliedPct: 7,
      },
    };
    expect(v2(noVol).success).toBe(false);
  });

  it('lower-bound 的 appliedPct 必须等于 min', () => {
    const parsed = v2(withPosition({ min: 7, max: 10 }, { appliedPct: 8 }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain('选点结果');
  });

  it('mid 的 appliedPct = (min+max)/2', () => {
    const ok = v2(
      withPosition({ min: 7, max: 10 }, { appliedPct: 8.5, rangePick: { ruleId: 'mid' } }),
    );
    expect(ok.success).toBe(true);
    expect(
      v2(withPosition({ min: 7, max: 10 }, { appliedPct: 8, rangePick: { ruleId: 'mid' } }))
        .success,
    ).toBe(false);
  });

  it('volatility-scaled 按 tier 复算 appliedPct，无匹配 tier 降级到 min', () => {
    const pick = (volatilityPct: number, appliedPct: number) =>
      v2(
        withPosition(
          { min: 7, max: 10 },
          {
            appliedPct,
            rangePick: {
              ruleId: 'volatility-scaled',
              volatilityMetric: 'atr14',
              volatilityPct,
              tiers: [
                { volatilityUpToPct: 2, bandFractionPct: 100 },
                { volatilityUpToPct: 4, bandFractionPct: 50 },
              ],
            },
          },
        ),
      );
    expect(pick(1, 10).success).toBe(true);
    expect(pick(3, 8.5).success).toBe(true);
    expect(pick(3, 9).success).toBe(false);
    expect(pick(9, 7).success).toBe(true);
  });

  it('标准波动率分档：波动越大落点越低，且始终落在区间内', () => {
    const range = { min: 8.24, max: 11.77 };
    const pickAt = (volatilityPct: number) => volatilityScaledRangePick(volatilityPct);
    // 分档 1.5 / 2.5 / 4 / 6 → 区间宽度占比 100% / 67% / 33% / 0%。
    expect([0.8, 2, 3, 5, 7.5].map((vol) => tradingPlanPickedPct(range, pickAt(vol)))).toEqual([
      11.77, 10.61, 9.4, 8.24, 8.24,
    ]);
    expect(pickAt(3)).toMatchObject({
      ruleId: 'volatility-scaled',
      volatilityMetric: TRADING_PLAN_VOLATILITY_METRIC,
      volatilityPct: 3,
    });
    // H4 宽度校验不因选点放宽：任何波动率下的落点都在区间内。
    for (const vol of [0, 0.8, 1.5, 2, 3, 5, 6, 20]) {
      const picked = tradingPlanPickedPct(range, pickAt(vol));
      expect(picked).toBeGreaterThanOrEqual(range.min);
      expect(picked).toBeLessThanOrEqual(range.max);
    }
  });

  it('波动率窗口随 rangePick 落库，且不影响 appliedPct 复算', () => {
    const range = { min: 8.24, max: 11.77 };
    const withWindow = (window: {
      windowStart: Date;
      windowEnd: Date;
      barsCount: number;
      maxGapTradingDays?: number;
    }) =>
      v2(
        withPosition(range, {
          appliedPct: 9.4,
          rangePick: volatilityScaledRangePick(3, window),
        }),
      );

    const ok = withWindow({
      windowStart: new Date('2026-07-01T00:00:00.000Z'),
      windowEnd: new Date('2026-07-31T00:00:00.000Z'),
      barsCount: 21,
      maxGapTradingDays: 0,
    });
    expect(ok.success).toBe(true);
    if (!ok.success) return;
    expect(ok.data.position.rangePick).toMatchObject({
      ruleId: 'volatility-scaled',
      windowStart: new Date('2026-07-01T00:00:00.000Z'),
      windowEnd: new Date('2026-07-31T00:00:00.000Z'),
      barsCount: 21,
      maxGapTradingDays: 0,
    });
    // 加了窗口不改变选点结果：H4 宽度与落点规则都没动。
    expect(ok.data.position.appliedPct).toBe(9.4);
    expect(ok.data.position.targetPctRange).toEqual(range);
  });

  it('波动率窗口不自洽时拒绝：起点晚于终点 / bar 数不足以算出 20 个收益率', () => {
    const range = { min: 8.24, max: 11.77 };
    const build = (window: { windowStart: Date; windowEnd: Date; barsCount: number }) =>
      v2(
        withPosition(range, {
          appliedPct: 9.4,
          rangePick: volatilityScaledRangePick(3, window),
        }),
      );

    const reversed = build({
      windowStart: new Date('2026-07-31T00:00:00.000Z'),
      windowEnd: new Date('2026-07-01T00:00:00.000Z'),
      barsCount: 21,
    });
    expect(reversed.success).toBe(false);
    if (!reversed.success) expect(reversed.error.message).toContain('窗口起点');

    const tooFew = build({
      windowStart: new Date('2026-07-11T00:00:00.000Z'),
      windowEnd: new Date('2026-07-31T00:00:00.000Z'),
      barsCount: TRADING_PLAN_VOLATILITY_WINDOW,
    });
    expect(tooFew.success).toBe(false);
    if (!tooFew.success) expect(tooFew.error.message).toContain('bar 数');
  });

  it('旧计划没有窗口字段仍可读（optional），选点复算不变', () => {
    const parsed = v2(
      withPosition(
        { min: 8.24, max: 11.77 },
        {
          appliedPct: 9.4,
          // 本字段引入前落库的形状：只有 tiers + volatilityPct，没有 windowStart/windowEnd。
          rangePick: {
            ruleId: 'volatility-scaled',
            volatilityMetric: TRADING_PLAN_VOLATILITY_METRIC,
            volatilityPct: 3,
            tiers: TRADING_PLAN_VOLATILITY_TIERS.map((tier) => ({ ...tier })),
          },
        },
      ),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const pick = parsed.data.position.rangePick;
    if (pick === null || pick.ruleId !== 'volatility-scaled') throw new Error('expected pick');
    expect(pick.windowStart).toBeUndefined();
    expect(pick.windowEnd).toBeUndefined();
    expect(pick.barsCount).toBeUndefined();
    expect(pick.maxGapTradingDays).toBeUndefined();
    expect(parsed.data.position.appliedPct).toBe(9.4);
  });

  it('波动率阈值可配置：默认值仍是 0.1 / 5，可局部覆盖', () => {
    // 默认值本身是「未标定的经验值」，改动它们必须同时改这条断言。
    expect(TRADING_PLAN_VOLATILITY_MIN_PCT).toBe(0.1);
    expect(TRADING_PLAN_VOLATILITY_MAX_STALENESS_TRADING_DAYS).toBe(5);
    expect(DEFAULT_TRADING_PLAN_VOLATILITY_POLICY).toEqual({
      minVolatilityPct: 0.1,
      maxStalenessTradingDays: 5,
    });
    expect(resolveTradingPlanVolatilityPolicy()).toEqual(DEFAULT_TRADING_PLAN_VOLATILITY_POLICY);
    expect(resolveTradingPlanVolatilityPolicy({ minVolatilityPct: 0.5 })).toEqual({
      minVolatilityPct: 0.5,
      maxStalenessTradingDays: 5,
    });
    expect(resolveTradingPlanVolatilityPolicy({ maxStalenessTradingDays: 10 })).toEqual({
      minVolatilityPct: 0.1,
      maxStalenessTradingDays: 10,
    });

    // 下限参与判定：0.3% 在默认下限下可用，在 1% 下限下不可用。
    expect(isUsableVolatilityPct(0.3)).toBe(true);
    expect(isUsableVolatilityPct(0.3, 1)).toBe(false);
    expect(isUsableVolatilityPct(0)).toBe(false);
    expect(isUsableVolatilityPct(Number.NaN)).toBe(false);
  });

  it('区间为空时 appliedPct/fallbackPct/rangePick 必须为空', () => {
    expect(v2(withPosition(null)).success).toBe(true);
    expect(v2(withPosition(null, { appliedPct: 5 })).success).toBe(false);
  });
});

describe('T21 deltaPct 读侧派生与旧行兼容', () => {
  it('新计划不持久化 deltaPct，读模型派生 min/max', () => {
    const parsed = v2(withPosition({ min: 7, max: 10 }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(JSON.stringify(parsed.data)).not.toContain('deltaPct');
    const read = toTradingPlanRead(parsed.data);
    expect(read.position).toMatchObject({ deltaPctMin: 7, deltaPctMax: 10 });
    expect(tradingPlanDeltaPcts(parsed.data)).toEqual({ min: 7, max: 10 });
  });

  it('旧单值计划读为退化区间，deltaMin=deltaMax=旧 delta', () => {
    const legacy = {
      ...(fixture as Record<string, unknown>),
      position: {
        currentPct: 4,
        targetPct: 30,
        deltaPct: 26,
        constraintStatus: 'passed',
        constraintReasons: [],
        prerequisiteActions: [],
      },
    };
    const parsed = TradingPlanSchema.parse(legacy);
    expect(parsed.position).toMatchObject({
      targetPctRange: { min: 30, max: 30 },
      appliedPct: 30,
      fallbackPct: 30,
      rangePick: { ruleId: 'lower-bound' },
    });
    expect(parsed.position).not.toHaveProperty('deltaPct');
    expect(tradingPlanDeltaPcts(parsed)).toEqual({ min: 26, max: 26 });
    expect(toTradingPlanRead(parsed).position).toMatchObject({
      deltaPctMin: 26,
      deltaPctMax: 26,
    });
  });

  it('旧 active 行可读（无结构化失效条件不抛），写路径仍拒绝', () => {
    const legacy = {
      ...(fixture as Record<string, unknown>),
      status: 'active',
      position: {
        currentPct: 0,
        targetPct: 10,
        deltaPct: 10,
        constraintStatus: 'passed',
        constraintReasons: [],
        prerequisiteActions: [],
      },
      invalidationRules: undefined,
    };
    const readable = assertTradingPlanReadable(legacy);
    expect(readable.status).toBe('active');
    const write = TradingPlanV2Schema.safeParse(readable);
    expect(write.success).toBe(false);
    if (!write.success) expect(write.error.message).toContain('结构化失效条件');
  });

  it('区间计划不再触发旧的 deltaPct 不变量', () => {
    const parsed = v2(withPosition({ min: 7, max: 10 }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(() => assertTradingPlanInvariants(parsed.data)).not.toThrow();
  });
});

describe('T21 指纹与结构化失效条件', () => {
  const invalidationRule = {
    id: 'invalidate-stop',
    kind: 'price-threshold' as const,
    phase: 'risk' as const,
    metric: 'price' as const,
    comparator: 'lte' as const,
    value: 95,
    description: '跌破止损',
  };

  it('仅区间变化即实质变更', () => {
    const previous = plan({ status: 'active', action: 'add' });
    const next = plan({
      ...previous,
      version: 2,
      position: {
        ...previous.position,
        targetPctRange: { min: 8, max: 10 },
        appliedPct: 8,
        fallbackPct: 8,
      },
    });
    expect(isMaterialTradingPlanChange(previous, next)).toBe(true);
  });

  it('仅失效规则变化即实质变更', () => {
    const previous = plan({ status: 'active', action: 'add' });
    const next = plan({
      ...previous,
      version: 2,
      invalidationRules: [{ ...invalidationRule, value: 96 }],
    });
    expect(isMaterialTradingPlanChange(previous, next)).toBe(true);
  });

  it('完全相同不是实质变更', () => {
    const previous = plan({ status: 'active', action: 'add' });
    expect(isMaterialTradingPlanChange(previous, { ...previous, version: 2 })).toBe(false);
  });

  it('指纹变化使区间与失效条件同时失效，且不评估规则', () => {
    const active = plan({ status: 'active', action: 'add' });
    const state = tradingPlanInvalidation({
      plan: active,
      facts: { digest: 'changed-digest', status: 'complete' },
      now: new Date('2026-09-09T00:00:00Z'),
      factsByConditionId: new Map([['invalidate-stop', { metric: 'price' as const, value: 90 }]]),
    });
    expect(state).toEqual({ status: 'inactive', reasons: ['account-facts-changed'] });
  });

  it('同一指纹下止损条件命中才失效；行情事实过期也算失效', () => {
    const active = plan({ status: 'active', action: 'add' });
    const now = new Date('2026-09-09T00:00:00Z');
    expect(
      tradingPlanInvalidation({
        plan: active,
        facts: { digest: active.accountFactsDigest, status: 'complete' },
        now,
        factsByConditionId: new Map([['invalidate-stop', { metric: 'price' as const, value: 90 }]]),
      }),
    ).toEqual({ status: 'triggered', ruleIds: ['invalidate-stop'] });
    expect(
      tradingPlanInvalidation({
        plan: active,
        facts: { digest: active.accountFactsDigest, status: 'complete' },
        now,
        factsByConditionId: new Map([
          ['invalidate-stop', { metric: 'price' as const, value: 120 }],
        ]),
      }),
    ).toEqual({ status: 'not-triggered' });
  });

  it('active 缺结构化失效条件在写路径被拒', () => {
    const parsed = v2({
      ...withPosition({ min: 7, max: 10 }),
      status: 'active',
      invalidationRules: [],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain('结构化失效条件');
  });
});

// ---------- T29 / M3-03：区间纪律生产接线 ----------
describe('T29 H4 对称收窄', () => {
  it('8–12 迭代收窄到 8.24–11.77（中点保持 10，宽度随 max 的 cap 收敛）', () => {
    const result = narrowTradingPlanRange({ min: 8, max: 12 });
    expect(result).toEqual({ applied: { min: 8.24, max: 11.77 }, clamped: true });
    // 旧单向方案会得到 8.4–12，appliedPct 从 8 抬到 8.4；对称收窄不会加大敞口。
    expect(result.applied.min).toBeLessThan(8.4);
    expect((result.applied.min + result.applied.max) / 2).toBeCloseTo(10, 1);
    // 不动点：宽度必须 ≤ 收窄后 max 的 H4 上限。
    expect(result.applied.max - result.applied.min).toBeLessThanOrEqual(
      tradingPlanRangeWidthCap(result.applied.max) + 1e-9,
    );
  });

  it('{0,6} 迭代收窄到 2.47–3.55（中点 3 不变）', () => {
    expect(narrowTradingPlanRange({ min: 0, max: 6 })).toEqual({
      applied: { min: 2.47, max: 3.55 },
      clamped: true,
    });
  });

  it('边界：mid±cap/2 越界时把剩余宽度补到另一侧', () => {
    // 这两条直接测边界函数：H4 的 cap 下对称收窄永远落在原区间内，0/100 钳制不可达。
    expect(symmetricRangeAroundMid(3, 3.6)).toEqual({ min: 1.2, max: 4.8 });
    expect(symmetricRangeAroundMid(98, 3.6)).toEqual({ min: 96.2, max: 99.8 });
    expect(symmetricRangeAroundMid(1, 3.6)).toEqual({ min: 0, max: 3.6 });
    expect(symmetricRangeAroundMid(99, 3.6)).toEqual({ min: 96.4, max: 100 });
  });

  it('H4 在 schema 层真的拒：4–10（宽 6 > cap 3）parse 失败', () => {
    const parsed = v2(withPosition({ min: 4, max: 10 }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain('宽度');
  });

  it('未超限时不收窄、不产生 adjustment', () => {
    expect(narrowTradingPlanRange({ min: 9, max: 10 })).toEqual({
      applied: { min: 9, max: 10 },
      clamped: false,
    });
    expect(narrowTradingPlanRange({ min: 96, max: 100 })).toEqual({
      applied: { min: 96, max: 100 },
      clamped: false,
    });
  });
});
