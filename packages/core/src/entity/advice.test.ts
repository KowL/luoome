import { describe, expect, it } from 'vitest';

import {
  AdviceOutcomeSchema,
  AdviceQuerySchema,
  AdviceSchema,
  isAdviceQuoteCurrent,
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
