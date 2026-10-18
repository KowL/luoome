import {
  type AShareSentimentSnapshot,
  investmentMarketEvidenceValidUntil,
  type LLMAdapterLike,
  money,
  type StrategyDslV1,
  strategyDefinitionHash,
  type ToolContext,
} from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import {
  getInvestmentCandidatesTool,
  getInvestmentWorkspaceTool,
  researchInvestmentDirectionsTool,
  saveInvestmentConsensusTool,
  setInvestmentTrackingTool,
} from './investment-workspace.js';

const now = new Date('2026-10-16T08:00:00Z');
const observedAt = new Date('2026-10-16T07:00:00Z');
const provenance = () => [
  { provider: 'injected-market-source', observedAt, fetchedAt: now, freshness: 'fresh' as const },
];
const missing = () => ({
  status: 'unavailable' as const,
  provenance: [
    {
      provider: 'unconfigured',
      observedAt: now,
      fetchedAt: now,
      freshness: 'unavailable' as const,
    },
  ],
  warnings: ['not-configured'],
});
const snapshot = (): AShareSentimentSnapshot => ({
  date: '2026-10-16',
  coverage: 'CN_A_SHARES_SH_SZ',
  dataAsOf: observedAt,
  indexes: missing(),
  breadth: {
    status: 'complete',
    provenance: provenance(),
    warnings: [],
    value: { advancing: 3000, declining: 1700, unchanged: 300, total: 5000 },
  },
  limitUp: {
    status: 'complete',
    provenance: provenance(),
    warnings: [],
    value: {
      sealedCount: 30,
      brokenCount: 10,
      brokenRate: 0.25,
      maxLadderLevel: 4,
      totalSealAmount: 1000000,
      boardDistribution: { main: 30 },
      leaders: [],
    },
  },
  themes: {
    status: 'partial',
    provenance: provenance(),
    warnings: ['only-provider-pool-industries'],
    value: { industries: [{ name: '软件开发', count: 10 }], concepts: [] },
  },
});
type Proposal = { id: string; evidenceIds: string[] };
const answer = (proposal: Proposal) => ({
  proposalId: proposal.id,
  stance: 'observe',
  rationale: '在已披露覆盖范围内继续观察，不外推个股机会。',
  comparisonReason: '比较实际涨跌分布与事件池风险，缺失维度保持未知。',
  evidenceIds: proposal.evidenceIds,
  objections: [
    {
      kind: 'known-risk',
      conclusion: '反对仅凭这项市场事实追涨。',
      evidenceIds: proposal.evidenceIds,
      risks: ['市场广度或指数变化不能替代逐股研究。'],
      unknowns: ['公司事件与账户适配未知。'],
      reconsiderWhen: ['补充真实公司与账户事实后重新研究。'],
      alternatives: ['先保存讨论方向或等待。'],
    },
  ],
  risks: ['量价关系可能改变。'],
  waitFor: ['等待新市场事实与逐股研究。'],
  abandonWhen: ['原事实反转或到期。'],
  reviewWhen: ['新交易日或市场证据发生变化。'],
  horizon: 'short',
});

const fixture = async (
  input: { data?: AShareSentimentSnapshot; manager?: boolean; indexes?: boolean } = {},
) => {
  const data = input.data ?? snapshot();
  const base = await buildTestContext({
    clock: () => now,
    ...(input.manager === false
      ? {}
      : {
          ashareSentiment: { status: () => [], fetch: async () => ({ ok: true as const, data }) },
        }),
  });
  const generate = vi.fn(async ({ data }: Parameters<LLMAdapterLike['generate']>[0]) => {
    const request = data as { proposals: Proposal[] };
    return { directions: request.proposals.slice(0, 3).map(answer) };
  });
  const indexes = vi.fn(async () =>
    input.indexes === false
      ? []
      : [
          {
            code: '000001',
            name: '上证指数',
            close: money(3600),
            change: 12,
            changePct: 0.33,
            ts: observedAt,
            source: 'injected-index-source',
            timestampSource: 'upstream' as const,
          },
        ],
  );
  const ctx: ToolContext = {
    ...base,
    adapters: {
      ...base.adapters,
      market: { ...base.adapters.market, fetchIndexQuotes: indexes },
      llm: { name: 'injected-test-only', generate: generate as LLMAdapterLike['generate'] },
    },
  };
  return { ctx, generate, indexes };
};

