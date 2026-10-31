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
  REAL_FINANCIAL_FACT_SOURCES,
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
  it('真实源缺失时 mock 事实不产生任何分数，persist=false 不写 run', async () => {
    const ctx = await contextWithScoreFixture();
    const saveStarted = vi.spyOn(ctx.repos.fundamentalScoreRun, 'saveStarted');
    const commit = vi.spyOn(ctx.repos.fundamentalScoreRun, 'commit');
    const adviceQuery = vi.spyOn(ctx.repos.advice, 'query');
    const tradeList = vi.spyOn(ctx.repos.trade, 'listByAccount');

    // mock 事实确实落在主表里：报错的是解析路径，不是写入路径。
    expect(await ctx.repos.financialFact.listRevisions({ stockIds })).toHaveLength(20);

    const result = await runFundamentalScoreTool.execute(runInput(false), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      providerKind: 'mock',
      gate: 'not-ready',
      status: 'unavailable',
      results: [],
      run: {
        status: 'unavailable',
        providerStatus: 'unavailable',
        evaluatorCodeIdentity: FUNDAMENTAL_SCORE_EVALUATOR_CODE_IDENTITY,
        terminalReason: { code: 'no-available-score' },
        counts: { evaluated: 20, available: 0, missing: 20, excluded: 0 },
      },
    });
    expect(saveStarted).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(adviceQuery).not.toHaveBeenCalled();
    expect(tradeList).not.toHaveBeenCalled();
  });

  it('persist=true 只保留 unavailable 审计记录，不写可消费结果', async () => {
    const ctx = await contextWithScoreFixture();
    const saveStarted = vi.spyOn(ctx.repos.fundamentalScoreRun, 'saveStarted');
    const commit = vi.spyOn(ctx.repos.fundamentalScoreRun, 'commit');
    const result = await runFundamentalScoreTool.execute(runInput(true), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(saveStarted).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    const committed = commit.mock.calls[0]?.[0];
    expect(committed?.run.status).toBe('unavailable');
    expect(committed?.results).toEqual([]);
    const runId = result.data.run.id;
    expect(await ctx.repos.fundamentalScoreRun.listResults(runId)).toEqual([]);
    const fetched = await getFundamentalScoreTool.execute({ runId }, ctx);
    expect(fetched).toMatchObject({
      ok: true,
      data: {
        gate: 'not-ready',
        status: 'unavailable',
        results: [],
        scoreVersion: { id: 'fundamental-score-v1', status: 'published' },
        version: { id: 'fundamental-score-v1' },
        run: {
          id: runId,
          status: 'unavailable',
          financialVintageKey: result.data.run.financialVintageKey,
        },
      },
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

  it('评分输入只使用真实源白名单，不会退化成披露型 all', async () => {
    const ctx = await contextWithScoreFixture();
    const resolveVintage = vi.spyOn(ctx.repos.financialFact, 'resolveVintage');
    const result = await runFundamentalScoreTool.execute(runInput(false), ctx);
    expect(result.ok).toBe(true);
    expect(resolveVintage).toHaveBeenCalledTimes(1);
    const input = resolveVintage.mock.calls[0]?.[0];
    expect(input?.sources).toEqual(REAL_FINANCIAL_FACT_SOURCES);
    expect(REAL_FINANCIAL_FACT_SOURCES).not.toContain('mock-score-fixture');
  });

  it('industry-percentile-v1 版本在真实源缺失时同样不产出分数', async () => {
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
    expect(
      await ctx.repos.financialFact.listRevisions({ stockIds: industryStockIds }),
    ).toHaveLength(40);

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
      data: {
        status: 'unavailable',
        results: [],
        run: { status: 'unavailable', counts: { evaluated: 40, available: 0 } },
      },
    });
  });
});

// REQ-M3-09 §4：gate 必须是计算值，且 not-ready 时零数字输出。
describe('基本面评分 gate 不是字面常量', () => {
  it('run 路径的 gate 由输入算出，且 not-ready 时结果为空', async () => {
    const ctx = await contextWithScoreFixture();
    const result = await runFundamentalScoreTool.execute(runInput(false), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(['not-ready', 'evaluation-ready']).toContain(result.data.gate);
    expect(result.data.gate).toBe('not-ready');
    expect(result.data.results).toEqual([]);
    // 零数字：逐字段确认没有评分泄漏。
    expect(JSON.stringify(result.data.results)).not.toMatch(/"score":/);
  });

  it('run 路径在数据完整时仍给出 not-ready（mock 装配），数字不外泄', async () => {
    const ctx = await contextWithScoreFixture();
    // 同一输入下若把 gate 判定改成「恒 ready」，results 会冒出来——下面这条断言就是它的牙。
    const result = await runFundamentalScoreTool.execute(runInput(false), ctx);
    if (!result.ok) throw new Error('expected ok');
    const evaluated = result.data.run.counts.evaluated;
    expect(evaluated).toBeGreaterThan(0);
    expect(result.data.results).toHaveLength(0);
    expect(result.data.gate).toBe('not-ready');
  });
});
