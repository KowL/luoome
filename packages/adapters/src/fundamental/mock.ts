import type {
  FinancialFact,
  FundamentalDataAdapterLike,
  FundamentalDataAdapterResult,
  FundamentalDataGate,
  FundamentalDataQuery,
  FundamentalIngestionIssue,
} from '@luoome/core';
import {
  assertFinancialFactInvariants,
  FinancialFactSchema,
  financialFactContentHash,
} from '@luoome/core';

export const MOCK_FUNDAMENTAL_ADAPTER_NAME = 'mock-fundamental' as const;
export const MOCK_FUNDAMENTAL_SOURCE = 'mock-fundamental-pit-fixture' as const;

const MOCK_GATE_EVALUATED_AT = new Date('2026-01-01T00:00:00.000Z');
const MOCK_OBSERVED_AT = new Date('2026-01-01T00:00:00.000Z');
const ZERO_HASH = '0'.repeat(64);

const date = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

type MockFactSeed = Omit<FinancialFact, 'contentHash'>;

const makeFact = (seed: MockFactSeed): FinancialFact => {
  const candidate = { ...seed, contentHash: ZERO_HASH } as FinancialFact;
  const fact = FinancialFactSchema.parse({
    ...candidate,
    contentHash: financialFactContentHash(candidate),
  });
  assertFinancialFactInvariants(fact);
  return fact;
};

/**
 * Deterministic fixture rows for resolver/adapter contract tests. The source
 * deliberately identifies itself as mock and never represents real provider
 * evidence or an operational data gate.
 */