const research = (ctx: ToolContext, requestId = 'new-user-research') =>
  researchInvestmentDirectionsTool.execute(
    { requestId, question: '没有预设策略，我该先研究什么方向？' },
    ctx,
  );
const confirmation = (result: { id: string; directions: { id: string }[] }) => ({
  requestId: 'market-confirm',
  expectedVersion: 0,
  changes: {
    selections: result.directions.map((direction, index) => ({
      researchId: result.id,
      directionId: direction.id,
      role: index === 0 ? 'primary' : 'observe',
      userReason: '我保留反对，先讨论这个方向。',
    })),
  },
  source: { userText: '确认这些研究方向，先不启动股票跟踪。' },
  changeNote: '确认方向，尚无候选映射',
  reviewAt: new Date('2026-10-19T08:00:00Z'),
  validUntil: new Date('2026-10-23T08:00:00Z'),
});

describe('investment directions without preset strategies', () => {
  it('tracks only a real mapped strategy in a mixed consensus and reports the market direction as untracked', async () => {
    const { ctx } = await fixture();
    const market = await research(ctx);
    if (!market.ok || market.data.research.directions[0] === undefined) throw new Error('fixture');
    const definition: StrategyDslV1 = {
      schemaVersion: 1,
      metadata: {},
      universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
      selection: {
        logic: 'all',
        rules: [
          {
            id: 'positive-close',
            name: '正价格',
            when: 'quote.close > 0',
            evidence: ['收盘价事实'],
          },
        ],
      },
      signals: { entry: [], exit: [], risk: [] },
    };
    const strategyId = 'actual-mapped-strategy';
    const versionId = 'actual-mapped-version';
    const runId = 'actual-published-run';
    await ctx.repos.strategy.create({
      id: strategyId,
      name: '真实策略',
      description: '隔离已发布策略',
      owner: 'user',
      status: 'active',
      currentVersionId: versionId,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.repos.strategy.createVersion({
      id: versionId,
      strategyId,
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: now,
      createdAt: now,
    });
    await ctx.repos.strategyRun.commitRun({
      run: {
        id: runId,
        strategyId,
        strategyVersionId: versionId,
        mode: 'scan',
        coverage: 'CN_A_SHARES_SH_SZ',
        dataAsOf: now,
        startedAt: now,
        finishedAt: now,
        status: 'complete',
        scope: 'operational',
        inputSnapshot: { stockIds: ['002594.SZ'], universeKind: 'explicit' },
        providerStatuses: [],
        summary: { selected: 1 },
        publication: { status: 'published', reasons: [], decidedAt: now },
      },
      results: [
        {
          runId,
          stockId: '002594.SZ',
          selected: true,
          score: 60,
          ruleEvaluations: [],
          evidence: ['真实选择结果'],
          dataAsOf: now,
        },
      ],
      signals: [],
    });
    await ctx.repos.strategySchedule.save({
      id: 'mapped-schedule',
      strategyId,
      cron: '30 16 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
      nextRunAt: new Date('2026-10-19T08:30:00Z'),
      createdAt: now,
      updatedAt: now,
    });
    const { proposalId: _proposal, ...explanation } = answer({
      id: strategyId,
      evidenceIds: [`${runId}:coverage`],
    });
    const scoped: ToolContext = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        llm: {
          name: 'injected-strategy-test',
          generate: async <T>() => ({ directions: [{ ...explanation, strategyId }] }) as T,
        },
      },
    };
    const mapped = await researchInvestmentDirectionsTool.execute(
      { requestId: 'mapped-research', question: '比较这个真实策略', strategyIds: [strategyId] },
      scoped,
    );
    if (!mapped.ok || mapped.data.research.directions[0] === undefined) throw new Error('fixture');
    const marketDirection = market.data.research.directions[0];
    const mappedDirection = mapped.data.research.directions[0];
    const input = confirmation(market.data.research);
    const confirmed = await saveInvestmentConsensusTool.execute(
      {
        ...input,
        changes: {
          selections: [
            {
              researchId: market.data.research.id,
              directionId: marketDirection.id,
              role: 'observe',
              userReason: '保留市场讨论',
            },
            {
              researchId: mapped.data.research.id,
              directionId: mappedDirection.id,
              role: 'primary',
              userReason: '只跟踪真实映射',
            },
          ],
        },
      },
      ctx,
    );
    expect(confirmed.ok).toBe(true);
    const started = await setInvestmentTrackingTool.execute(
      { requestId: 'mixed-tracking', expectedVersion: 1, action: 'start' },
      ctx,
    );
    expect(started).toMatchObject({
      ok: true,
      data: {
        tracking: {
          status: 'partial',
          unmappedDirections: [{ directionId: marketDirection.id }],
          items: [{ strategyId, directionId: mappedDirection.id, status: 'tracking' }],
        },
      },
    });
    expect(await ctx.repos.watchlist.list()).toHaveLength(1);
    expect(await ctx.repos.strategy.list()).toHaveLength(1);
    expect(await getInvestmentWorkspaceTool.execute({}, ctx)).toMatchObject({
      ok: true,
      data: {
        trackingEligibility: {
          eligible: true,
          mappedDirectionIds: [mappedDirection.id],
          unmappedDirections: [{ directionId: marketDirection.id }],
        },
        tracking: { status: 'partial' },
      },
    });
  });

  it('uses actual breadth, indexes and sentiment without creating strategies, stock mappings or fake run ids', async () => {
    const { ctx, generate, indexes } = await fixture();
    const stocks = vi.spyOn(ctx.repos.stock, 'search');
    expect(await ctx.repos.strategy.list()).toEqual([]);
    const result = await research(ctx);
    expect(result).toMatchObject({ ok: true, data: { research: { status: 'complete' } } });
    if (!result.ok) return;
    const saved = result.data.research;
    expect(saved.directions).toHaveLength(3);
    expect(saved.directions[0]).toMatchObject({
      opportunityType: 'market-participation',
      coverage: {
        kind: 'market-facts',
        observedCount: 5000,
        unit: 'stocks',
        dataHealth: 'complete',
      },
      tracking: { eligible: false },
    });
    for (const direction of saved.directions) {
      expect(direction).not.toHaveProperty('strategyId');
      expect(direction).not.toHaveProperty('strategyVersionId');
      expect(direction).not.toHaveProperty('runId');
      expect(direction.dataAsOf).toEqual(observedAt);
      expect(direction.validUntil).toEqual(investmentMarketEvidenceValidUntil(observedAt));
      expect(direction.objections.some((objection) => objection.kind === 'missing-evidence')).toBe(
        true,
      );
    }
    expect(saved.marketSnapshot?.snapshot.breadth.value?.total).toBe(5000);
    expect(saved.evidence.find((fact) => fact.kind === 'market-pool-industry')?.text).toContain(
      '不代表完整板块强弱',
    );
    expect(stocks).not.toHaveBeenCalled();
    expect(await ctx.repos.strategy.list()).toEqual([]);
    expect(await ctx.repos.watchlist.list()).toEqual([]);
    const replay = await research(ctx);
    expect(replay).toMatchObject({
      ok: true,
      data: { replayed: true, research: { id: saved.id } },
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(indexes).toHaveBeenCalledTimes(1);
  });

  it('preserves confirmed discussion, explicitly blocks tracking without mapping, and restores it across days', async () => {
    const { ctx } = await fixture();
    const result = await research(ctx);
    if (!result.ok) throw new Error('fixture');
    const saved = await saveInvestmentConsensusTool.execute(
      confirmation(result.data.research),
      ctx,
    );
    expect(saved).toMatchObject({ ok: true, data: { consensus: { version: 1 }, tracking: null } });
    expect(await getInvestmentWorkspaceTool.execute({}, ctx)).toMatchObject({
      ok: true,
      data: {
        consensusState: 'confirmed',
        trackingEligibility: {
          eligible: false,
          mappedDirectionIds: [],
          unmappedDirections: [{}, {}, {}],
        },
      },
    });
    expect(
      await setInvestmentTrackingTool.execute(
        { requestId: 'must-not-track', expectedVersion: 1, action: 'start' },
        ctx,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        kind: 'invalid_input',
        message: expect.stringContaining('unmapped_market_direction'),
      },
    });
    expect(await getInvestmentCandidatesTool.execute({}, ctx)).toMatchObject({
      ok: true,
      data: {
        total: 0,
        candidates: [],
        limitations: expect.arrayContaining([expect.stringContaining('尚无真实策略')]),
      },
    });
    expect(await ctx.repos.watchlist.list()).toEqual([]);
    expect(
      await ctx.repos.investmentWorkspace.listTracking({
        ownerUserId: ctx.user.id,
        accountId: ctx.user.defaultAccountId,
      }),
    ).toEqual([]);
    const nextDay = { ...ctx, clock: () => new Date('2026-10-17T02:00:00Z') };
    expect(await getInvestmentWorkspaceTool.execute({}, nextDay)).toMatchObject({
      ok: true,
      data: {
        consensus: { version: 1 },
        consensusState: 'confirmed',
        trackingEligibility: { eligible: false },
      },
    });
    const afterCutoff = { ...ctx, clock: () => new Date('2026-10-19T01:30:00Z') };
    expect(await getInvestmentWorkspaceTool.execute({}, afterCutoff)).toMatchObject({
      ok: true,
      data: { consensus: { version: 1 }, consensusState: 'review-required' },
    });
  });

  it('can discuss returned indexes with no sentiment manager and clearly limits the scope', async () => {
    const { ctx } = await fixture({ manager: false });
    const result = await research(ctx);
    expect(result).toMatchObject({
      ok: true,
      data: {
        research: {
          status: 'complete',
          directions: [
            {
              opportunityType: 'market-participation',
              source: { subject: 'cn-equity-indexes' },
              coverage: { observedCount: 1, unit: 'indexes', dataHealth: 'partial' },
            },
          ],
        },
      },
    });
    if (result.ok) expect(result.data.research.limitations.join(' ')).toContain('未装配情绪');
  });

  it('does not turn fifty returned stocks or a pool industry into a full-market conclusion', async () => {
    const data = snapshot();
    data.breadth = {
      status: 'partial',
      provenance: provenance(),
      warnings: ['incomplete-coverage'],
      value: { total: 50, advancing: 27, declining: 20, unchanged: 3 },
    };
    data.limitUp = missing();
    data.themes = missing();
    const { ctx } = await fixture({ data, indexes: false });
    const result = await research(ctx);
    expect(result).toMatchObject({
      ok: true,
      data: {
        research: {
          status: 'complete',
          directions: [
            {
              coverage: {
                observedCount: 50,
                dataHealth: 'partial',
                description: expect.stringContaining('不能外推全市场'),
              },
            },
          ],
        },
      },
    });
  });

  it('does not treat an index retrieval timestamp as observed market time or refresh stale upstream evidence', async () => {
    for (const timestampSource of [
      'retrieval',
      'unknown',
      'upstream',
      'legacy-eastmoney',
    ] as const) {
      const { ctx, generate } = await fixture({ manager: false });
      const index = {
        code: '000001',
        name: '上证指数',
        close: money(3600),
        change: 12,
        changePct: 0.33,
        ts: now,
        source: 'eastmoney',
        ...(timestampSource === 'legacy-eastmoney' ? {} : { timestampSource }),
        ...(timestampSource === 'upstream'
          ? { observedAt: new Date('2026-10-16T02:00:00Z'), fetchedAt: now }
          : {}),
      };
      const scoped = {
        ...ctx,
        adapters: {
          ...ctx.adapters,
          market: { ...ctx.adapters.market, fetchIndexQuotes: async () => [index] },
        },
      };
      expect(await research(scoped)).toMatchObject({
        ok: true,
        data: { research: { status: 'unavailable', directions: [] } },
      });
      expect(generate).not.toHaveBeenCalled();
    }
  });

  it.each(['stale', 'unknown', 'future', 'wrong-date'] as const)(
    'excludes %s observation facts and does not ask the model to fill gaps',
    async (kind) => {
      const data = snapshot();
      data.limitUp = missing();
      data.themes = missing();
      const source = data.breadth.provenance[0];
      if (source === undefined) throw new Error('fixture');
      if (kind === 'stale') source.observedAt = new Date('2026-10-15T07:00:00Z');
      if (kind === 'unknown') source.freshness = 'unknown';
      if (kind === 'future') source.observedAt = new Date('2026-10-16T09:00:00Z');
      if (kind === 'wrong-date') source.observedAt = new Date('2026-10-14T07:00:00Z');
      const { ctx, generate } = await fixture({ data, indexes: false });
      expect(await research(ctx)).toMatchObject({
        ok: true,
        data: { research: { status: 'unavailable', directions: [] } },
      });
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it('persists failed research on wrong citations or fake strategy mapping, then supports explicit retry', async () => {
    for (const kind of ['foreign-citation', 'fake-strategy'] as const) {
      const { ctx, generate } = await fixture();
      generate.mockImplementationOnce(async ({ data }) => {
        const proposals = (data as { proposals: Proposal[] }).proposals;
        const proposed = proposals[0];
        if (proposed === undefined) throw new Error('fixture');
        const value = answer(proposed);
        return {
          directions: [
            {
              ...value,
              ...(kind === 'foreign-citation'
                ? { evidenceIds: ['not-in-this-snapshot'] }
                : { strategyId: 'fabricated-strategy', runId: 'fabricated-run' }),
            },
          ],
        };
      });
      const failed = await research(ctx);
      expect(failed).toMatchObject({
        ok: true,
        data: { research: { status: 'failed', directions: [] } },
      });
      if (failed.ok) expect(failed.data.research.marketSnapshot).toBeDefined();
      expect(await research(ctx, 'explicit-retry')).toMatchObject({
        ok: true,
        data: { research: { status: 'complete' } },
      });
    }
  });

  it('retains owner and source validation for market research and rejects foreign consensus references', async () => {
    const { ctx, generate } = await fixture();
    await ctx.repos.chat.saveSession({
      id: 'foreign-session',
      accountId: 'other-account',
      title: 'other',
      createdAt: now,
      updatedAt: now,
    });
    expect(
      await researchInvestmentDirectionsTool.execute(
        {
          requestId: 'forged',
          question: '研究方向',
          source: { sessionId: 'foreign-session', messageId: 'not-owned' },
        },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    expect(generate).not.toHaveBeenCalled();
    const result = await research(ctx);
    if (!result.ok) throw new Error('fixture');
    const foreign = { ...ctx, user: { ...ctx.user, id: 'other-user' } };
    expect(
      await saveInvestmentConsensusTool.execute(confirmation(result.data.research), foreign),
    ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    expect(
      await getInvestmentWorkspaceTool.execute({ researchId: result.data.research.id }, foreign),
    ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  });
});
