import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import {
  assertTradingPlanInvariants,
  evaluateTradingPlanCondition,
  evaluateTradingPlanEntryConditions,
  isMaterialTradingPlanChange,
  selectTradingPlans,
  TradingPlanSchema,
  tradingPlanExpiresAt,
  tradingPlanMonitoring,
  tradingPlanVersionId,
  tradingPlanView,
} from './trading-plan.js';

const plan = (overrides: Record<string, unknown> = {}) =>
  TradingPlanSchema.parse({
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
      targetPct: 10,
      deltaPct: 10,
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
    ...overrides,
  });

describe('TradingPlan invariants and condition evaluation', () => {
  it('requires an entry range and target for active enter/add plans', () => {
    const invalid = plan({ status: 'active', entryPriceHigh: undefined });
    expect(() => assertTradingPlanInvariants(invalid)).toThrow(InvariantError);
  });

  it('allows a draft enter plan to retain missing prerequisites', () => {
    expect(() =>
      assertTradingPlanInvariants(
        plan({
          entryPriceLow: undefined,
          entryPriceHigh: undefined,
          position: { ...plan().position, targetPct: null, deltaPct: null },
        }),
      ),
    ).not.toThrow();
  });

  it('rejects active plans that contain unavailable market facts', () => {
    const invalid = plan({
      status: 'active',
      marketFacts: [{ ...plan().marketFacts[0], status: 'unavailable' }],
    });
    expect(() => assertTradingPlanInvariants(invalid)).toThrow('unavailable market fact');
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
      position: { ...plan().position, currentPct: 25, targetPct: 25, deltaPct: 0 },
    });
    const next = plan({
      ...previous,
      position: { ...previous.position, currentPct: 27, targetPct: 27 },
    });
    expect(isMaterialTradingPlanChange(previous, next)).toBe(false);
    expect(
      isMaterialTradingPlanChange(
        previous,
        plan({ ...next, position: { ...next.position, targetPct: 26, deltaPct: -1 } }),
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
