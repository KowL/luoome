import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import { assertStockBriefInvariants, type StockBrief, StockBriefSchema } from './stock-brief.js';

const NOW = new Date('2026-11-24T01:30:00.000Z');

const validBrief = (overrides: Record<string, unknown> = {}): StockBrief =>
  StockBriefSchema.parse({
    id: 'brief-1',
    tradingDate: '2026-11-24',
    phase: 'post-market',
    accountId: 'acc-1',
    stockId: '600519.SH',
    source: 'scheduled',
    decision: 'hold',
    confidence: 20,
    horizon: 'short',
    quality: 'rule-only',
    factDigest: 'digest-1',
    factsAsOf: NOW,
    missing: [],
    dataSources: ['eastmoney'],
    validUntil: new Date('2026-11-27T07:00:00.000Z'),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

describe('assertStockBriefInvariants', () => {
  it('passes a deterministic rule-only brief', () => {
    expect(() => assertStockBriefInvariants(validBrief())).not.toThrow();
  });

  it('rejects ai brief without adviceId', () => {
    const brief = validBrief({ quality: 'ai', decision: 'hold', adviceId: undefined });
    expect(() => assertStockBriefInvariants(brief)).toThrow(InvariantError);
    expect(() => assertStockBriefInvariants(brief)).toThrow(/requires adviceId/);
  });

  it('accepts ai brief with adviceId', () => {
    const brief = validBrief({ quality: 'ai', decision: 'buy', adviceId: 'advice-1' });
    expect(() => assertStockBriefInvariants(brief)).not.toThrow();
  });

  it('rejects rule-only buy and sell decisions', () => {
    for (const decision of ['buy', 'sell'] as const) {
      const brief = validBrief({ quality: 'rule-only', decision });
      expect(() => assertStockBriefInvariants(brief)).toThrow(InvariantError);
    }
  });

  it('rejects rule-only brief that references an adviceId', () => {
    const brief = validBrief({ quality: 'rule-only', adviceId: 'advice-1' });
    expect(() => assertStockBriefInvariants(brief)).toThrow(/must not reference/);
  });

  it('rejects negative LLM counters', () => {
    expect(() => assertStockBriefInvariants(validBrief({ llmHttpCalls: -1 }))).toThrow(
      /llmHttpCalls/,
    );
    expect(() => assertStockBriefInvariants(validBrief({ llmPromptTokens: -1 }))).toThrow(
      /llmPromptTokens/,
    );
    expect(() => assertStockBriefInvariants(validBrief({ llmCostUsd: -0.01 }))).toThrow(
      /llmCostUsd/,
    );
  });

  it('requires dimension and reason on every missing entry', () => {
    const brief = {
      ...validBrief(),
      missing: [{ dimension: 'quote', reason: '   ' }],
    } as StockBrief;
    expect(() => assertStockBriefInvariants(brief)).toThrow(/requires reason/);
  });
});
