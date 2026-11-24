import { describe, expect, it } from 'vitest';

import {
  ADVICE_RESEARCH_DISCLAIMER,
  AdviceOutcomeSchema,
  AdviceQuerySchema,
  AdviceSchema,
  adviceDecisionDisplay,
  adviceNotificationSummary,
  advicePriceDisplay,
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

describe('design §12.2 展示层文案', () => {
  const adviceFixture = (overrides: Record<string, unknown> = {}) =>
    AdviceSchema.parse({
      id: 'adv-display',
      subjectKind: 'stock',
      subjectId: '600519.SH',
      decision: 'buy',
      confidence: 65,
      horizon: 'short',
      entryPriceLow: 98,
      entryPriceHigh: 103,
      entryPrice: 100,
      stopLoss: 95,
      targetPrice: 112,
      targetPositionPct: 10,
      reasoning: {
        premise: '偏多条件成立',
        evidence: ['放量突破'],
        counterEvidence: ['跌破风险位则失效'],
      },
      risks: ['回撤风险'],
      disclaimers: [...STANDARD_DISCLAIMERS],
      basedOn: { dataAsOf: NOW_ISO },
      validFrom: NOW_ISO,
      validUntil: '2026-07-22T02:00:00.000Z',
      createdAt: NOW_ISO,
      ...overrides,
    });

  it('decision 只在展示层映射为信号词表，枚举值不变', () => {
    expect(adviceDecisionDisplay('buy')).toBe('偏多信号');
    expect(adviceDecisionDisplay('sell')).toBe('偏空信号');
    expect(adviceDecisionDisplay('hold')).toBe('中性观察');
    expect(adviceDecisionDisplay('watch')).toBe('待确认观察');
    expect(adviceDecisionDisplay('avoid')).toBe('回避观察');
  });

  it('价格字段展示名不使用后端字段名或操作动词', () => {
    const lines = advicePriceDisplay(adviceFixture());
    expect(lines).toEqual([
      '观察区间 98.00–103.00',
      '风险位 95.00',
      '参考位 112.00',
      '仓位参考 10.0%（占账户总资产）',
    ]);
    expect(lines.join(' · ')).not.toMatch(/入场|买点|止损|目标|建仓|加仓|减仓|清仓|满仓/);
  });

  it('通知摘要使用信号词表、展示价格名，并带研究免责声明', () => {
    const summary = adviceNotificationSummary(adviceFixture());
    expect(summary).toContain('**偏多信号**');
    expect(summary).toContain('观察区间 98.00–103.00');
    expect(summary).toContain('风险位 95.00');
    expect(summary).toContain('参考位 112.00');
    expect(summary).toContain('仓位参考 10.0%（占账户总资产）');
    expect(summary).toContain(ADVICE_RESEARCH_DISCLAIMER);
    expect(summary).not.toMatch(/建议买入|建议卖出|建仓|加仓|减仓|清仓|满仓/);
  });

  it('规则兜底摘要是规则观察（低置信），并保留免责声明', () => {
    const summary = adviceNotificationSummary(
      adviceFixture({
        decision: 'hold',
        reasoning: {
          premise: 'LLM 推理不可用：规则 fallback',
          evidence: ['规则 fallback'],
          counterEvidence: [],
        },
      }),
    );
    expect(summary).toContain('规则观察（低置信）');
    expect(summary).toContain('仅技术研究，不构成投资建议');
  });

  it('标准免责声明包含「仅技术研究，不构成投资建议」', () => {
    expect(STANDARD_DISCLAIMERS.join('\n')).toContain('仅技术研究，不构成投资建议');
  });
});
