import { describe, expect, it } from 'vitest';

import {
  AdviceOutcomeSchema,
  AdviceQuerySchema,
  AdviceSchema,
  adviceDataSnapshotFromFacts,
  adviceNotificationSummary,
  isAdviceQuoteCurrent,
  isRuleFallbackAdvice,
  STANDARD_DISCLAIMERS,
  StrategyAdviceAnalysisSchema,
} from './advice.js';
import { QuoteSchema } from './quote.js';

const NOW_ISO = '2026-07-17T02:00:00.000Z';

describe('entity zod schemas (z.coerce.date 约定)', () => {
  it('QuoteSchema coerces ISO strings into Date and money fields', () => {
    const q = QuoteSchema.parse({
      stockId: 'stk1',
      ts: NOW_ISO,
      open: 96.1,
      high: 97.2,
      low: 95.8,
      close: 96.18,
      volume: 12_345_678,
      source: 'test',
    });
    expect(q.ts).toBeInstanceOf(Date);
    expect(q.close).toBe(96.18);
  });

  it('AdviceSchema parses a full advice with coerced dates', () => {
    const advice = AdviceSchema.parse({
      id: 'adv1',
      subjectKind: 'stock',
      subjectId: 'stk1',
      decision: 'hold',
      confidence: 65,
      horizon: 'short',
      reasoning: {
        premise: '箱体震荡',
        evidence: ['MA 粘合'],
        counterEvidence: ['板块回暖'],
      },
      risks: ['系统性风险'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      sourceTool: 'analyze_stock',
      basedOn: { dataAsOf: NOW_ISO },
      validFrom: NOW_ISO,
      validUntil: '2026-07-22T02:00:00.000Z',
      createdAt: NOW_ISO,
    });
    expect(advice.validFrom).toBeInstanceOf(Date);
    expect(advice.basedOn.dataAsOf).toBeInstanceOf(Date);
    expect(advice.disclaimers).toHaveLength(3);
  });

  it('AdviceSchema rejects empty disclaimers', () => {
    const base = {
      id: 'adv1',
      subjectKind: 'stock',
      subjectId: 'stk1',
      decision: 'hold',
      confidence: 65,
      horizon: 'short',
      reasoning: { premise: 'p', evidence: [], counterEvidence: [] },
      risks: [],
      disclaimers: [],
      basedOn: { dataAsOf: NOW_ISO },
      validFrom: NOW_ISO,
      validUntil: '2026-07-22T02:00:00.000Z',
      createdAt: NOW_ISO,
    };
    expect(AdviceSchema.safeParse(base).success).toBe(false);
  });

  it('AdviceQuerySchema applies includeExpired as optional flag', () => {
    expect(AdviceQuerySchema.parse({}).includeExpired).toBeUndefined();
    expect(AdviceQuerySchema.parse({ includeExpired: true }).includeExpired).toBe(true);
    expect(AdviceQuerySchema.parse({ since: NOW_ISO }).since).toBeInstanceOf(Date);
  });

  it('AdviceOutcomeSchema 保留交易关联与复盘字段，旧数据默认空 tradeIds', () => {
    const outcome = AdviceOutcomeSchema.parse({
      adviceId: 'adv1',
      outcome: 'partially_followed',
      pnl: 12.34567,
      benchmarkPnl: 8,
      holdingHours: 4,
      notes: '只执行了一半',
      recordedAt: NOW_ISO,
    });
    expect(outcome.tradeIds).toEqual([]);
    expect(outcome.pnl).toBe(12.3457);
    expect(outcome.recordedAt).toBeInstanceOf(Date);
  });
});

describe('新策略建议契约', () => {
  const analysis = {
    decision: 'watch',
    confidence: 60,
    horizon: 'short',
    reasoning: {
      premise: '观察条件',
      evidence: ['价格突破'],
      counterEvidence: ['成交不足'],
    },
    risks: ['波动较高'],
  };
  it('允许无价位观察，拒绝缺少反证或不成立的买入价格计划', () => {
    expect(StrategyAdviceAnalysisSchema.safeParse(analysis).success).toBe(true);
    for (const invalid of [
      { ...analysis, decision: 'buy' },
      { ...analysis, risks: [] },
      { ...analysis, reasoning: { ...analysis.reasoning, counterEvidence: ['  '] } },
      { ...analysis, entryPrice: 10, targetPrice: 12, stopLoss: 10.000001 },
      { ...analysis, entryPrice: 10, targetPrice: 10.000001, stopLoss: 9 },
    ])
      expect(StrategyAdviceAnalysisSchema.safeParse(invalid).success).toBe(false);
  });
  it('买入必须给出落在入场区间内的代表性买点和目标仓位', () => {
    const buy = {
      ...analysis,
      decision: 'buy',
      entryPrice: 102,
      entryPriceLow: 100,
      entryPriceHigh: 105,
      targetPositionPct: 10,
      targetPrice: 120,
      stopLoss: 95,
    };
    expect(StrategyAdviceAnalysisSchema.safeParse(buy).success).toBe(true);
    for (const invalid of [
      { ...buy, entryPrice: 99 },
      { ...buy, entryPrice: 106 },
      { ...buy, targetPositionPct: undefined },
      { ...buy, entryPriceLow: undefined },
      { ...buy, entryPriceHigh: 99 },
    ])
      expect(StrategyAdviceAnalysisSchema.safeParse(invalid).success).toBe(false);
  });
  it.each([
    ['盘中及时', '2026-09-02T10:00:00+08:00', '2026-09-02T09:58:00+08:00', 'quote', true],
    ['盘中过时', '2026-09-02T10:00:00+08:00', '2026-09-02T09:56:00+08:00', 'quote', false],
    ['未来报价', '2026-09-02T10:00:00+08:00', '2026-09-02T10:01:00+08:00', 'quote', false],
    ['午休收盘', '2026-09-02T12:30:00+08:00', '2026-09-02T11:30:00+08:00', 'quote', true],
    ['夜间收盘', '2026-09-02T18:30:00+08:00', '2026-09-02T15:00:00+08:00', 'quote', true],
    ['周末最近交易日', '2026-09-06T12:30:00+08:00', '2026-09-04T15:00:00+08:00', 'quote', true],
    ['盘前前一交易日', '2026-09-07T09:20:00+08:00', '2026-09-04T15:00:00+08:00', 'quote', true],
    [
      '过旧日线',
      '2026-09-07T18:30:00+08:00',
      '2026-09-04T00:00:00Z',
      'daily-bar-fallback:fixture',
      false,
    ],
    [
      '当前日线',
      '2026-09-07T18:30:00+08:00',
      '2026-09-07T00:00:00Z',
      'daily-bar-fallback:fixture',
      true,
    ],
    [
      '盘中日线不能冒充实时',
      '2026-09-07T10:00:00+08:00',
      '2026-09-07T00:00:00Z',
      'daily-bar-fallback:fixture',
      false,
    ],
  ])('%s', (_name, now, observedAt, source, expected) => {
    const quote = QuoteSchema.parse({
      stockId: 'fixture',
      ts: observedAt,
      open: 10,
      high: 10,
      low: 10,
      close: 10,
      volume: 1,
      source,
    });
    expect(isAdviceQuoteCurrent(quote, new Date(now))).toBe(expected);
  });
});

describe('adviceDataSnapshotFromFacts', () => {
  const dataAsOf = new Date('2026-10-29T10:00:00.000Z');
  const quote = {
    stockId: '600519.SH',
    ts: '2026-10-29T10:00:00.000Z',
    observedAt: '2026-10-29T10:00:00.000Z',
    fetchedAt: '2026-10-29T10:00:00.000Z',
    timestampSource: 'upstream',
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 1000,
    source: 'fixture',
  };
  const strategy = {
    strategyId: 'strategy-1',
    strategyVersionId: 'strategy-1-v1',
    runId: 'run-1',
    stockId: '600519.SH',
    accountId: 'default-account',
    score: 88,
    rank: 2,
    resultEvidence: ['放量突破'],
    signalIds: ['signal-1'],
    observationIds: [],
    recommendationTrigger: 'run',
  };

  it('从冻结事实还原行情与策略运行证据', () => {
    const snapshot = adviceDataSnapshotFromFacts(
      [
        { id: 'quote:600519.SH', value: quote },
        { id: 'strategy-run:run-1:600519.SH', value: strategy },
      ],
      dataAsOf,
    );
    expect(snapshot.quotes?.['600519.SH']?.close).toBe(10.5);
    expect(snapshot.strategy).toMatchObject({
      runId: 'run-1',
      accountId: 'default-account',
      score: 88,
      rank: 2,
      recommendationTrigger: 'run',
    });
    expect(snapshot.dataAsOf).toEqual(dataAsOf);
  });

  it('没有可还原事实时只保留 dataAsOf', () => {
    const snapshot = adviceDataSnapshotFromFacts([], dataAsOf);
    expect(snapshot.quotes).toBeUndefined();
    expect(snapshot.strategy).toBeUndefined();
    expect(snapshot.dataAsOf).toEqual(dataAsOf);
  });

  it('忽略形状不合法的事实，不抛错', () => {
    const snapshot = adviceDataSnapshotFromFacts(
      [
        { id: 'quote:600519.SH', value: { stockId: '600519.SH' } },
        { id: 'strategy-run:run-1:600519.SH', value: { runId: 'run-1' } },
      ],
      dataAsOf,
    );
    expect(snapshot.quotes).toBeUndefined();
    expect(snapshot.strategy).toBeUndefined();
  });
});

describe('isRuleFallbackAdvice', () => {
  const reasoning = (premise: string, evidence: readonly string[]) => ({
    reasoning: { premise, evidence, counterEvidence: [] },
  });

  it('只带 premise 标记（evidence 无标记）的存量建议仍判为规则兜底', () => {
    // 历史生成器写 premise: `${RULE_FALLBACK_PREMISE_MARKER}，基于规则的保守判断`；
    // 存量行的 evidence 可能为空或被截断，此时只有 premise 能证明它是规则兜底。
    expect(
      isRuleFallbackAdvice(reasoning('LLM 推理不可用，基于规则的保守判断', ['日线 MA5 上穿 MA20'])),
    ).toBe(true);
    expect(isRuleFallbackAdvice(reasoning('LLM 推理不可用，基于规则的保守判断', []))).toBe(true);
  });

  it('只有 evidence 标记时同样判为规则兜底', () => {
    expect(
      isRuleFallbackAdvice(reasoning('箱体震荡，等待方向选择', ['规则 fallback：MA20 上穿'])),
    ).toBe(true);
  });

  it('两条标记都不存在时视为研究结论', () => {
    expect(isRuleFallbackAdvice(reasoning('箱体震荡，等待方向选择', ['日线 MA5 上穿 MA20']))).toBe(
      false,
    );
  });
});

describe('T29 Advice 目标仓位区间', () => {
  const base = {
    decision: 'buy' as const,
    confidence: 70,
    horizon: 'short' as const,
    entryPrice: 100,
    entryPriceLow: 98,
    entryPriceHigh: 102,
    targetPrice: 120,
    stopLoss: 95,
    reasoning: {
      premise: '趋势保持',
      evidence: ['均线向上'],
      counterEvidence: ['量能不足'],
    },
    risks: ['波动'],
  };

  it('买入可只给区间（不再强制单值）', () => {
    const parsed = StrategyAdviceAnalysisSchema.parse({
      ...base,
      targetPositionPctRange: { min: 8, max: 12 },
    });
    expect(parsed.targetPositionPctRange).toEqual({ min: 8, max: 12 });
  });

  it('单值与区间同时存在时，单值必须落在区间内', () => {
    expect(
      StrategyAdviceAnalysisSchema.safeParse({
        ...base,
        targetPositionPct: 10,
        targetPositionPctRange: { min: 8, max: 12 },
      }).success,
    ).toBe(true);
    expect(
      StrategyAdviceAnalysisSchema.safeParse({
        ...base,
        targetPositionPct: 15,
        targetPositionPctRange: { min: 8, max: 12 },
      }).success,
    ).toBe(false);
  });

  it('区间 min 不能大于 max；通知按区间展示', () => {
    expect(
      StrategyAdviceAnalysisSchema.safeParse({
        ...base,
        targetPositionPctRange: { min: 12, max: 8 },
      }).success,
    ).toBe(false);
    const advice = AdviceSchema.parse({
      id: 'advice-range',
      subjectKind: 'stock',
      subjectId: '600519.SH',
      ...base,
      targetPositionPctRange: { min: 8, max: 12 },
      disclaimers: [...STANDARD_DISCLAIMERS],
      basedOn: { dataAsOf: new Date(NOW_ISO) },
      validFrom: new Date(NOW_ISO),
      validUntil: new Date('2026-07-20T02:00:00.000Z'),
      createdAt: new Date(NOW_ISO),
    });
    expect(adviceNotificationSummary(advice)).toContain('目标仓位 8.0–12.0%');
  });
});
