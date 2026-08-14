import {
  BUILTIN_STRATEGY_TEMPLATES,
  type DailyBar,
  type LimitUpLadder,
  type LimitUpLadderManagerLike,
  type MarketDataAdapterLike,
  money,
  type Strategy,
  type StrategyDslV1,
  type StrategySignalEmission,
  type StrategyVersion,
  strategyDefinitionHash,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext, seedTestDailyBars, seedTestStockUniverse } from '../testing/context.js';
import { prepareStrategyDataTool } from './prepare-strategy-data.js';
import { runStrategyTool } from './run-strategy.js';

const seedStrategy = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  emission?: StrategySignalEmission,
): Promise<void> => {
  const now = new Date('2026-07-28T09:00:00Z');
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [
        {
          id: 'positive-price',
          name: '价格有效',
          when: 'quote.close > 0',
          evidence: ['价格有效'],
        },
      ],
    },
    scoring: {
      method: 'weighted-sum',
      components: [{ ruleId: 'positive-price', score: '50', weight: 1 }],
    },
    signals: {
      entry: [
        {
          id: 'entry',
          name: '研究信号',
          when: 'quote.close > 0',
          score: '60',
          direction: 'bullish',
          evidence: ['仅供研究'],
          ...(emission === undefined ? {} : { emission }),
        },
      ],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: 'scan-strategy-v1',
    strategyId: 'scan-strategy',
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  };
  const strategy: Strategy = {
    id: 'scan-strategy',
    name: '扫描策略',
    description: '测试扫描策略',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.repos.strategy.create(strategy);
  await ctx.repos.strategy.createVersion(version);
};

const seedReplayBars = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  dates: readonly Date[],
): Promise<void> => {
  await ctx.repos.dailyBar.saveMany(
    dates.map((date) => ({
      stockId: '600519.SH',
      date,
      open: money(10),
      high: money(11),
      low: money(9),
      close: money(10),
      volume: 1_000_000,
      adjustment: 'qfq' as const,
      source: 'test',
    })),
  );
};

