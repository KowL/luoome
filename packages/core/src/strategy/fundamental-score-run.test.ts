import { describe, expect, it } from 'vitest';

import { InvariantError } from '../error/index.js';
import {
  assertFundamentalScoreRunCommitInvariants,
  assertFundamentalScoreRunInvariants,
  FUNDAMENTAL_FACTOR_REGISTRY_HASH,
  type FundamentalScoreResult,
  type FundamentalScoreRun,
  FundamentalScoreRunSchema,
  type FundamentalScoreRunTerminalReason,
  type FundamentalScoreVersion,
  fundamentalScoreVersionDefinitionHash,
  getFundamentalFactor,
  runFundamentalScore,
} from './fundamental-factor.js';

const hash = 'a'.repeat(64);
const createdAt = new Date('2026-01-01T00:00:00.000Z');
const committedAt = new Date('2026-01-01T00:01:00.000Z');

const terminalReason = (code = 'provider-unavailable'): FundamentalScoreRunTerminalReason => ({
  code,
  message: 'PIT provider did not return an auditable vintage',
  observedAt: committedAt,
});

const makeRun = (overrides: Partial<FundamentalScoreRun> = {}): FundamentalScoreRun => ({
  id: 'fundamental-score-run-1',
  scoreVersionId: 'fundamental-score-v1',
  scoreVersionHash: hash,
  registryHash: hash,
  universeSyncId: 'universe-sync-1',
  universeMemberChecksum: hash,
  asOf: new Date('2025-12-31T08:00:00.000Z'),
  financialVintageKey: hash,
  normalizerDenominatorHash: hash,
  counts: { evaluated: 0, available: 0, missing: 0, excluded: 0 },
  providerStatus: 'complete',
  evaluatorCodeIdentity: 'fundamental-score-engine@v1',
  status: 'started',
  createdAt,
  ...overrides,
});

const availableResult = (
  overrides: Partial<FundamentalScoreResult> = {},
): FundamentalScoreResult => ({
  scoreRunId: 'fundamental-score-run-1',
  stockId: '000001.SZ',
  status: 'available',
  score: 100,
  rank: 1,
  components: [
    {
      factorId: 'fundamental.profitability.roe',
      rawValue: 20,
      unit: 'percent-points',
      direction: 'higher',
      normalizedValue: 100,
      contribution: 100,
      sourceRevisionIds: ['fact-1'],
    },
  ],
  dataAsOf: new Date('2025-12-31T08:00:00.000Z'),
  vintageKey: hash,
  ...overrides,
});

