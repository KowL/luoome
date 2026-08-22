import {
  type FinancialFact,
  type FinancialFactRepository,
  type FinancialVintage,
  type FundamentalDataAdapterLike,
  type FundamentalIngestionIssue,
  financialFactContentHash,
  resolveStrictPitFinancialVintage,
  type ToolContext,
} from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getFinancialFactsTool, syncFinancialFactsTool } from './financial-facts.js';

const AS_OF = new Date('2026-08-22T00:00:00.000Z');

const makeFact = (overrides: Partial<FinancialFact> = {}): FinancialFact => {
  const base: Omit<FinancialFact, 'contentHash'> = {
    id: 'fact-mock-roe-2025',
    stockId: '600519.SH',
    metricId: 'roe',
    periodType: 'annual',
    periodStart: new Date('2025-01-01T00:00:00.000Z'),
    periodEnd: new Date('2025-12-31T00:00:00.000Z'),
    value: 18.2,
    canonicalUnit: 'percent-points',
    source: 'mock',
    sourceRecordId: 'mock-record-roe-2025',
    sourceRevision: '1',
    publishedAt: new Date('2026-03-31T00:00:00.000Z'),
    revisionPublishedAt: new Date('2026-03-31T00:00:00.000Z'),
    recordedAt: new Date('2026-04-01T00:00:00.000Z'),
    status: 'reported',
  };
  const candidate = { ...base, ...overrides, contentHash: '0'.repeat(64) };
  return { ...candidate, contentHash: financialFactContentHash(candidate) };
};

const makeAdapter = (
  revisions: readonly unknown[],
  issues: readonly unknown[] = [],
): FundamentalDataAdapterLike => ({
  name: 'mock-fundamental-adapter',
  source: 'mock',
  gateStatus: 'not-ready',
  gate: {
    name: 'fundamental-data-gate-v1',
    status: 'not-ready',
    reasons: ['mock fixture has no production PIT evidence'],
    evaluatedAt: AS_OF,
  },
  fetchFinancialFactRevisions: vi.fn(async () => ({
    source: 'mock',
    gateStatus: 'not-ready' as const,
    gate: {
      name: 'fundamental-data-gate-v1' as const,
      status: 'not-ready' as const,
      reasons: ['mock fixture has no production PIT evidence'],
      evaluatedAt: AS_OF,
    },
    revisions: revisions as readonly FinancialFact[],
    issues: issues as readonly FundamentalIngestionIssue[],
    observedAt: AS_OF,
  })),
});

const makeRepo = (initialFacts: readonly FinancialFact[] = []) => {
  const appended = [...initialFacts];
  const resolveVintage = vi.fn(
    async (input: {
      readonly stockIds: readonly string[];
      readonly metricIds: readonly string[];
      readonly asOf: Date;
      readonly policy: 'strict-pit-v1';
    }): Promise<FinancialVintage> =>
      resolveStrictPitFinancialVintage({
        ...input,
        facts: appended,
      }),
  );
  const repo: FinancialFactRepository = {
    appendMany: vi.fn(async (facts) => {
      appended.push(...facts);
    }),
    listRevisions: vi.fn(async () => appended),
    resolveVintage,
  };
  return { repo, appended, resolveVintage };
};

const contextWith = async (input: {
  readonly repo: FinancialFactRepository;
  readonly adapter?: FundamentalDataAdapterLike;
}): Promise<ToolContext> => {
  const base = await buildTestContext({ advices: [] });
  return {
    ...base,
    repos: { ...base.repos, financialFact: input.repo },
    ...(input.adapter === undefined ? {} : { fundamentalData: input.adapter }),
  };
};