describe('run_strategy', () => {
  it('正式扫描的天梯字段只来自真实 limit-up-ladder manager，并写入 coverage', async () => {
    const now = new Date('2026-08-14T07:00:00.000Z');
    let requestedDate: string | undefined;
    const ctx = await buildTestContext({
      clock: () => now,
      limitUpLadder: {
        name: 'limit-up-ladder',
        sources: ['eastmoney'],
        fetchLadder: async ({ date }) => {
          requestedDate = date;
          return {
            ok: true,
            data: {
              date,
              total: 1,
              maxLevel: 3,
              source: 'eastmoney' as const,
              levels: [
                {
                  level: 3,
                  name: '3 连板',
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
                      reason: '测试不可作为生产数据',
                      price: 100,
                      rawClose: 100,
                      corrected: false,
                      changePct: 0.1,
                      limitUpDate: date,
                      board: 'main_board' as const,
                    },
                  ],
                },
              ],
              warnings: [],
              asOf: now,
            },
          };
        },
        compareLadder: async () => ({
          ok: false,
          error: {
            kind: 'adapter_error' as const,
            adapter: 'limit-up-ladder' as const,
            message: 'not used',
            recoverable: false,
          },
        }),
      } satisfies LimitUpLadderManagerLike,
    });
    await seedTestStockUniverse(ctx, { limit: 1, observedAt: now });
    await seedStrategy(ctx);
    const base = await ctx.repos.strategy.findVersionById('scan-strategy-v1');
    if (base === null) throw new Error('fixture version missing');
    const definition: StrategyDslV1 = {
      ...base.definition,
      selection: {
        logic: 'all',
        rules: [
          {
            id: 'ladder',
            name: '连板高度',
            when: 'meta.limitUpLevel >= 3 && meta.limitUpToday === true',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Strategy evidence placeholder
            evidence: ['${meta.limitUpLevel}板'],
          },
        ],
      },
      scoring: undefined,
      signals: { entry: [], exit: [], risk: [] },
    };
    const versionId = 'scan-strategy-ladder-v2';
    await ctx.repos.strategy.createVersion({
      ...base,
      id: versionId,
      version: 2,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      publishedAt: undefined,
      parentVersionId: base.id,
    });
    await ctx.repos.strategy.setVersionValidation(versionId, { status: 'valid', errors: [] });
    await ctx.repos.strategy.publishVersion('scan-strategy', versionId, now);

    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(requestedDate).toBe('2026-08-14');
    expect(result.data.results[0]).toMatchObject({ selected: true });
    expect(result.data.results[0]?.ruleEvaluations[0]).toMatchObject({
      status: 'matched',
      inputs: expect.arrayContaining([
        { path: 'meta.limitUpLevel', status: 'available', value: 3 },
        { path: 'meta.limitUpToday', status: 'available', value: true },
      ]),
    });
    expect(result.data.run.providerCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: 'limit-up-ladder',
          provider: 'limit-up-ladder',
          requested: 1,
          succeeded: 1,
          missing: 0,
          freshness: 'fresh',
        }),
      ]),
    );
    await expect(
      ctx.repos.limitUpLadderSnapshot.findByDate({ date: '2026-08-14', source: 'eastmoney' }),
    ).resolves.toMatchObject({ date: '2026-08-14', total: 1, maxLevel: 3 });
  });

  it('历史 replay 没有 PIT 天梯快照时保持 unknown，不读取当前天梯', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const base = await ctx.repos.strategy.findVersionById('scan-strategy-v1');
    if (base === null) throw new Error('fixture version missing');
    const definition: StrategyDslV1 = {
      ...base.definition,
      selection: {
        logic: 'all',
        rules: [
          {
            id: 'ladder',
            name: '连板高度',
            when: 'meta.limitUpLevel >= 3',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Strategy evidence placeholder
            evidence: ['${meta.limitUpLevel}板'],
          },
        ],
      },
      scoring: undefined,
      signals: { entry: [], exit: [], risk: [] },
    };
    const versionId = 'scan-strategy-ladder-v2';
    await ctx.repos.strategy.createVersion({
      ...base,
      id: versionId,
      version: 2,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      publishedAt: undefined,
      parentVersionId: base.id,
    });
    await ctx.repos.strategy.setVersionValidation(versionId, { status: 'valid', errors: [] });
    await ctx.repos.strategy.publishVersion(
      'scan-strategy',
      versionId,
      new Date('2026-07-01T00:00:00.000Z'),
    );
    const result = await runStrategyTool.execute(
      {
        strategyId: 'scan-strategy',
        mode: 'replay',
        asOf: new Date('2026-07-01T00:00:00.000Z'),
        stockIds: ['600519.SH'],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results[0]).toMatchObject({ selected: false });
    expect(result.data.results[0]?.ruleEvaluations[0]).toMatchObject({
      status: 'unknown',
      error: '缺少字段: meta.limitUpLevel',
    });
    expect(result.data.run.providerStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'historical:limit-up-ladder',
          ok: false,
          errorKind: 'historical_snapshot_unavailable',
        }),
      ]),
    );
    expect(result.data.run.providerCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: 'limit-up-ladder',
          freshness: 'unavailable',
          missing: 1,
          errorKinds: ['historical_snapshot_unavailable'],
        }),
      ]),
    );
  });

  it('历史 replay 读取已持久化 PIT 天梯，不调用当前 manager', async () => {
    const asOf = new Date('2026-07-01T00:00:00.000Z');
    const ctx = await buildTestContext({
      limitUpLadder: {
        name: 'limit-up-ladder',
        sources: ['eastmoney'],
        fetchLadder: async () => {
          throw new Error('current manager must not be called during replay');
        },
        compareLadder: async () => {
          throw new Error('current manager must not be called during replay');
        },
      },
    });
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const base = await ctx.repos.strategy.findVersionById('scan-strategy-v1');
    if (base === null) throw new Error('fixture version missing');
    const definition: StrategyDslV1 = {
      ...base.definition,
      selection: {
        logic: 'all',
        rules: [
          {
            id: 'ladder',
            name: '连板高度',
            when: 'meta.limitUpLevel >= 3 && meta.limitUpToday === true',
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Strategy evidence placeholder
            evidence: ['${meta.limitUpLevel}板'],
          },
        ],
      },
      scoring: undefined,
      signals: { entry: [], exit: [], risk: [] },
    };
    const versionId = 'scan-strategy-ladder-pit-v2';
    await ctx.repos.strategy.createVersion({
      ...base,
      id: versionId,
      version: 2,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      publishedAt: undefined,
      parentVersionId: base.id,
    });
    await ctx.repos.strategy.setVersionValidation(versionId, { status: 'valid', errors: [] });
    await ctx.repos.strategy.publishVersion('scan-strategy', versionId, asOf);
    const snapshot: LimitUpLadder = {
      date: '2026-07-01',
      total: 1,
      maxLevel: 3,
      source: 'eastmoney',
      levels: [
        {
          level: 3,
          name: '3 连板',
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
              reason: '历史快照',
              price: 100,
              rawClose: 100,
              corrected: false,
              changePct: 0.1,
              limitUpDate: '2026-07-01',
              board: 'main_board',
            },
          ],
        },
      ],
      warnings: [],
      asOf,
    };
    await ctx.repos.limitUpLadderSnapshot.save(snapshot);
    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', mode: 'replay', asOf, stockIds: ['600519.SH'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results[0]).toMatchObject({ selected: true });
    expect(result.data.run.providerStatuses).toEqual(
      expect.arrayContaining([{ provider: 'historical:limit-up-ladder', ok: true }]),
    );
    expect(result.data.run.providerCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: 'limit-up-ladder',
          provider: 'historical:limit-up-ladder',
          succeeded: 1,
          missing: 0,
          freshness: 'fresh',
          dataAsOf: asOf,
        }),
      ]),
    );
  });

  it('uses active StockUniverse, ranks deterministically and atomically persists', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 2 });
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH', '300750.SZ'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.status).toBe('complete');
    expect(result.data.results.map((item) => [item.stockId, item.rank])).toEqual([
      ['300750.SZ', 1],
      ['600519.SH', 2],
    ]);
    expect(result.data.signals).toHaveLength(2);
    expect(result.data.run.inputSnapshot).toMatchObject({
      schemaVersion: 3,
      scope: 'evaluation',
      universeKind: 'explicit',
      strategyVersionId: 'scan-strategy-v1',
      coverage: 'CN_A_SHARES_SH_SZ',
      stockIds: ['300750.SZ', '600519.SH'],
      requestedBy: 'manual',
    });
    expect(result.data.run.inputSnapshot.stockIdChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.data.run.summary).toMatchObject({
      schemaVersion: 4,
      dataHealth: 'complete',
      universeCount: 2,
      evaluatedCount: 2,
      selectedCount: 2,
      signalCount: 2,
      incompleteCount: 0,
      failedCount: 0,
    });
    expect(await ctx.repos.strategyRun.findRunById(result.data.run.id)).not.toBeNull();
    expect(await ctx.repos.strategyRun.listResults(result.data.run.id)).toHaveLength(2);
    const observations = await ctx.repos.signalObservation.list({
      sourceKind: 'strategy-signal',
    });
    expect(observations).toEqual([]);
  });

  it('keeps the current scan cutoff when one stock has stale observations', async () => {
    const now = new Date('2026-08-12T09:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(base, { limit: 2, observedAt: now });
    await seedStrategy(base);
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchQuote: async (stockId) => {
        const quote = await base.adapters.market.fetchQuote(stockId);
        const observedAt = stockId === '600519.SH' ? new Date('2026-07-13T00:00:00.000Z') : now;
        return { ...quote, observedAt, ts: observedAt };
      },
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };

    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['300750.SZ', '600519.SH'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.dataAsOf).toEqual(now);
    expect(result.data.results.map((item) => item.dataAsOf).sort()).toEqual(
      [new Date('2026-07-13T00:00:00.000Z'), now].sort(),
    );
  });

  it('dry-run does not persist', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'], persist: false },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.persisted).toBe(false);
    expect(await ctx.repos.strategyRun.findRunById(result.data.run.id)).toBeNull();
    expect(await ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' })).toEqual([]);
  });

  it('checks the fence with a fresh clock value immediately before commit', async () => {
    let nowMs = new Date('2026-08-12T09:00:00.000Z').getTime();
    const base = await buildTestContext({ clock: () => new Date(nowMs++) });
    await seedTestStockUniverse(base, { limit: 1, observedAt: new Date(nowMs - 1) });
    await seedStrategy(base);
    const commitTimes: Date[] = [];
    const strategyRun = new Proxy(base.repos.strategyRun, {
      get(target, property, receiver) {
        if (property === 'commitRunWithFence') {
          return async (input: Parameters<typeof target.commitRunWithFence>[0]) => {
            commitTimes.push(input.now);
            return target.commitRunWithFence(input);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = { ...base, repos: { ...base.repos, strategyRun } };

    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commitTimes[0]?.getTime()).toBeGreaterThan(result.data.run.finishedAt?.getTime() ?? 0);
  });

  it('scheduled run reads the checkpoint revision instead of a later mutable projection', async () => {
    const now = new Date('2026-08-12T09:00:00.000Z');
    const base = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(base, { limit: 1, observedAt: now });
    await seedStrategy(base);
    const checkpointBar: DailyBar = {
      stockId: '600519.SH',
      date: new Date('2026-08-12T00:00:00.000Z'),
      open: money(10),
      high: money(11),
      low: money(9),
      close: money(10),
      volume: 1_000_000,
      adjustment: 'qfq',
      source: 'checkpoint-fixture',
    };
    const ctx = {
      ...base,
      adapters: {
        ...base.adapters,
        market: {
          ...base.adapters.market,
          fetchDailyBars: () => Promise.resolve([checkpointBar]),
        },
      },
    };
    const prepared = await prepareStrategyDataTool.execute({ strategyId: 'scan-strategy' }, ctx);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    await ctx.repos.dailyBar.saveMany([{ ...checkpointBar, close: money(99) }]);
    const result = await runStrategyTool.execute(
      {
        strategyId: 'scan-strategy',
        mode: 'scheduled',
        dataCheckpointId: prepared.data.checkpoint.id,
      },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.signals[0]?.evaluationSnapshot.baseline).toMatchObject({ price: 10 });
    expect(result.data.run.inputSnapshot).toMatchObject({
      dataCheckpoint: {
        id: prepared.data.checkpoint.id,
        checksum: prepared.data.checkpoint.dataChecksum,
      },
    });
  });

  it('allows a validated unpublished version only for persist=false trial', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const base = await ctx.repos.strategy.findVersionById('scan-strategy-v1');
    if (base === null) throw new Error('fixture version missing');
    const draft = {
      ...base,
      id: 'scan-strategy-v2-draft',
      version: 2,
      publishedAt: undefined,
      parentVersionId: base.id,
      validationStatus: 'valid' as const,
    };
    await ctx.repos.strategy.createVersion(draft);
    const trial = await runStrategyTool.execute(
      {
        strategyId: 'scan-strategy',
        versionId: draft.id,
        stockIds: ['600519.SH'],
        persist: false,
      },
      ctx,
    );
    expect(trial.ok).toBe(true);
    if (!trial.ok) return;
    expect(trial.data.persisted).toBe(false);
    expect(trial.data.run.strategyVersionId).toBe(draft.id);
    const formal = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', versionId: draft.id, stockIds: ['600519.SH'] },
      ctx,
    );
    expect(formal.ok).toBe(false);
  });

  it('keeps a committed run successful when derived observation persistence fails', async () => {
    const base = await buildTestContext();
    await seedTestStockUniverse(base, { limit: 1 });
    await seedStrategy(base);
    const observationRepo = base.repos.signalObservation;
    const warnings: unknown[] = [];
    const ctx = {
      ...base,
      repos: {
        ...base.repos,
        signalObservation: {
          findById: observationRepo.findById.bind(observationRepo),
          list: observationRepo.list.bind(observationRepo),
          removeBySources: observationRepo.removeBySources.bind(observationRepo),
          save: () => Promise.reject(new Error('observation storage unavailable')),
        },
      },
      logger: { ...base.logger, warn: (...args: unknown[]) => warnings.push(args) },
    };

    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'] },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await base.repos.strategyRun.findRunById(result.data.run.id)).not.toBeNull();
    expect(warnings).toHaveLength(0);
  });

  it('one stock data failure completes the run and exposes partial data health', async () => {
    const base = await buildTestContext();
    await seedTestStockUniverse(base, { limit: 2 });
    await seedStrategy(base);
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchQuote: (stockId) =>
        stockId === '300750.SZ'
          ? Promise.reject(new Error('quote unavailable'))
          : base.adapters.market.fetchQuote(stockId),
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };
    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['300750.SZ', '600519.SH'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.status).toBe('complete');
    expect(result.data.results).toHaveLength(1);
    expect(result.data.run.summary).toMatchObject({
      schemaVersion: 4,
      dataHealth: 'partial',
      failedCount: 1,
      evaluatedCount: 1,
    });
  });

  it('withholds a manual full-universe run when data acceptance rejects it', async () => {
    const base = await buildTestContext();
    await seedTestStockUniverse(base, { limit: 2 });
    await seedStrategy(base);
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchQuote: (stockId) =>
        stockId === '300750.SZ'
          ? Promise.reject(new Error('quote unavailable'))
          : base.adapters.market.fetchQuote(stockId),
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };
    const result = await runStrategyTool.execute({ strategyId: 'scan-strategy' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.status).toBe('complete');
    expect(result.data.run.scope).toBe('operational');
    expect(result.data.run.summary).toMatchObject({
      schemaVersion: 4,
      dataHealth: 'partial',
      failedCount: 1,
      evaluatedCount: 1,
    });
    expect(result.data.run.publication).toMatchObject({
      status: 'withheld',
      reasons: ['acceptance-rejected'],
    });
  });

  it('prepares derived meta fields required by strategies created from builtin templates', async () => {
    const base = await buildTestContext();
    await seedTestStockUniverse(base, { limit: 1 });
    const template = BUILTIN_STRATEGY_TEMPLATES.find(
      (candidate) => candidate.id === 'pullback-after-limit-up',
    );
    if (template === undefined) throw new Error('builtin template fixture missing');
    const strategyId = 'pullback-after-limit-up-user';
    const versionId = `${strategyId}-v1`;
    const createdAt = new Date('2026-07-01T00:00:00.000Z');
    await base.repos.strategy.create({
      id: strategyId,
      name: template.name,
      description: template.description,
      owner: 'user',
      status: 'active',
      currentVersionId: versionId,
      createdAt,
      updatedAt: createdAt,
    });
    await base.repos.strategy.createVersion({
      id: versionId,
      strategyId,
      version: 1,
      definition: template.definition,
      definitionHash: template.definitionHash,
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: createdAt,
      createdAt,
    });
    const closes = [...Array.from({ length: 16 }, () => 100), 110, 111, 112, 113];
    const bars: DailyBar[] = closes.map((close, index) => ({
      stockId: '600519.SH',
      date: new Date(Date.UTC(2026, 6, index + 1)),
      open: money(close),
      high: money(close),
      low: money(close),
      close: money(close),
      volume: 1_000_000,
      adjustment: 'qfq',
      source: 'meta-fixture',
    }));
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchDailyBars: () => Promise.resolve(bars),
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };

    const result = await runStrategyTool.execute({ strategyId, stockIds: ['600519.SH'] }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run).toMatchObject({
      status: 'complete',
      summary: { schemaVersion: 4, dataHealth: 'complete' },
    });
    expect(result.data.results[0]).toMatchObject({ selected: true, score: 75 });
    expect(
      result.data.results[0]?.ruleEvaluations.flatMap((evaluation) =>
        'inputs' in evaluation ? evaluation.inputs : [],
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'meta.recentLimitUp', status: 'available', value: true }),
      ]),
    );
    expect(result.data.results[0]?.evidence).toContain('近 3 日内涨停');
    expect(
      result.data.run.providerStatuses.some((status) => status.provider === 'strategy-meta'),
    ).toBe(false);
  });

  it('all candidate data failures yield failed without partial persistence', async () => {
    const base = await buildTestContext();
    await seedTestStockUniverse(base, { limit: 1 });
    await seedStrategy(base);
    const market: MarketDataAdapterLike = {
      ...base.adapters.market,
      fetchQuote: () => Promise.reject(new Error('provider down')),
    };
    const ctx = { ...base, adapters: { ...base.adapters, market } };
    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['600519.SH'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.status).toBe('failed');
    expect(result.data.results).toEqual([]);
    expect(await ctx.repos.strategyRun.findRunById(result.data.run.id)).toMatchObject({
      status: 'failed',
    });
  });

  it('rejects candidates outside the authoritative active universe', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      { strategyId: 'scan-strategy', stockIds: ['002594.SZ'] },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('refuses full-universe replay without a historical universe snapshot', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      {
        strategyId: 'scan-strategy',
        mode: 'replay',
        asOf: new Date('2026-07-01T00:00:00Z'),
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects scan with asOf（历史 bars 与实时 quote 时点不一致）', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      {
        strategyId: 'scan-strategy',
        stockIds: ['600519.SH'],
        asOf: new Date('2026-07-01T00:00:00Z'),
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('replay 的 providerStatuses 只报本地 dailyBar，不以 market adapter 名义上报', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedTestDailyBars(ctx);
    await seedStrategy(ctx);
    const result = await runStrategyTool.execute(
      {
        strategyId: 'scan-strategy',
        mode: 'replay',
        asOf: new Date('2026-07-01T00:00:00Z'),
        stockIds: ['600519.SH'],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.run.providerStatuses.map((status) => status.provider)).toEqual([
      'local:daily-bars',
    ]);
  });

  it('edge 前态读取上一运行的 matched evaluation，连续 Day1/Day2/Day3 不重复发 signal', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx, { mode: 'edge', cooldownTradingDays: 0 });
    const days = [
      new Date('2026-07-27T00:00:00.000Z'),
      new Date('2026-07-28T00:00:00.000Z'),
      new Date('2026-07-29T00:00:00.000Z'),
    ];
    await seedReplayBars(ctx, days);
    const runs = [];
    for (const asOf of days) {
      const run = await runStrategyTool.execute(
        {
          strategyId: 'scan-strategy',
          mode: 'replay',
          asOf,
          stockIds: ['600519.SH'],
          evaluationSessionId: 'evaluation-edge',
        },
        ctx,
      );
      expect(run.ok, JSON.stringify(run)).toBe(true);
      if (!run.ok) return;
      runs.push(run.data);
    }
    expect(runs.map((run) => run.signals)).toHaveLength(3);
    expect(runs.map((run) => run.signals.length)).toEqual([1, 0, 0]);
    expect(runs[1]?.results[0]?.ruleEvaluations).toEqual(
      expect.arrayContaining([expect.objectContaining({ ruleId: 'entry', status: 'matched' })]),
    );
  });

  it('cooldown 以最近真正 emitted signal 计数，并跨国庆假期保持有效', async () => {
    const ctx = await buildTestContext();
    await seedTestStockUniverse(ctx, { limit: 1 });
    await seedStrategy(ctx, { mode: 'level', cooldownTradingDays: 3 });
    const days = [
      new Date('2026-06-18T00:00:00.000Z'),
      new Date('2026-06-22T00:00:00.000Z'),
      new Date('2026-06-23T00:00:00.000Z'),
    ];
    await seedReplayBars(ctx, days);
    const signals: number[] = [];
    for (const asOf of days) {
      const run = await runStrategyTool.execute(
        {
          strategyId: 'scan-strategy',
          mode: 'replay',
          asOf,
          stockIds: ['600519.SH'],
          evaluationSessionId: 'evaluation-cooldown',
        },
        ctx,
      );
      expect(run.ok, JSON.stringify(run)).toBe(true);
      if (!run.ok) return;
      signals.push(run.data.signals.length);
    }
    expect(signals).toEqual([1, 0, 0]);
  });
});