export const createMockFundamentalFacts = (): readonly FinancialFact[] => [
  makeFact({
    id: 'mock-600000-roe-2023-r1',
    stockId: '600000.SH',
    metricId: 'roe',
    periodType: 'annual',
    periodStart: date('2023-01-01'),
    periodEnd: date('2023-12-31'),
    value: 10,
    canonicalUnit: 'percent-points',
    rawValue: 0.1,
    rawUnit: 'ratio',
    source: MOCK_FUNDAMENTAL_SOURCE,
    sourceRecordId: 'mock-report-600000-2023',
    sourceRevision: 'r1',
    publishedAt: date('2024-03-30'),
    revisionPublishedAt: date('2024-03-30'),
    recordedAt: date('2024-03-31'),
    status: 'reported',
    industryKey: 'mock-finance',
  }),
  makeFact({
    id: 'mock-600000-roe-2023-r2',
    stockId: '600000.SH',
    metricId: 'roe',
    periodType: 'annual',
    periodStart: date('2023-01-01'),
    periodEnd: date('2023-12-31'),
    value: 12,
    canonicalUnit: 'percent-points',
    rawValue: 0.12,
    rawUnit: 'ratio',
    source: MOCK_FUNDAMENTAL_SOURCE,
    sourceRecordId: 'mock-report-600000-2023',
    sourceRevision: 'r2',
    publishedAt: date('2024-03-30'),
    revisionPublishedAt: date('2024-07-01'),
    recordedAt: date('2024-07-02'),
    status: 'restated',
    supersedesId: 'mock-600000-roe-2023-r1',
    industryKey: 'mock-finance',
  }),
  makeFact({
    id: 'mock-000001-roe-2023-r1',
    stockId: '000001.SZ',
    metricId: 'roe',
    periodType: 'annual',
    periodStart: date('2023-01-01'),
    periodEnd: date('2023-12-31'),
    value: 8,
    canonicalUnit: 'percent-points',
    rawValue: 0.08,
    rawUnit: 'ratio',
    source: MOCK_FUNDAMENTAL_SOURCE,
    sourceRecordId: 'mock-report-000001-2023',
    sourceRevision: 'r1',
    publishedAt: date('2024-03-30'),
    revisionPublishedAt: date('2024-03-30'),
    recordedAt: date('2024-03-31'),
    status: 'reported',
    industryKey: 'mock-finance',
  }),
  makeFact({
    id: 'mock-000001-roe-2023-r2-retracted',
    stockId: '000001.SZ',
    metricId: 'roe',
    periodType: 'annual',
    periodStart: date('2023-01-01'),
    periodEnd: date('2023-12-31'),
    value: 8,
    canonicalUnit: 'percent-points',
    rawValue: 0.08,
    rawUnit: 'ratio',
    source: MOCK_FUNDAMENTAL_SOURCE,
    sourceRecordId: 'mock-report-000001-2023',
    sourceRevision: 'r2-retracted',
    publishedAt: date('2024-03-30'),
    revisionPublishedAt: date('2024-08-01'),
    recordedAt: date('2024-08-02'),
    status: 'retracted',
    supersedesId: 'mock-000001-roe-2023-r1',
    industryKey: 'mock-finance',
  }),
  makeFact({
    id: 'mock-600000-revenue-2023-r1',
    stockId: '600000.SH',
    metricId: 'revenue',
    periodType: 'annual',
    periodStart: date('2023-01-01'),
    periodEnd: date('2023-12-31'),
    value: 100_000_000,
    canonicalUnit: 'CNY',
    currency: 'CNY',
    rawValue: 100,
    rawUnit: 'CNY-million',
    source: MOCK_FUNDAMENTAL_SOURCE,
    sourceRecordId: 'mock-report-600000-2023',
    sourceRevision: 'r1',
    publishedAt: date('2024-03-30'),
    revisionPublishedAt: date('2024-03-30'),
    recordedAt: date('2024-03-31'),
    status: 'reported',
    industryKey: 'mock-finance',
  }),
  makeFact({
    id: 'mock-000001-pe-2024-q2-r1',
    stockId: '000001.SZ',
    metricId: 'pe',
    periodType: 'quarter',
    periodStart: date('2024-04-01'),
    periodEnd: date('2024-06-30'),
    value: 15,
    canonicalUnit: 'ratio',
    source: MOCK_FUNDAMENTAL_SOURCE,
    sourceRecordId: 'mock-report-000001-2024-q2',
    sourceRevision: 'r1',
    publishedAt: date('2024-08-30'),
    revisionPublishedAt: date('2024-08-30'),
    recordedAt: date('2024-08-31'),
    status: 'reported',
    industryKey: 'mock-finance',
  }),
];

export interface MockFundamentalDataAdapterOptions {
  /** Optional injected rows for deterministic contract tests; all must stay mock-sourced. */
  readonly facts?: readonly FinancialFact[];
}

const cloneDate = (value: Date): Date => new Date(value.getTime());

const cloneFact = (fact: FinancialFact): FinancialFact =>
  FinancialFactSchema.parse({
    ...fact,
    ...(fact.periodStart === undefined ? {} : { periodStart: cloneDate(fact.periodStart) }),
    periodEnd: cloneDate(fact.periodEnd),
    publishedAt: cloneDate(fact.publishedAt),
    revisionPublishedAt: cloneDate(fact.revisionPublishedAt),
    recordedAt: cloneDate(fact.recordedAt),
  });

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareFacts = (left: FinancialFact, right: FinancialFact): number =>
  compareStrings(left.stockId, right.stockId) ||
  compareStrings(left.metricId, right.metricId) ||
  left.periodEnd.getTime() - right.periodEnd.getTime() ||
  left.revisionPublishedAt.getTime() - right.revisionPublishedAt.getTime() ||
  compareStrings(left.sourceRevision, right.sourceRevision) ||
  compareStrings(left.id, right.id);

const makeGate = (): FundamentalDataGate => ({
  name: 'fundamental-data-gate-v1',
  status: 'not-ready',
  reasons: ['mock-fixture-is-not-real-provider-evidence'],
  evaluatedAt: cloneDate(MOCK_GATE_EVALUATED_AT),
});