describe('financial facts P3-1 mock tools', () => {
  it('sync validates rows, appends only valid facts, and keeps gate not-ready', async () => {
    const valid = makeFact();
    const invalid = { ...valid, id: 'invalid-row', contentHash: 'not-a-hash' };
    const adapter = makeAdapter([valid, invalid]);
    const { repo, appended } = makeRepo();
    const ctx = await contextWith({ repo, adapter });
    const adviceQuery = vi.spyOn(ctx.repos.advice, 'query');
    const tradeList = vi.spyOn(ctx.repos.trade, 'listByAccount');

    const result = await syncFinancialFactsTool.execute(
      { stockIds: ['600519.SH'], metricIds: ['roe'] },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        providerKind: 'mock',
        gate: 'not-ready',
        status: 'partial',
        coverage: {
          requested: 1,
          received: 2,
          accepted: 1,
          rejected: 1,
          missing: 0,
        },
      },
    });
    expect(appended).toEqual([valid]);
    expect(result.ok && result.data.issues[0]?.reason).toBe('invalid-payload');
    expect(adviceQuery).not.toHaveBeenCalled();
    expect(tradeList).not.toHaveBeenCalled();
  });

  it('未注入 adapter 返回 adapter_error（unavailable），不伪造成功数据', async () => {
    const { repo } = makeRepo();
    const ctx = await contextWith({ repo });
    const result = await syncFinancialFactsTool.execute(
      { stockIds: ['600519.SH'], metricIds: ['roe'] },
      ctx,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'adapter_error', adapter: 'fundamental-data', recoverable: true },
    });
  });

  it('adapter 的 not-covered issue 进入 issues 但不冒充 rejected revision', async () => {
    const fact = makeFact();
    const adapter = makeAdapter(
      [fact],
      [
        {
          source: 'mock',
          reason: 'not-covered',
          message: 'eps 未覆盖',
          observedAt: AS_OF,
        },
      ],
    );
    const { repo } = makeRepo();
    const ctx = await contextWith({ repo, adapter });
    const result = await syncFinancialFactsTool.execute(
      { stockIds: ['600519.SH'], metricIds: ['roe', 'eps'] },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        status: 'partial',
        coverage: { received: 1, accepted: 1, rejected: 0, missing: 1 },
      },
    });
  });

  it('拒绝 gate 已升级的 adapter，避免 mock 输出误标生产能力', async () => {
    const base = makeAdapter([]);
    const adapter: FundamentalDataAdapterLike = {
      ...base,
      gateStatus: 'evaluation-ready',
      gate: {
        ...base.gate,
        status: 'evaluation-ready',
      },
    };
    const { repo } = makeRepo();
    const ctx = await contextWith({ repo, adapter });
    const result = await syncFinancialFactsTool.execute(
      { stockIds: ['600519.SH'], metricIds: ['roe'] },
      ctx,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'adapter_error', adapter: 'fundamental-data' },
    });
  });

  it('非法时间窗口由统一输入校验拒绝', async () => {
    const { repo } = makeRepo();
    const ctx = await contextWith({ repo, adapter: makeAdapter([]) });
    const result = await syncFinancialFactsTool.execute(
      {
        stockIds: ['600519.SH'],
        metricIds: ['roe'],
        periodFrom: '2026-08-22T00:00:00.000Z',
        periodTo: '2026-08-01T00:00:00.000Z',
      },
      ctx,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });

  it('get 只调用 resolveVintage，不回源 adapter，并保留 missing/vintage', async () => {
    const fact = makeFact();
    const { repo, resolveVintage } = makeRepo([fact]);
    const adapter = makeAdapter([]);
    const fetch = adapter.fetchFinancialFactRevisions;
    const ctx = await contextWith({ repo, adapter });
    const adviceQuery = vi.spyOn(ctx.repos.advice, 'query');
    const tradeList = vi.spyOn(ctx.repos.trade, 'listByAccount');

    const result = await getFinancialFactsTool.execute(
      {
        stockIds: ['600519.SH'],
        metricIds: ['roe', 'eps'],
        asOf: AS_OF,
      },
      ctx,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        providerKind: 'mock',
        gate: 'not-ready',
        status: 'partial',
        facts: [fact],
        missing: [{ stockId: '600519.SH', metricId: 'eps', reason: 'not-covered' }],
      },
    });
    expect(resolveVintage).toHaveBeenCalledWith({
      stockIds: ['600519.SH'],
      metricIds: ['roe', 'eps'],
      asOf: AS_OF,
      policy: 'strict-pit-v1',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(adviceQuery).not.toHaveBeenCalled();
    expect(tradeList).not.toHaveBeenCalled();
  });
});