describe('FundamentalScoreRun contract', () => {
  it('requires all score, universe, vintage, denominator and evaluator identities', () => {
    const run = makeRun();
    expect(FundamentalScoreRunSchema.parse(run)).toEqual(run);
    expect(() =>
      FundamentalScoreRunSchema.parse({ ...run, registryHash: 'A'.repeat(64) }),
    ).toThrow();
    expect(() => FundamentalScoreRunSchema.parse({ ...run, evaluatorCodeIdentity: '' })).toThrow();
  });

  it('keeps committed counts as a partition and preserves unavailable attempts', () => {
    expect(() =>
      assertFundamentalScoreRunInvariants(
        makeRun({ counts: { evaluated: 2, available: 1, missing: 0, excluded: 0 } }),
      ),
    ).not.toThrow();
    expect(() =>
      assertFundamentalScoreRunInvariants(
        makeRun({
          status: 'committed',
          committedAt,
          counts: { evaluated: 2, available: 1, missing: 0, excluded: 0 },
        }),
      ),
    ).toThrow(/committed/);
    expect(() =>
      assertFundamentalScoreRunInvariants(
        makeRun({
          status: 'unavailable',
          committedAt,
          terminalReason: terminalReason(),
          counts: { evaluated: 2, available: 0, missing: 0, excluded: 0 },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertFundamentalScoreRunInvariants(
        makeRun({
          status: 'failed',
          committedAt,
          terminalReason: terminalReason('evaluator-error'),
          counts: { evaluated: 2, available: 1, missing: 1, excluded: 1 },
        }),
      ),
    ).toThrow(/不能大于/);
  });

  it('enforces lifecycle timestamps and structured terminal reasons', () => {
    expect(() => assertFundamentalScoreRunInvariants(makeRun({ committedAt }))).toThrow(/started/);
    expect(() => assertFundamentalScoreRunInvariants(makeRun({ status: 'committed' }))).toThrow(
      /committedAt/,
    );
    expect(() =>
      assertFundamentalScoreRunInvariants(makeRun({ status: 'unavailable', committedAt })),
    ).toThrow(/terminalReason/);
    expect(() =>
      assertFundamentalScoreRunInvariants(
        makeRun({
          status: 'failed',
          committedAt,
          terminalReason: { ...terminalReason('evaluator-error'), observedAt: createdAt },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertFundamentalScoreRunInvariants(
        makeRun({
          status: 'failed',
          committedAt,
          terminalReason: { ...terminalReason('evaluator-error'), observedAt: new Date(0) },
        }),
      ),
    ).toThrow(/observedAt/);
    expect(() =>
      assertFundamentalScoreRunInvariants(
        makeRun({
          status: 'unavailable',
          committedAt,
          terminalReason: terminalReason(),
        }),
      ),
    ).not.toThrow();
  });

  it('only permits committed results with matching identities and counts', () => {
    const result = availableResult();
    const run = makeRun({
      status: 'committed',
      committedAt,
      counts: { evaluated: 1, available: 1, missing: 0, excluded: 0 },
    });
    expect(() =>
      assertFundamentalScoreRunCommitInvariants({ run, results: [result] }),
    ).not.toThrow();
    expect(() =>
      assertFundamentalScoreRunCommitInvariants({ run: makeRun(), results: [] }),
    ).toThrow(/terminal status/);
    expect(() =>
      assertFundamentalScoreRunCommitInvariants({
        run: makeRun({ status: 'unavailable', committedAt, terminalReason: terminalReason() }),
        results: [result],
      }),
    ).toThrow(InvariantError);
    expect(() =>
      assertFundamentalScoreRunCommitInvariants({
        run,
        results: [availableResult({ dataAsOf: new Date('2025-12-30T08:00:00.000Z') })],
      }),
    ).toThrow(/dataAsOf/);
  });

  it('keeps fail-run unavailable counts auditable without manufacturing results', () => {
    const factorId = 'fundamental.profitability.roe';
    const factor = getFundamentalFactor(factorId);
    if (factor === undefined) throw new Error(`missing test factor: ${factorId}`);
    const draft = {
      id: 'fundamental-score-fail-run-v1',
      version: 1,
      registryVersion: 'fundamental-factor-registry-v1',
      registryHash: FUNDAMENTAL_FACTOR_REGISTRY_HASH,
      normalizationVersion: 'fundamental-normalization-v1' as const,
      components: [{ factorId, weight: 1, normalizer: 'market-percentile-v1' as const }],
      missingPolicy: 'fail-run' as const,
      rounding: 'round-to-6-decimal' as const,
      definitionHash: '0'.repeat(64),
      status: 'published' as const,
      createdAt,
      publishedAt: committedAt,
    } satisfies FundamentalScoreVersion;
    const version = {
      ...draft,
      definitionHash: fundamentalScoreVersionDefinitionHash(draft),
    };
    const stockIds = Array.from({ length: 20 }, (_, index) => `stock-${index}`);
    const score = runFundamentalScore({
      scoreRunId: 'fundamental-score-fail-run-1',
      scoreVersion: version,
      stockIds,
      observations: stockIds.slice(0, 19).map((stockId, index) => ({
        stockId,
        factorId,
        rawValue: index,
        unit: factor.outputUnit,
        direction: factor.direction,
        sourceRevisionIds: [`fact-${stockId}`],
      })),
      dataAsOf: new Date('2025-12-31T08:00:00.000Z'),
      vintageKey: hash,
    });
    expect(score.status).toBe('unavailable');
    expect(score.counts).toEqual({ evaluated: 20, available: 0, missing: 0, excluded: 0 });
    expect(score.results.every((result) => result.status === 'unavailable')).toBe(true);
  });
});