const issue = (
  input: Pick<FundamentalIngestionIssue, 'reason' | 'message'> &
    Partial<Pick<FundamentalIngestionIssue, 'stockId' | 'metricId'>>,
): FundamentalIngestionIssue => ({
  source: MOCK_FUNDAMENTAL_SOURCE,
  observedAt: cloneDate(MOCK_OBSERVED_AT),
  ...input,
});

/**
 * Explicit-only mock source for core/adapter contract tests. It is never
 * discovered from env and is intentionally permanently `not-ready`.
 */
export class MockFundamentalDataAdapter implements FundamentalDataAdapterLike {
  readonly name = MOCK_FUNDAMENTAL_ADAPTER_NAME;
  readonly source = MOCK_FUNDAMENTAL_SOURCE;
  readonly gateStatus = 'not-ready' as const;
  readonly gate = makeGate();

  private readonly facts: readonly FinancialFact[];

  constructor(options: MockFundamentalDataAdapterOptions = {}) {
    const facts = options.facts ?? createMockFundamentalFacts();
    const parsed = facts.map((fact) => {
      const row = FinancialFactSchema.parse(fact);
      if (row.source !== MOCK_FUNDAMENTAL_SOURCE) {
        throw new Error(`mock fundamental fact source must be ${MOCK_FUNDAMENTAL_SOURCE}`);
      }
      assertFinancialFactInvariants(row);
      return cloneFact(row);
    });
    this.facts = [...parsed].sort(compareFacts);
  }

  async fetchFinancialFactRevisions(
    input: FundamentalDataQuery,
  ): Promise<FundamentalDataAdapterResult> {
    const requestedStocks = [...new Set(input.stockIds)];
    const requestedMetrics =
      input.metricIds === undefined ? undefined : [...new Set(input.metricIds)];
    const issues: FundamentalIngestionIssue[] = [];

    if (requestedStocks.length === 0) {
      issues.push(issue({ reason: 'invalid-payload', message: 'stockIds 不能为空' }));
    }
    if (
      input.periodFrom !== undefined &&
      input.periodTo !== undefined &&
      input.periodFrom > input.periodTo
    ) {
      issues.push(issue({ reason: 'invalid-payload', message: 'periodFrom 不能晚于 periodTo' }));
    }

    const stockSet = new Set(requestedStocks);
    const metricSet = requestedMetrics === undefined ? undefined : new Set(requestedMetrics);
    const revisions = this.facts
      .filter((fact) => stockSet.has(fact.stockId))
      .filter((fact) => metricSet === undefined || metricSet.has(fact.metricId))
      .filter((fact) => input.periodFrom === undefined || fact.periodEnd >= input.periodFrom)
      .filter((fact) => input.periodTo === undefined || fact.periodEnd <= input.periodTo)
      .sort(compareFacts)
      .map(cloneFact);

    for (const stockId of requestedStocks) {
      const metrics = requestedMetrics ?? [
        ...new Set(
          this.facts.filter((fact) => fact.stockId === stockId).map((fact) => fact.metricId),
        ),
      ];
      for (const metricId of metrics) {
        if (!this.facts.some((fact) => fact.stockId === stockId && fact.metricId === metricId)) {
          issues.push(
            issue({
              stockId,
              metricId,
              reason: 'not-covered',
              message: `mock fixture does not cover ${stockId}/${metricId}`,
            }),
          );
        }
      }
    }

    return {
      source: this.source,
      gateStatus: this.gateStatus,
      gate: makeGate(),
      revisions,
      issues,
      observedAt: cloneDate(MOCK_OBSERVED_AT),
    };
  }

  /** Convenience alias for callers that do not need to spell out revision semantics. */
  fetchFinancialFacts(input: FundamentalDataQuery): Promise<FundamentalDataAdapterResult> {
    return this.fetchFinancialFactRevisions(input);
  }
}
