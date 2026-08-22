import { describe, expect, it } from 'vitest';

import { type FinancialFact, financialFactContentHash } from '../entity/fundamental.js';
import {
  assertFactorRegistryInvariants,
  assertFundamentalScoreVersionInvariants,
  evaluateFundamentalFactor,
  type FactorDefinition,
  FUNDAMENTAL_FACTOR_REGISTRY_HASH,
  FUNDAMENTAL_FACTOR_REGISTRY_V1,
  type FundamentalFactorObservation,
  type FundamentalScoreVersion,
  fundamentalFactorRegistryHash,
  fundamentalScoreVersionDefinitionHash,
  getFundamentalFactor,
  normalizeFundamentalFactor,
  percentileRank,
  runFundamentalScore,
} from './fundamental-factor.js';

const observation = (
  stockId: string,
  factorId: string,
  rawValue: number,
  industryKey?: string,
): FundamentalFactorObservation => {
  const factor = getFundamentalFactor(factorId);
  if (factor === undefined) throw new Error(`unknown test factor ${factorId}`);
  return {
    stockId,
    factorId,
    rawValue,
    unit: factor.outputUnit,
    direction: factor.direction,
    sourceRevisionIds: [`${stockId}-${factorId}`],
    ...(industryKey === undefined ? {} : { industryKey }),
  };
};

const fact = (input: {
  readonly id: string;
  readonly metricId: string;
  readonly value: number;
  readonly canonicalUnit: FinancialFact['canonicalUnit'];
  readonly currency?: 'CNY';
}): FinancialFact => {
  const base = {
    id: input.id,
    stockId: '600000.SH',
    metricId: input.metricId,
    periodType: 'annual' as const,
    periodStart: new Date('2023-01-01T00:00:00.000Z'),
    periodEnd: new Date('2023-12-31T00:00:00.000Z'),
    value: input.value,
    canonicalUnit: input.canonicalUnit,
    ...(input.currency === undefined ? {} : { currency: input.currency }),
    source: 'fixture',
    sourceRecordId: `record-${input.id}`,
    sourceRevision: input.id,
    publishedAt: new Date('2024-03-01T00:00:00.000Z'),
    revisionPublishedAt: new Date('2024-03-01T00:00:00.000Z'),
    recordedAt: new Date('2024-03-02T00:00:00.000Z'),
    status: 'reported' as const,
  };
  return {
    ...base,
    contentHash: financialFactContentHash({ ...base, contentHash: '0'.repeat(64) }),
  };
};

const scoreVersion = (): FundamentalScoreVersion => {
  const draft = {
    id: 'fundamental-score-v1',
    version: 1,
    registryVersion: 'fundamental-factor-registry-v1',
    registryHash: FUNDAMENTAL_FACTOR_REGISTRY_HASH,
    normalizationVersion: 'fundamental-normalization-v1' as const,
    components: [
      {
        factorId: 'fundamental.profitability.roe',
        weight: 0.5,
        normalizer: 'market-percentile-v1' as const,
      },
      {
        factorId: 'fundamental.valuation.pe',
        weight: 0.5,
        normalizer: 'market-percentile-v1' as const,
      },
    ],
    missingPolicy: 'unknown' as const,
    rounding: 'round-to-6-decimal' as const,
    definitionHash: '0'.repeat(64),
    status: 'published' as const,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    publishedAt: new Date('2026-01-02T00:00:00.000Z'),
  } satisfies FundamentalScoreVersion;
  return { ...draft, definitionHash: fundamentalScoreVersionDefinitionHash(draft) };
};

