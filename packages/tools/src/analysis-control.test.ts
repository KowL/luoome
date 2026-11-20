import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMGenerateRequest, ToolContext } from '@luoome/core';
import { analyzePositionTool } from '@luoome/plugin-analysis/tools/analyze-position.js';
import { analyzeStockTool } from '@luoome/plugin-analysis/tools/analyze-stock.js';
import { analyzeStrategyCandidateTool } from '@luoome/plugin-analysis/tools/analyze-strategy-candidate.js';
import { marketOutlookTool } from '@luoome/plugin-analysis/tools/market-outlook.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeStrategy,
  makeStrategyRun,
  makeStrategyVersion,
} from '../../db/src/repository/contract-tests.js';
import { createPluginExecutionPolicy } from './plugin-policy.js';
import { buildTestContext, createTestPluginControl } from './testing/context.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = 'business.analysis' as const;
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-analysis-'));
  roots.push(root);
  const { store, set: setPlugin } = createTestPluginControl(root);
  const policy = createPluginExecutionPolicy(
    store,
    new Set(['read', 'advice', 'write', 'external']),
  );
  const now = new Date('2026-11-13T02:00:00Z');
  const ctx = await buildTestContext({ advices: [], clock: () => now, executionPolicy: policy });
  const set = (enabled: boolean) => setPlugin(id, enabled);
  return { ctx, store, policy, set };
};
const candidate = { strategyId: 'strategy-1', runId: 'analysis-run', stockId: '002594.SZ' };
const seedCandidate = async (ctx: ToolContext) => {
  await ctx.repos.strategy.create(
    makeStrategy('strategy-1', { status: 'active', currentVersionId: 'strategy-1-v1' }),
  );
  await ctx.repos.strategy.createVersion(
    makeStrategyVersion('strategy-1', 1, { publishedAt: new Date('2026-01-01') }),
  );
  await ctx.repos.strategyRun.saveStartedRun(
    makeStrategyRun(candidate.runId, {
      status: 'running',
      finishedAt: undefined,
      summary: undefined,
    }),
  );
  await ctx.repos.strategyRun.commitRun({
    run: makeStrategyRun(candidate.runId),
    results: [
      {
        runId: candidate.runId,
        stockId: candidate.stockId,
        selected: true,
        ruleEvaluations: [],
        evidence: ['stored result'],
        dataAsOf: ctx.clock(),
      },
    ],
    signals: [],
  });
};
const cases = [
  { name: 'stock', tool: analyzeStockTool, input: { stockId: '002594.SZ' } },
  { name: 'position', tool: analyzePositionTool, input: { holdingId: 'test-holding-002594' } },
  { name: 'market scope', tool: analyzeStockTool, input: { scope: 'market' } },
  { name: 'legacy market', tool: marketOutlookTool, input: {} },
  {
    name: 'candidate scope',
    tool: analyzeStockTool,
    input: { scope: 'strategy-candidate', ...candidate },
  },
  { name: 'legacy candidate', tool: analyzeStrategyCandidateTool, input: candidate },
];
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('analysis plugin admission and Advice publication', () => {
  it.each(cases)(
    'starts disabled and rejects $name before any model or market access',
    async ({ tool, input }) => {
      const { ctx } = await setup();
      const model = vi.spyOn(ctx.adapters.llm, 'generate');
      const quote = vi.spyOn(ctx.adapters.market, 'fetchQuote');
      const bars = vi.spyOn(ctx.adapters.market, 'fetchDailyBars');
      expect(await tool.execute(input, ctx)).toMatchObject({
        ok: false,
        error: { kind: 'permission_denied', required: `plugin:${id}` },
      });
      expect(model).not.toHaveBeenCalled();
      expect(quote).not.toHaveBeenCalled();
      expect(bars).not.toHaveBeenCalled();
      expect(await ctx.repos.advice.query({ includeExpired: true })).toEqual([]);
    },
  );

  it.each(cases)(
    'discards late $name model results without publishing after the plugin is disabled',
    async ({ tool, input, name }) => {
      const { ctx, set } = await setup();
      set(true);
      if (name.includes('candidate')) await seedCandidate(ctx);
      const started = deferred(),
        release = deferred();
      const original = ctx.adapters.llm.generate.bind(ctx.adapters.llm);
      let calls = 0;
      const slow: ToolContext = {
        ...ctx,
        adapters: {
          ...ctx.adapters,
          llm: {
            name: 'paused-model',
            generate: async <T>(request: LLMGenerateRequest) => {
              calls++;
              started.resolve();
              await release.promise;
              return original<T>(request);
            },
          },
        },
      };
      const active = tool.execute(input, slow);
      try {
        await Promise.race([
          started.promise,
          active.then((result) => {
            if (calls === 0) throw new Error(JSON.stringify(result));
          }),
        ]);
        set(false);
      } finally {
        release.resolve();
      }
      expect(await active).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
      expect(calls).toBe(1);
      expect(await ctx.repos.advice.query({ includeExpired: true })).toEqual([]);
    },
  );

  it('rechecks immediately before the model after slow input collection', async () => {
    const { ctx, set } = await setup();
    set(true);
    const started = deferred(),
      release = deferred();
    const fetchBars = ctx.adapters.market.fetchDailyBars.bind(ctx.adapters.market);
    vi.spyOn(ctx.adapters.market, 'fetchDailyBars').mockImplementation(async (...args) => {
      started.resolve();
      await release.promise;
      return fetchBars(...args);
    });
    const model = vi.spyOn(ctx.adapters.llm, 'generate');
    const active = analyzeStockTool.execute({ stockId: '002594.SZ' }, ctx);
    await started.promise;
    set(false);
    release.resolve();
    expect(await active).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    expect(model).not.toHaveBeenCalled();
  });

  it('fences the write if revoked after model validation and before repository admission', async () => {
    const { ctx, set } = await setup();
    set(true);
    const save = ctx.repos.advice.save.bind(ctx.repos.advice);
    ctx.repos.advice.save = async (advice) => {
      set(false);
      await save(advice);
    };
    expect(await analyzeStockTool.execute({ stockId: '002594.SZ' }, ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(await ctx.repos.advice.query({ includeExpired: true })).toEqual([]);
  });

  it('rejects missing policies and unknown/removed configurations without creating Advice', async () => {
    const { ctx, store, set } = await setup();
    set(true);
    const { executionPolicy: _policy, ...uncontrolled } = ctx;
    expect(await analyzeStockTool.execute({ stockId: '002594.SZ' }, uncontrolled)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    writeFileSync(store.path, '{"version":999}');
    expect(await analyzeStockTool.execute({ stockId: '002594.SZ' }, ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    rmSync(store.path);
    expect(await analyzeStockTool.execute({ stockId: '002594.SZ' }, ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(await ctx.repos.advice.query({ includeExpired: true })).toEqual([]);
  });
});
