import { type FinancialFact, FinancialFactSchema, financialFactContentHash } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import {
  createMockFundamentalFacts,
  MOCK_FUNDAMENTAL_ADAPTER_NAME,
  MOCK_FUNDAMENTAL_SOURCE,
  MockFundamentalDataAdapter,
} from './mock.js';

describe('MockFundamentalDataAdapter', () => {
  it('is explicit, source-identifiable, and permanently not-ready', async () => {
    const adapter = new MockFundamentalDataAdapter();
    const result = await adapter.fetchFinancialFactRevisions({ stockIds: ['600000.SH'] });

    expect(adapter.name).toBe(MOCK_FUNDAMENTAL_ADAPTER_NAME);
    expect(adapter.source).toBe(MOCK_FUNDAMENTAL_SOURCE);
    expect(adapter.gateStatus).toBe('not-ready');
    expect(adapter.gate.status).toBe('not-ready');
    expect(result).toMatchObject({
      source: MOCK_FUNDAMENTAL_SOURCE,
      gateStatus: 'not-ready',
      gate: {
        name: 'fundamental-data-gate-v1',
        status: 'not-ready',
      },
    });
    expect('fetchQuote' in adapter).toBe(false);
  });

  it('returns deterministic multi-revision rows with raw/canonical provenance', async () => {
    const first = new MockFundamentalDataAdapter();
    const second = new MockFundamentalDataAdapter();
    const input = { stockIds: ['600000.SH'], metricIds: ['roe'] };

    const firstResult = await first.fetchFinancialFactRevisions(input);
    const secondResult = await second.fetchFinancialFactRevisions(input);

    expect(firstResult).toEqual(secondResult);
    expect(firstResult.issues).toEqual([]);
    expect(firstResult.revisions.map((fact) => fact.id)).toEqual([
      'mock-600000-roe-2023-r1',
      'mock-600000-roe-2023-r2',
    ]);
    expect(firstResult.revisions).toMatchObject([
      {
        source: MOCK_FUNDAMENTAL_SOURCE,
        sourceRecordId: 'mock-report-600000-2023',
        sourceRevision: 'r1',
        status: 'reported',
        rawValue: 0.1,
        rawUnit: 'ratio',
        value: 10,
        canonicalUnit: 'percent-points',
        publishedAt: new Date('2024-03-30T00:00:00.000Z'),
        revisionPublishedAt: new Date('2024-03-30T00:00:00.000Z'),
      },
      {
        sourceRevision: 'r2',
        status: 'restated',
        supersedesId: 'mock-600000-roe-2023-r1',
        rawValue: 0.12,
        value: 12,
        publishedAt: new Date('2024-03-30T00:00:00.000Z'),
        revisionPublishedAt: new Date('2024-07-01T00:00:00.000Z'),
      },
    ]);
    for (const fact of firstResult.revisions) {
      expect(FinancialFactSchema.parse(fact)).toEqual(fact);
      expect(fact.contentHash).toBe(financialFactContentHash(fact));
    }
  });

  it('keeps retracted revisions in the source batch instead of resolving them away', async () => {
    const adapter = new MockFundamentalDataAdapter();
    const result = await adapter.fetchFinancialFactRevisions({
      stockIds: ['000001.SZ'],
      metricIds: ['roe'],
    });

    expect(result.revisions.map((fact) => fact.status)).toEqual(['reported', 'retracted']);
    expect(result.revisions.at(-1)).toMatchObject({
      sourceRevision: 'r2-retracted',
      status: 'retracted',
      supersedesId: 'mock-000001-roe-2023-r1',
      sourceRecordId: 'mock-report-000001-2023',
      publishedAt: new Date('2024-03-30T00:00:00.000Z'),
      revisionPublishedAt: new Date('2024-08-01T00:00:00.000Z'),
    });
  });

  it('returns structured issues for invalid and uncovered requests', async () => {
    const adapter = new MockFundamentalDataAdapter();
    const result = await adapter.fetchFinancialFactRevisions({
      stockIds: ['999999.SH'],
      metricIds: ['roe'],
      periodFrom: new Date('2025-01-01T00:00:00.000Z'),
      periodTo: new Date('2024-01-01T00:00:00.000Z'),
    });

    expect(result.revisions).toEqual([]);
    expect(result.issues).toEqual([
      expect.objectContaining({
        source: MOCK_FUNDAMENTAL_SOURCE,
        reason: 'invalid-payload',
        message: 'periodFrom 不能晚于 periodTo',
      }),
      expect.objectContaining({
        stockId: '999999.SH',
        metricId: 'roe',
        reason: 'not-covered',
      }),
    ]);
    expect(result.issues.every((item) => item.observedAt instanceof Date)).toBe(true);
  });

  it('rejects injected rows that could blur the mock source boundary', () => {
    const fixture = createMockFundamentalFacts()[0] as FinancialFact;
    expect(
      () =>
        new MockFundamentalDataAdapter({
          facts: [{ ...fixture, source: 'tushare' }],
        }),
    ).toThrow(`mock fundamental fact source must be ${MOCK_FUNDAMENTAL_SOURCE}`);
  });
});