describe('fundamental factor registry and deterministic score engine', () => {
  it('has a stable registry hash and rejects unknown source/compute/unit contracts', () => {
    expect(fundamentalFactorRegistryHash(FUNDAMENTAL_FACTOR_REGISTRY_V1)).toBe(
      FUNDAMENTAL_FACTOR_REGISTRY_HASH,
    );
    expect(() =>
      assertFactorRegistryInvariants([
        {
          ...(FUNDAMENTAL_FACTOR_REGISTRY_V1[0] as FactorDefinition),
          sourceMetricIds: ['vendor-private-metric'],
        },
      ]),
    ).toThrow(/未知 source metric/);
    expect(() =>
      assertFactorRegistryInvariants([
        {
          ...(FUNDAMENTAL_FACTOR_REGISTRY_V1[0] as FactorDefinition),
          computeId: 'arbitrary-code',
        },
      ]),
    ).toThrow(/computeId/);
    expect(() =>
      assertFactorRegistryInvariants([
        {
          ...(FUNDAMENTAL_FACTOR_REGISTRY_V1[0] as FactorDefinition),
          outputUnit: 'ratio',
        },
      ]),
    ).toThrow(/outputUnit/);
  });

  it('computes a registered derived factor only from aligned periods and explicit units', () => {
    const evaluated = evaluateFundamentalFactor({
      stockId: '600000.SH',
      factor: 'fundamental.quality.ocf-margin',
      facts: [
        fact({
          id: 'ocf-1',
          metricId: 'operating-cashflow',
          value: 100,
          canonicalUnit: 'CNY',
          currency: 'CNY',
        }),
        fact({
          id: 'revenue-1',
          metricId: 'revenue',
          value: 1000,
          canonicalUnit: 'CNY',
          currency: 'CNY',
        }),
      ],
    });
    expect(evaluated).toMatchObject({
      factorId: 'fundamental.quality.ocf-margin',
      rawValue: 10,
      unit: 'percent-points',
    });
  });

  it('implements tie-aware market/industry percentile without zero fallback', () => {
    const factorId = 'fundamental.profitability.roe';
    expect(
      percentileRank(
        'tie-a',
        10,
        [
          { stockId: 'tie-a', rawValue: 10 },
          { stockId: 'tie-b', rawValue: 10 },
          { stockId: 'tie-c', rawValue: 30 },
        ],
        'higher',
      ),
    ).toBe(25);
    const marketObservations = [
      10,
      10,
      30,
      ...Array.from({ length: 17 }, (_, index) => 40 + index),
    ].map((rawValue, index) =>
      observation(`600${String(index).padStart(3, '0')}.SH`, factorId, rawValue),
    );
    const market = normalizeFundamentalFactor({
      factor: factorId,
      normalizer: 'market-percentile-v1',
      observations: marketObservations,
    });
    expect(market).toHaveLength(20);
    expect(market[0]).toMatchObject({ sampleSize: 20 });
    expect(market.every((value) => value.normalizedValue !== undefined)).toBe(true);

    const industryObservations = [
      ...[10, 20, ...Array.from({ length: 18 }, (_, index) => 30 + index)].map((rawValue, index) =>
        observation(`601${String(index).padStart(3, '0')}.SH`, factorId, rawValue, 'bank'),
      ),
      observation('609999.SH', factorId, 30),
    ];
    const industry = normalizeFundamentalFactor({
      factor: factorId,
      normalizer: 'industry-percentile-v1',
      observations: industryObservations,
    });
    expect(industry[0]).toMatchObject({
      stockId: '601000.SH',
      normalizedValue: 0,
      groupKey: 'industry:bank',
    });
    expect(industry.at(-1)).toMatchObject({ stockId: '609999.SH', missingReason: 'group-missing' });
  });

  it('freezes score definition hash and leaves missing stocks unscored', () => {
    const version = scoreVersion();
    expect(() => assertFundamentalScoreVersionInvariants(version)).not.toThrow();
    const scoreStockIds = Array.from(
      { length: 21 },
      (_, index) => `602${String(index).padStart(3, '0')}.SH`,
    );
    const scoreObservations = scoreStockIds.flatMap((stockId, index) => {
      if (index === 2) return [observation(stockId, 'fundamental.profitability.roe', 12)];
      return [
        observation(stockId, 'fundamental.profitability.roe', 10 + index),
        observation(stockId, 'fundamental.valuation.pe', 20 - index),
      ];
    });
    const score = runFundamentalScore({
      scoreRunId: 'score-run-1',
      scoreVersion: version,
      stockIds: scoreStockIds,
      observations: scoreObservations,
      dataAsOf: new Date('2026-01-03T00:00:00.000Z'),
      vintageKey: 'a'.repeat(64),
    });

    expect(score.status).toBe('partial');
    expect(score.counts).toEqual({ evaluated: 21, available: 20, missing: 1, excluded: 0 });
    const lowest = score.results.find((result) => result.stockId === '602000.SH');
    const missing = score.results.find((result) => result.stockId === '602002.SH');
    expect(lowest).toMatchObject({ status: 'available', score: 0, rank: 20 });
    expect(score.results.find((result) => result.stockId === '602020.SH')).toMatchObject({
      status: 'available',
      score: 100,
      rank: 1,
    });
    expect(missing).toMatchObject({ status: 'missing' });
    expect(missing?.components).toEqual(
      expect.arrayContaining([expect.objectContaining({ missingReason: 'no-eligible-vintage' })]),
    );
    expect(lowest?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ factorId: 'fundamental.profitability.roe', contribution: 0 }),
        expect.objectContaining({ factorId: 'fundamental.valuation.pe', contribution: 0 }),
      ]),
    );
  });
});
