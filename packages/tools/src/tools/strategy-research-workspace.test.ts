import {
  type DailyBarRevision,
  type LimitUpLadderManagerLike,
  money,
  type ToolContext,
} from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { buildTestContext, seedTestStockUniverse } from '../testing/context.js';
import { runStrategyTool } from './run-strategy.js';
import { getStrategyDataPreflightTool } from './strategy-data-preflight.js';
import { trialStrategyVersionTool } from './strategy-definition.js';
import {
  getStrategyEvaluationProgressTool,
  startStrategyEvaluationSessionTool,
} from './strategy-evaluation.js';
import {
  createStrategyTool,
  createStrategyVersionTool,
  publishStrategyVersionTool,
  validateStrategyVersionTool,
} from './strategy-lifecycle.js';
import { exportStrategyManifestTool } from './strategy-manifest.js';
import {
  getStrategyResearchStateTool,
  getStrategySelectionDiagnosticsTool,
  runStrategyResearchComparisonTool,
  saveStrategyResearchStateTool,
} from './strategy-research.js';

const NOW = new Date('2026-08-12T08:00:00.000Z');
const definition = (when = 'quote.close > 50', style = 'base') => ({
  schemaVersion: 1 as const,
  metadata: { style },
  universe: { coverage: 'CN_A_SHARES_SH_SZ' as const, excludeStockIds: [] },
  selection: {
    logic: 'all' as const,
    rules: [{ id: 'price-rule', name: '研究规则', when, evidence: ['规则事实'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
});
const setup = async (when?: string, ladder?: LimitUpLadderManagerLike) => {
  const ctx = await buildTestContext({
    clock: () => NOW,
    ...(ladder === undefined ? {} : { limitUpLadder: ladder }),
  });
  await seedTestStockUniverse(ctx, { limit: 1, observedAt: new Date('2026-08-01T00:00:00Z') });
  await createStrategyTool.execute(
    { id: 'research-test', name: '研究测试', description: '合成事实' },
    ctx,
  );
  const versions = [];
  for (const style of ['base', 'candidate']) {
    const created = await createStrategyVersionTool.execute(
      { strategyId: 'research-test', definition: definition(when, style) },
      ctx,
    );
    if (!created.ok) throw new Error(JSON.stringify(created));
    await validateStrategyVersionTool.execute({ versionId: created.data.version.id }, ctx);
    versions.push(created.data.version.id);
  }
  const baseVersionId = versions[0] as string;
  const draftVersionId = versions[1] as string;
  return {
    ctx,
    input: { strategyId: 'research-test', baseVersionId, draftVersionId, stockIds: ['600519.SH'] },
  };
};
const revision = (date: string, recordedAt = NOW, close = 100): DailyBarRevision => ({
  stockId: '600519.SH',
  date: new Date(`${date}T00:00:00Z`),
  contentHash: `${date}:${close}`,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1000,
  source: 'synthetic-research-test',
  recordedAt,
});

describe('strategy research controlled inputs', () => {
  it('reads changing quotes once and binds both results to the same fact hash and time', async () => {
    const { ctx, input } = await setup();
    const original = ctx.adapters.market.fetchQuote.bind(ctx.adapters.market);
    const quotes = vi.spyOn(ctx.adapters.market, 'batchQuote').mockImplementation(async (ids) => {
      const close = money(quotes.mock.calls.length === 1 ? 100 : 1);
      return new Map(
        await Promise.all(
          ids.map(
            async (id) =>
              [
                id,
                { ...(await original(id)), open: close, high: close, low: close, close },
              ] as const,
          ),
        ),
      );
    });
    const bars = vi.spyOn(ctx.adapters.market, 'fetchDailyBars');
    const result = await trialStrategyVersionTool.execute(input, ctx);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(quotes).toHaveBeenCalledTimes(1);
    expect(bars).not.toHaveBeenCalled();
    expect(result.data.base.results[0]?.selected).toBe(true);
    expect(result.data.draft.results[0]?.selected).toBe(true);
    expect(result.data.base.run.dataAsOf).toEqual(result.data.draft.run.dataAsOf);
    const snapshots = [result.data.base.run.inputSnapshot, result.data.draft.run.inputSnapshot];
    for (const snapshot of snapshots)
      expect(snapshot).toMatchObject({
        dataCheckpoint: { checksum: result.data.inputIdentity.snapshotHash },
      });
    expect(result.data.inputIdentity).toMatchObject({
      persisted: false,
      reproducibility: 'memory-only',
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: input.strategyId })).toHaveLength(0);
  });

  it('freezes daily bars for both sides and keeps total provider failure missing rather than zero', async () => {
    const { ctx, input } = await setup('indicators.ma5 > 50');
    const bars = vi.spyOn(ctx.adapters.market, 'fetchDailyBars').mockImplementation(async () =>
      Array.from({ length: 5 }, (_, i) => ({
        ...revision(
          `2026-08-${String(6 + i).padStart(2, '0')}`,
          NOW,
          bars.mock.calls.length === 1 ? 100 : 1,
        ),
        open: money(bars.mock.calls.length === 1 ? 100 : 1),
        high: money(100),
        low: money(1),
        close: money(bars.mock.calls.length === 1 ? 100 : 1),
        adjustment: 'qfq' as const,
      })),
    );
    const result = await trialStrategyVersionTool.execute(input, ctx);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) {
      expect(result.data.base.results[0]?.selected).toBe(true);
      expect(result.data.draft.results[0]?.selected).toBe(true);
    }
    expect(bars).toHaveBeenCalledTimes(1);
    bars.mockRejectedValue(new Error('provider_timeout'));
    const unavailable = await trialStrategyVersionTool.execute(input, ctx);
    expect(unavailable.ok).toBe(true);
    if (!unavailable.ok) return;
    expect(unavailable.data.base.results).toEqual([]);
    expect(unavailable.data.draft.results).toEqual([]);
    expect(unavailable.data.diagnostics.missingBaseStockIds).toEqual(input.stockIds);
    expect(unavailable.data.diagnostics.missingDraftStockIds).toEqual(input.stockIds);
    expect(unavailable.data.base.run.summary).toMatchObject({
      dataHealth: 'unavailable',
      failedCount: 1,
    });
  });

  it.each([false, true])(
    'shares ladder response or failure without saving a PIT snapshot: failure=%s',
    async (failed) => {
      const fetchLadder = vi.fn<LimitUpLadderManagerLike['fetchLadder']>(async ({ date }) => {
        if (failed)
          return {
            ok: false,
            error: {
              kind: 'adapter_error',
              adapter: 'limit-up-ladder',
              message: 'synthetic unavailable',
              recoverable: true,
            },
          };
        return {
          ok: true,
          data: {
            date,
            source: 'eastmoney',
            asOf: NOW,
            total: 1,
            maxLevel: 3,
            warnings: [],
            levels: [
              {
                level: 3,
                name: '三板',
                count: 1,
                stocks: [
                  {
                    code: '600519',
                    name: '贵州茅台',
                    industry: '白酒',
                    ladderLevel: 3,
                    uncategorized: false,
                    firstTime: '09:31:00',
                    finalTime: '14:50:00',
                    reason: '合成验收',
                    price: 100,
                    rawClose: 100,
                    corrected: false,
                    changePct: 0.1,
                    limitUpDate: date,
                    board: 'main_board',
                  },
                ],
              },
            ],
          },
        };
      });
      const ladder: LimitUpLadderManagerLike = {
        name: 'limit-up-ladder',
        sources: ['eastmoney'],
        status: () => [],
        fetchLadder,
        compareLadder: async () => ({ ok: false }),
      };
      const { ctx, input } = await setup('meta.limitUpLevel >= 2', ladder);
      const save = vi.spyOn(ctx.repos.limitUpLadderSnapshot, 'save');
      const result = await trialStrategyVersionTool.execute(input, ctx);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(fetchLadder).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
      if (!result.ok) return;
      expect(result.data.base.results[0]?.selected).toBe(!failed);
      expect(result.data.draft.results[0]?.selected).toBe(!failed);
      if (failed) expect(result.data.diagnostics.base[0]?.kind).toBe('incomplete');
    },
  );

  it('uses one outer snapshot across bounded candidates and retains invalid candidate failures', async () => {
    const { ctx, input } = await setup();
    const quotes = vi.spyOn(ctx.adapters.market, 'batchQuote');
    const result = await runStrategyResearchComparisonTool.execute(
      { ...input, candidateVersionIds: [input.draftVersionId, 'missing-candidate'] },
      ctx,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(quotes).toHaveBeenCalledTimes(1);
    expect(result.data.candidates.map((row) => [row.candidateVersionId, row.status])).toEqual([
      [input.draftVersionId, 'complete'],
      ['missing-candidate', 'failed'],
    ]);
    expect(result.data.candidates[0]?.comparison?.inputIdentity.snapshotHash).toBe(
      result.data.inputIdentity.snapshotHash,
    );
    expect(result.data.trainingValidation.validationUsedForSelection).toBe(false);
    expect(await ctx.repos.strategy.listVersions(input.strategyId)).toHaveLength(2);
    const saved = await saveStrategyResearchStateTool.execute(
      {
        strategyId: input.strategyId,
        requestId: 'save-comparison',
        expectedRevision: 0,
        state: {
          question: '多个候选的规则敏感性',
          baseVersionId: input.baseVersionId,
          candidateVersionId: input.draftVersionId,
          stockIds: input.stockIds,
          comparison: result.data.record,
        },
      },
      ctx,
    );
    expect(saved).toMatchObject({
      ok: true,
      data: {
        state: {
          comparisons: [
            {
              candidates: [
                { status: 'complete' },
                { candidateVersionId: 'missing-candidate', status: 'failed' },
              ],
            },
          ],
        },
      },
    });
  });

  it('counts incomplete rule results as missing data in saved comparisons', async () => {
    const { ctx, input } = await setup();
    const result = await runStrategyResearchComparisonTool.execute(
      {
        ...input,
        mode: 'replay',
        asOf: '2026-08-10T07:00:00Z',
        candidateVersionIds: [input.draftVersionId],
      },
      ctx,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.data.candidates[0]?.comparison?.diagnostics.draft[0]?.kind).toBe('incomplete');
    expect(result.data.record.candidates[0]).toMatchObject({ selectedCount: 0, missingCount: 1 });
  });

  it('replays both versions from one frozen local revision set without any market calls', async () => {
    const { ctx, input } = await setup();
    const asOf = new Date('2026-08-10T00:00:00Z');
    await ctx.repos.dailyBar.saveRevisions([
      revision('2026-08-10', new Date('2026-08-10T07:00:00Z')),
    ]);
    const network = vi.spyOn(ctx.adapters.market, 'fetchDailyBars');
    const reads = vi.spyOn(ctx.repos.dailyBar, 'listRevisionsForStocks');
    const result = await runStrategyResearchComparisonTool.execute(
      {
        ...input,
        candidateVersionIds: [input.draftVersionId],
        mode: 'replay',
        asOf,
        revisionCutoff: NOW,
      },
      ctx,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(reads).toHaveBeenCalledTimes(1);
    expect(network).not.toHaveBeenCalled();
    expect(result.data.candidates[0]?.comparison?.base.results[0]?.selected).toBe(true);
    expect(result.data.candidates[0]?.comparison?.draft.results[0]?.selected).toBe(true);
    expect(result.data.inputIdentity.reproducibility).toBe('local-revisions');
  });

  it('distinguishes deliberate universe exclusion from missing evaluation data', async () => {
    const { ctx, input } = await setup();
    const versions: string[] = [];
    for (const style of ['filtered-base', 'filtered-candidate']) {
      const created = await createStrategyVersionTool.execute(
        {
          strategyId: input.strategyId,
          definition: {
            ...definition(undefined, style),
            universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: input.stockIds },
          },
        },
        ctx,
      );
      if (!created.ok) throw new Error(JSON.stringify(created));
      await validateStrategyVersionTool.execute({ versionId: created.data.version.id }, ctx);
      versions.push(created.data.version.id);
    }
    const result = await trialStrategyVersionTool.execute(
      { ...input, baseVersionId: versions[0], draftVersionId: versions[1] },
      ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        diagnostics: {
          missingBaseStockIds: [],
          missingDraftStockIds: [],
          excludedByUniverseStockIds: input.stockIds,
        },
      },
    });
  });

  it('rejects overlapping training and validation before touching providers', async () => {
    const { ctx, input } = await setup();
    const quotes = vi.spyOn(ctx.adapters.market, 'batchQuote');
    for (const id of ['training', 'validation'])
      await ctx.repos.strategyEvaluation.saveSession({
        id,
        strategyId: input.strategyId,
        strategyVersionId: input.draftVersionId,
        from: new Date('2026-08-10Z'),
        to: new Date('2026-08-11Z'),
        createdAt: NOW,
        status: 'complete',
        definitionHash: 'a'.repeat(64),
      });
    expect(
      await runStrategyResearchComparisonTool.execute(
        {
          ...input,
          candidateVersionIds: [input.draftVersionId],
          trainingSessionId: 'training',
          validationSessionId: 'validation',
        },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(quotes).not.toHaveBeenCalled();
  });
});

describe('strategy research persisted recovery and qualification', () => {
  it('paginates stored selected, near-miss, excluded and absent rows without refreshing quotes', async () => {
    const { ctx, input } = await setup();
    await seedTestStockUniverse(ctx, {
      syncId: 'diagnostic-universe',
      limit: 4,
      observedAt: new Date('2026-08-02Z'),
    });
    const created = await createStrategyVersionTool.execute(
      {
        strategyId: input.strategyId,
        definition: {
          ...definition(),
          selection: {
            logic: 'all',
            rules: [
              ...definition().selection.rules,
              { id: 'volume-rule', name: '成交量', when: 'quote.volume > 100', evidence: ['量'] },
            ],
          },
          scoring: {
            method: 'weighted-sum',
            components: [{ ruleId: 'price-rule', score: 'quote.close', weight: 1 }],
          },
        },
      },
      ctx,
    );
    if (!created.ok) throw new Error(JSON.stringify(created));
    await validateStrategyVersionTool.execute({ versionId: created.data.version.id }, ctx);
    await publishStrategyVersionTool.execute({ versionId: created.data.version.id }, ctx);
    const original = ctx.adapters.market.fetchQuote.bind(ctx.adapters.market);
    const stockIds = ['600519.SH', '300750.SZ', '002594.SZ', '600036.SH'];
    const quote = async (id: string) => {
      if (id === '600036.SH') throw new Error('provider_timeout');
      const close = money(id === '600519.SH' ? 100 : 40);
      return {
        ...(await original(id)),
        open: close,
        high: close,
        low: close,
        close,
        volume: id === '002594.SZ' ? 0 : 1000,
      };
    };
    vi.spyOn(ctx.adapters.market, 'batchQuote').mockImplementation(
      async (ids) =>
        new Map(
          await Promise.all(
            ids
              .filter((id) => id !== '600036.SH')
              .map(async (id) => [id, await quote(id)] as const),
          ),
        ),
    );
    const fetch = vi.spyOn(ctx.adapters.market, 'fetchQuote').mockImplementation(quote);
    const run = await runStrategyTool.execute({ strategyId: input.strategyId, stockIds }, ctx);
    expect(run.ok, JSON.stringify(run)).toBe(true);
    if (!run.ok) return;
    fetch.mockClear();
    const diagnostics = await getStrategySelectionDiagnosticsTool.execute(
      { strategyId: input.strategyId, runId: run.data.run.id, limit: 2 },
      ctx,
    );
    expect(diagnostics).toMatchObject({
      ok: true,
      data: { total: 4, counts: { selected: 1, ruleNearMiss: 1, excluded: 1, missingResults: 1 } },
    });
    if (diagnostics.ok)
      expect(diagnostics.data.rows[0]?.view?.result.scoringBreakdown).toHaveLength(1);
    const missing = await getStrategySelectionDiagnosticsTool.execute(
      { strategyId: input.strategyId, runId: run.data.run.id, view: 'incomplete' },
      ctx,
    );
    expect(missing).toMatchObject({
      ok: true,
      data: { total: 1, rows: [{ stockId: '600036.SH', missingReason: expect.any(String) }] },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports the real local range and separates later revisions from PIT coverage without network calls', async () => {
    const { ctx, input } = await setup();
    await ctx.repos.dailyBar.saveRevisions([revision('2026-08-10')]);
    const network = vi.spyOn(ctx.adapters.market, 'fetchDailyBars');
    const result = await getStrategyDataPreflightTool.execute(
      {
        strategyId: input.strategyId,
        versionId: input.baseVersionId,
        stockIds: input.stockIds,
        from: '2026-08-10',
        to: '2026-08-11',
      },
      ctx,
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.data.fields[0]).toMatchObject({
      path: 'quote.close',
      totalSamples: 2,
      availableSamples: 1,
      pitAvailableSamples: 0,
      coverageRatio: 0.5,
      pitCoverageRatio: 0,
    });
    expect(result.data.stocks[0]).toMatchObject({
      availableDays: 1,
      pitAvailableDays: 0,
      missingFields: ['quote.close'],
    });
    expect(result.data.layers.historicalEvaluation.status).toBe('partial');
    expect(result.data.layers.strictBacktest.status).toBe('blocked');
    expect(result.data.benchmark.availableDays).toBe(0);
    expect(network).not.toHaveBeenCalled();
  });

  it('restores fixed versions across days, replays identical requests, rejects stale saves and cross-strategy evidence', async () => {
    const { ctx, input } = await setup();
    const saveInput = {
      strategyId: input.strategyId,
      requestId: 'save-question',
      expectedRevision: 0,
      state: {
        question: '提高价格门槛后样本是否变化？',
        baseVersionId: input.baseVersionId,
        candidateVersionId: input.draftVersionId,
        stockIds: input.stockIds,
        nextStep: '等待补齐历史字段',
        conclusion: {
          summary: '当前仅确认规则可求值',
          outcome: 'inconclusive',
          limitations: ['尚无历史验证'],
          evidenceReferences: [`strategy-version:${input.baseVersionId}`],
        },
      },
    };
    const saved = await saveStrategyResearchStateTool.execute(saveInput, ctx);
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    expect(await saveStrategyResearchStateTool.execute(saveInput, ctx)).toMatchObject({
      ok: true,
      data: { replayed: true, state: { revision: 1 } },
    });
    expect(
      await saveStrategyResearchStateTool.execute(
        { ...saveInput, requestId: 'stale-request' },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(
      await saveStrategyResearchStateTool.execute(
        {
          ...saveInput,
          requestId: 'spoof-reference',
          expectedRevision: 1,
          state: {
            ...saveInput.state,
            conclusion: {
              ...saveInput.state.conclusion,
              evidenceReferences: ['strategy-run:foreign-run'],
            },
          },
        },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    await publishStrategyVersionTool.execute({ versionId: input.draftVersionId }, ctx);
    const tomorrow: ToolContext = { ...ctx, clock: () => new Date(NOW.getTime() + 86_400_000) };
    const restored = await getStrategyResearchStateTool.execute(
      { strategyId: input.strategyId },
      tomorrow,
    );
    expect(restored).toMatchObject({
      ok: true,
      data: {
        versionDrift: true,
        state: {
          revision: 1,
          state: { baseVersionId: input.baseVersionId },
          conclusions: [{ conclusion: { outcome: 'inconclusive' } }],
        },
      },
    });
    const other = (await ctx.repos.account.list()).find(
      (account) => account.id !== ctx.user.defaultAccountId,
    );
    if (other !== undefined)
      expect(
        await getStrategyResearchStateTool.execute(
          { strategyId: input.strategyId, accountId: other.id },
          ctx,
        ),
      ).toMatchObject({ ok: true, data: { state: null } });
    const exported = await exportStrategyManifestTool.execute(
      { versionId: input.baseVersionId },
      ctx,
    );
    expect(exported).toMatchObject({
      ok: true,
      data: {
        researchState: { revision: 1 },
        reproducibility: {
          definitionPortable: true,
          marketDataIncluded: false,
          trialSnapshotsIncluded: false,
        },
      },
    });
  });

  it('starts one durable evaluation per request and preserves unknown progress counts', async () => {
    const { ctx, input } = await setup();
    const start = {
      strategyId: input.strategyId,
      versionId: input.baseVersionId,
      from: '2026-08-10',
      to: '2026-08-11',
      stockIds: input.stockIds,
      requestId: 'evaluation-start',
    };
    const created = await startStrategyEvaluationSessionTool.execute(start, ctx);
    if (!created.ok) throw new Error(JSON.stringify(created));
    const replayed = await startStrategyEvaluationSessionTool.execute(start, ctx);
    expect(replayed).toMatchObject({
      ok: true,
      data: { session: { id: created.data.session.id } },
    });
    expect(
      await startStrategyEvaluationSessionTool.execute(
        { ...start, versionId: input.draftVersionId },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    const progress = await getStrategyEvaluationProgressTool.execute(
      { strategyId: input.strategyId, sessionId: created.data.session.id },
      ctx,
    );
    expect(progress).toMatchObject({
      ok: true,
      data: {
        progress: { total: 2, pending: 2 },
        summary: {
          evaluatedCount: null,
          selectedCount: null,
          signalCount: null,
          failedCount: null,
        },
      },
    });
    expect(
      await getStrategyEvaluationProgressTool.execute(
        { strategyId: 'foreign-strategy', sessionId: created.data.session.id },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
  });
});
