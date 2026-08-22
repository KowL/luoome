import { createHash } from 'node:crypto';
import {
  type FinancialFact,
  FUNDAMENTAL_FACTOR_REGISTRY_HASH,
  FUNDAMENTAL_FACTOR_REGISTRY_VERSION,
  FUNDAMENTAL_NORMALIZATION_VERSION,
  FUNDAMENTAL_ROUNDING,
  type FundamentalScoreVersion,
  FundamentalScoreVersionSchema,
  financialFactContentHash,
  fundamentalScoreVersionDefinitionHash,
} from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import {
  FUNDAMENTAL_SCORE_EVALUATOR_CODE_IDENTITY,
  getFundamentalScoreTool,
  runFundamentalScoreTool,
} from './fundamental-score.js';

const AS_OF = new Date('2026-08-22T00:00:00.000Z');
const HASH = 'a'.repeat(64);

const scoreVersion = (
  overrides: Partial<FundamentalScoreVersion> = {},
): FundamentalScoreVersion => {
  const draft: FundamentalScoreVersion = {
    id: 'fundamental-score-v1',
    version: 1,
    registryVersion: FUNDAMENTAL_FACTOR_REGISTRY_VERSION,
    registryHash: FUNDAMENTAL_FACTOR_REGISTRY_HASH,
    normalizationVersion: FUNDAMENTAL_NORMALIZATION_VERSION,
    components: [
      {
        factorId: 'fundamental.profitability.roe',
        weight: 1,
        normalizer: 'market-percentile-v1',
      },
    ],
    missingPolicy: 'unknown',
    rounding: FUNDAMENTAL_ROUNDING,
    definitionHash: HASH,
    status: 'published',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
  const parsed = FundamentalScoreVersionSchema.parse(draft);
  return { ...parsed, definitionHash: fundamentalScoreVersionDefinitionHash(parsed) };
};

const factFor = (stockId: string, value: number, industryKey?: string): FinancialFact => {
  const candidate: Omit<FinancialFact, 'contentHash'> = {
    id: `fact-${stockId}`,
    stockId,
    metricId: 'roe',
    periodType: 'annual',
    periodStart: new Date('2025-01-01T00:00:00.000Z'),
    periodEnd: new Date('2025-12-31T00:00:00.000Z'),
    value,
    canonicalUnit: 'percent-points',
    source: 'mock-score-fixture',
    sourceRecordId: `record-${stockId}`,
    sourceRevision: 'r1',
    publishedAt: new Date('2026-02-01T00:00:00.000Z'),
    revisionPublishedAt: new Date('2026-02-01T00:00:00.000Z'),
    recordedAt: new Date('2026-02-02T00:00:00.000Z'),
    status: 'reported',
    ...(industryKey === undefined ? {} : { industryKey }),
  };
  const withPlaceholder = { ...candidate, contentHash: '0'.repeat(64) };
  return { ...withPlaceholder, contentHash: financialFactContentHash(withPlaceholder) };
};

const stockIds = Array.from(
  { length: 20 },
  (_, index) => `${String(index + 1).padStart(6, '0')}.SH`,
);
const checksumFor = (ids: readonly string[]): string =>
  createHash('sha256')
    .update(JSON.stringify([...ids].sort()))
    .digest('hex');
const MEMBER_CHECKSUM = checksumFor(stockIds);
const industryStockIds = Array.from(
  { length: 40 },
  (_, index) => `industry-${String(index + 1).padStart(2, '0')}.SH`,
);

const runInput = (persist: boolean) => ({
  scoreVersionId: 'fundamental-score-v1',
  asOf: AS_OF,
  stockIds,
  universeSyncId: 'universe-sync-v1',
  universeMemberChecksum: MEMBER_CHECKSUM,
  persist,
});

const contextWithScoreFixture = async () => {
  const ctx = await buildTestContext({ clock: () => new Date('2026-08-22T01:00:00.000Z') });
  await ctx.repos.fundamentalScoreVersion.save(scoreVersion());
  await ctx.repos.financialFact.appendMany(
    stockIds.map((stockId, index) =>
      factFor(stockId, index + 1, index < 10 ? 'finance-a' : 'finance-b'),
    ),
  );
  return ctx;
};

describe('fundamental score tools', () => {
  it('scores a stable 20-stock market percentile and persist=false performs no score writes', async () => {
    const ctx = await contextWithScoreFixture();
    const saveStarted = vi.spyOn(ctx.repos.fundamentalScoreRun, 'saveStarted');
    const commit = vi.spyOn(ctx.repos.fundamentalScoreRun, 'commit');
    const adviceQuery = vi.spyOn(ctx.repos.advice, 'query');
    const tradeList = vi.spyOn(ctx.repos.trade, 'listByAccount');

    const result = await runFundamentalScoreTool.execute(runInput(false), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      providerKind: 'mock',
      gate: 'not-ready',
      status: 'complete',
      run: {
        status: 'committed',
        providerStatus: 'complete',
        evaluatorCodeIdentity: FUNDAMENTAL_SCORE_EVALUATOR_CODE_IDENTITY,
      },
    });
    expect(result.data.results).toHaveLength(20);
    expect(result.data.results.map((row) => row.rank)).toEqual(
      Array.from({ length: 20 }, (_, index) => 20 - index),
    );
    expect(result.data.results[0]?.score).toBe(0);
    expect(result.data.results[19]?.score).toBe(100);
    expect(saveStarted).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(adviceQuery).not.toHaveBeenCalled();
    expect(tradeList).not.toHaveBeenCalled();
  });

  it('persist=true atomically stores committed run/results and get exposes the version/vintage explanation', async () => {
    const ctx = await contextWithScoreFixture();
    const saveStarted = vi.spyOn(ctx.repos.fundamentalScoreRun, 'saveStarted');
    const commit = vi.spyOn(ctx.repos.fundamentalScoreRun, 'commit');
    const result = await runFundamentalScoreTool.execute(runInput(true), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(saveStarted).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    const runId = result.data.run.id;
    const fetched = await getFundamentalScoreTool.execute({ runId }, ctx);
    expect(fetched).toMatchObject({ ok: true });
    if (!fetched.ok) return;
    expect(fetched.data).toMatchObject({
      gate: 'not-ready',
      status: 'committed',
      scoreVersion: { id: 'fundamental-score-v1', status: 'published' },
      version: { id: 'fundamental-score-v1' },
      run: { id: runId, financialVintageKey: result.data.run.financialVintageKey },
    });
    expect(fetched.data.results[0]?.components[0]).toMatchObject({
      unit: 'percent-points',
      direction: 'higher',
      sourceRevisionIds: expect.any(Array),
    });
  });

  it('rejects draft/retired versions and does not accept caller-supplied evaluator identity', async () => {
    const ctx = await contextWithScoreFixture();
    await ctx.repos.fundamentalScoreVersion.save(
      scoreVersion({ id: 'draft-score', status: 'draft', publishedAt: undefined }),
    );
    await ctx.repos.fundamentalScoreVersion.save(
      scoreVersion({ id: 'retired-score', status: 'retired' }),
    );
    const draft = await runFundamentalScoreTool.execute(
      { ...runInput(false), scoreVersionId: 'draft-score' },
      ctx,
    );
    expect(draft).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });

    const retired = await runFundamentalScoreTool.execute(
      { ...runInput(false), scoreVersionId: 'retired-score' },
      ctx,
    );
    expect(retired).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });

    const spoofed = await runFundamentalScoreTool.execute(
      { ...runInput(false), evaluatorCodeIdentity: 'caller-controlled' },
      ctx,
    );
    expect(spoofed).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });

    const mismatchedUniverse = await runFundamentalScoreTool.execute(
      { ...runInput(false), universeMemberChecksum: HASH },
      ctx,
    );
    expect(mismatchedUniverse).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });

  it('wires industry-percentile-v1 through strict PIT facts and keeps each 20-stock group stable', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-08-22T01:00:00.000Z') });
    const version = scoreVersion({
      id: 'fundamental-score-industry-v1',
      components: [
        {
          factorId: 'fundamental.profitability.roe',
          weight: 1,
          normalizer: 'industry-percentile-v1',
        },
      ],
    });
    await ctx.repos.fundamentalScoreVersion.save(version);
    await ctx.repos.financialFact.appendMany(
      industryStockIds.map((stockId, index) =>
        factFor(
          stockId,
          index < 20 ? index + 1 : index - 19 + 100,
          index < 20 ? 'finance-a' : 'finance-b',
        ),
      ),
    );

    const result = await runFundamentalScoreTool.execute(
      {
        scoreVersionId: version.id,
        asOf: AS_OF,
        stockIds: industryStockIds,
        universeSyncId: 'universe-sync-industry-v1',
        universeMemberChecksum: checksumFor(industryStockIds),
        persist: false,
      },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: { status: 'complete', results: expect.any(Array) },
    });
    if (!result.ok) return;
    expect(result.data.results).toHaveLength(40);
    const byStock = new Map(result.data.results.map((row) => [row.stockId, row]));
    expect(byStock.get(industryStockIds[0] as string)).toMatchObject({ score: 0 });
    expect(byStock.get(industryStockIds[19] as string)).toMatchObject({ score: 100 });
    expect(byStock.get(industryStockIds[20] as string)).toMatchObject({ score: 0 });
    expect(byStock.get(industryStockIds[39] as string)).toMatchObject({ score: 100 });
    expect(byStock.get(industryStockIds[0] as string)?.components[0]).toMatchObject({
      normalizedValue: 0,
      rawValue: 1,
      sourceRevisionIds: [expect.stringContaining('fact-industry-01.SH')],
    });
    expect(byStock.get(industryStockIds[20] as string)?.components[0]).toMatchObject({
      normalizedValue: 0,
      rawValue: 101,
    });
  });

  it('keeps unavailable runs explicit when the 20-stock denominator is not met', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-08-22T01:00:00.000Z') });
    await ctx.repos.fundamentalScoreVersion.save(scoreVersion());
    await ctx.repos.financialFact.appendMany(
      stockIds.slice(0, 19).map((id, index) => factFor(id, index + 1)),
    );
    const result = await runFundamentalScoreTool.execute(runInput(true), ctx);
    expect(result).toMatchObject({
      ok: true,
      data: {
        gate: 'not-ready',
        status: 'unavailable',
        run: { status: 'unavailable', terminalReason: { code: 'no-available-score' } },
        results: [],
      },
    });
    if (!result.ok) return;
    expect(await ctx.repos.fundamentalScoreRun.findById(result.data.run.id)).toMatchObject({
      status: 'unavailable',
      terminalReason: { code: 'no-available-score' },
    });
    expect(await getFundamentalScoreTool.execute({ runId: result.data.run.id }, ctx)).toMatchObject(
      {
        ok: true,
        data: { status: 'unavailable', results: [] },
      },
    );
  });
});
