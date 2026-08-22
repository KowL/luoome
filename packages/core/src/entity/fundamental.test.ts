import { describe, expect, it } from 'vitest';

import {
  assertFinancialFactInvariants,
  assertFinancialVintageInvariants,
  type FinancialFact,
  FinancialFactSchema,
  financialFactContentHash,
  financialVintageKey,
  resolveStrictPitFinancialVintage,
} from './fundamental.js';

const makeFact = (input: {
  readonly id: string;
  readonly stockId?: string;
  readonly metricId?: string;
  readonly value?: number;
  readonly sourceRevision?: string;
  readonly publishedAt?: string;
  readonly revisionPublishedAt?: string;
  readonly recordedAt?: string;
  readonly status?: 'reported' | 'restated' | 'retracted';
}): FinancialFact => {
  const fact = {
    id: input.id,
    stockId: input.stockId ?? '600000.SH',
    metricId: input.metricId ?? 'roe',
    periodType: 'annual' as const,
    periodStart: new Date('2023-01-01T00:00:00.000Z'),
    periodEnd: new Date('2023-12-31T00:00:00.000Z'),
    value: input.value ?? 10,
    canonicalUnit: 'percent-points' as const,
    source: 'fixture',
    sourceRecordId: `record-${input.id}`,
    sourceRevision: input.sourceRevision ?? input.id,
    publishedAt: new Date(input.publishedAt ?? '2024-03-01T00:00:00.000Z'),
    revisionPublishedAt: new Date(
      input.revisionPublishedAt ?? input.publishedAt ?? '2024-03-01T00:00:00.000Z',
    ),
    recordedAt: new Date(
      input.recordedAt ??
        input.revisionPublishedAt ??
        input.publishedAt ??
        '2024-03-01T00:00:00.000Z',
    ),
    status: input.status ?? ('reported' as const),
  };
  return {
    ...fact,
    contentHash: financialFactContentHash({ ...fact, contentHash: '0'.repeat(64) }),
  };
};

describe('FinancialFact / strict PIT vintage', () => {
  it('requires canonical units, ordered publication timestamps, and matching content hash', () => {
    const fact = makeFact({ id: 'fact-1' });
    expect(() => assertFinancialFactInvariants(fact)).not.toThrow();
    expect(FinancialFactSchema.parse(fact).contentHash).toBe(financialFactContentHash(fact));
    expect(() =>
      FinancialFactSchema.parse({
        ...fact,
        value: Number.NaN,
      }),
    ).toThrow();
    expect(() =>
      FinancialFactSchema.parse({
        ...fact,
        canonicalUnit: 'CNY',
        currency: undefined,
      }),
    ).toThrow();
    expect(() => assertFinancialFactInvariants({ ...fact, contentHash: 'a'.repeat(64) })).toThrow(
      /contentHash/,
    );
  });

  it('selects only eligible revisions and does not fall back after a visible retraction', () => {
    const first = makeFact({
      id: 'fact-r1',
      sourceRevision: 'r1',
      value: 10,
      publishedAt: '2024-03-01T00:00:00.000Z',
    });
    const restated = makeFact({
      id: 'fact-r2',
      sourceRevision: 'r2',
      value: 20,
      publishedAt: '2025-03-01T00:00:00.000Z',
      revisionPublishedAt: '2025-03-01T00:00:00.000Z',
      recordedAt: '2025-03-02T00:00:00.000Z',
      status: 'restated',
    });
    const retracted = makeFact({
      id: 'fact-r3',
      sourceRevision: 'r3',
      value: 20,
      publishedAt: '2026-01-01T00:00:00.000Z',
      revisionPublishedAt: '2026-01-01T00:00:00.000Z',
      recordedAt: '2026-01-01T00:00:00.000Z',
      status: 'retracted',
    });

    const beforeRestatement = resolveStrictPitFinancialVintage({
      stockIds: ['600000.SH'],
      metricIds: ['roe'],
      asOf: new Date('2024-12-31T23:59:59.000Z'),
      policy: 'strict-pit-v1',
      facts: [first, restated, retracted],
    });
    expect(beforeRestatement.status).toBe('complete');
    expect(beforeRestatement.facts.map((fact) => fact.id)).toEqual(['fact-r1']);
    expect(beforeRestatement.facts[0]?.value).toBe(10);

    const afterRetraction = resolveStrictPitFinancialVintage({
      stockIds: ['600000.SH'],
      metricIds: ['roe'],
      asOf: new Date('2026-02-01T00:00:00.000Z'),
      policy: 'strict-pit-v1',
      facts: [first, restated, retracted],
    });
    expect(afterRetraction.status).toBe('unavailable');
    expect(afterRetraction.facts).toEqual([]);
    expect(afterRetraction.missing).toMatchObject([
      {
        stockId: '600000.SH',
        metricId: 'roe',
        reason: 'retracted',
        revisionIds: ['fact-r3'],
      },
    ]);
    expect(afterRetraction.coverage.retracted).toBe(1);
    expect(() => assertFinancialVintageInvariants(afterRetraction)).not.toThrow();
  });

  it('distinguishes local recorded-after-cutoff from publication cutoff and hashes deterministically', () => {
    const lateRecorded = makeFact({
      id: 'fact-late',
      publishedAt: '2024-03-01T00:00:00.000Z',
      recordedAt: '2025-01-01T00:00:00.000Z',
    });
    const result = resolveStrictPitFinancialVintage({
      stockIds: ['600000.SH', '600001.SH'],
      metricIds: ['roe'],
      asOf: new Date('2024-12-31T23:59:59.000Z'),
      policy: 'strict-pit-v1',
      facts: [lateRecorded],
    });
    expect(result.status).toBe('unavailable');
    expect(result.missing).toEqual([
      {
        stockId: '600000.SH',
        metricId: 'roe',
        periodEnd: new Date('2023-12-31T00:00:00.000Z'),
        reason: 'recorded-after-cutoff',
      },
      { stockId: '600001.SH', metricId: 'roe', reason: 'not-covered' },
    ]);
    expect(result.vintageKey).toBe(
      financialVintageKey({
        policy: result.policy,
        asOf: result.asOf,
        selectedRevisionIds: [],
        missing: result.missing,
      }),
    );
  });

  it('rejects supersedes links that cross stock, metric, or period identity', () => {
    const original = makeFact({ id: 'fact-original' });
    const crossStock = makeFact({ id: 'fact-cross-stock', stockId: '600001.SH' });
    const linked = {
      ...crossStock,
      supersedesId: original.id,
      publishedAt: new Date('2025-03-01T00:00:00.000Z'),
      revisionPublishedAt: new Date('2025-03-01T00:00:00.000Z'),
      recordedAt: new Date('2025-03-02T00:00:00.000Z'),
    };
    const crossStockWithHash = {
      ...linked,
      contentHash: financialFactContentHash({ ...linked, contentHash: '0'.repeat(64) }),
    };
    expect(() =>
      resolveStrictPitFinancialVintage({
        stockIds: ['600001.SH'],
        metricIds: ['roe'],
        asOf: new Date('2025-12-31T00:00:00.000Z'),
        policy: 'strict-pit-v1',
        facts: [original, crossStockWithHash],
      }),
    ).toThrow(/同 stock\/metric\/period/);
  });
});
