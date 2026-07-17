import { describe, expect, it } from 'vitest';

import { AdviceQuerySchema, AdviceSchema, STANDARD_DISCLAIMERS } from './advice.js';
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
      source: 'mock',
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
});
