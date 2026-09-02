import {
  buildStrategySchedule,
  money,
  type StrategyAutonomyAction,
  type StrategyDslV1,
  strategyDefinitionHash,
  type ToolContext,
} from '@luoome/core';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { strategyAutonomyWeeklyWorkflow } from './strategy-autonomy-weekly.js';

const now = new Date('2026-09-02T08:00:00.000Z');
const baselineAt = new Date('2026-08-20T00:00:00.000Z');
const observedAt = new Date('2026-08-28T00:00:00.000Z');

const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: { style: 'quality', horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'quality', name: '质量门槛', when: 'quote.close > 10', evidence: ['收盘价'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
};

interface SeedOptions {
  readonly id: string;
  readonly name: string;
  /** T+5 完整样本数（stock-day-horizon 去重后）。 */
  readonly samples: number;
  /** 其中 benchmark 不可用的样本数。 */
  readonly withoutBenchmark?: number;
  /** 每个样本的超额收益（returnPct - benchmarkReturnPct）。 */
  readonly excess?: number;
  /** 覆盖策略描述（FakeLLMAdapter 的 proposal-fixture 标记注入点）。 */
  readonly description?: string;
}

const seedActiveStrategy = async (ctx: ToolContext, options: SeedOptions): Promise<void> => {
  const { id, name, samples } = options;
  const withoutBenchmark = options.withoutBenchmark ?? 0;
  const excess = options.excess ?? -0.06;
  await ctx.repos.strategy.create({
    id,
    name,
    description: options.description ?? `${name} 测试`,
    owner: 'user',
    status: 'active',
    currentVersionId: `${id}:v1`,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.repos.strategy.createVersion({
    id: `${id}:v1`,
    strategyId: id,
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: now,
    createdAt: now,
  });
  const stockIds = Array.from(
    { length: samples },
    (_, index) => `60${String(index).padStart(4, '0')}.SH`,
  );
  await ctx.repos.strategyRun.commitRun({
    run: {
      id: `${id}-run-1`,
      strategyId: id,
      strategyVersionId: `${id}:v1`,
      mode: 'scheduled',
      coverage: 'CN_A_SHARES_SH_SZ',
      dataAsOf: baselineAt,
      startedAt: baselineAt,
      finishedAt: baselineAt,
      status: 'complete',
      inputSnapshot: {},
      providerStatuses: [],
      summary: {
        schemaVersion: 3,
        dataHealth: 'complete',
        universeCount: samples,
        evaluatedCount: samples,
        selectedCount: samples,
        signalCount: samples,
        incompleteCount: 0,
        failedCount: 0,
        failureSamples: [],
      },
    },
    results: stockIds.map((stockId, index) => ({
      runId: `${id}-run-1`,
      stockId,
      selected: true,
      score: 80,
      rank: index + 1,
      ruleEvaluations: [
        {
          schemaVersion: 2 as const,
          scope: 'selection' as const,
          ruleId: 'quality',
          status: 'matched' as const,
          expression: 'quote.close > 10',
          inputs: [{ path: 'quote.close', status: 'available' as const, value: 20 }],
          evidence: ['收盘价'],
          explanation: { code: 'matched', message: '满足质量门槛' },
        },
      ],
      evidence: ['命中'],
      dataAsOf: baselineAt,
    })),
    signals: stockIds.map((stockId, index) => ({
      id: `${id}-signal-${index}`,
      strategyId: id,
      strategyVersionId: `${id}:v1`,
      runId: `${id}-run-1`,
      ruleId: 'quality',
      stockId,
      ts: baselineAt,
      score: 80,
      direction: 'bullish' as const,
      evidence: ['命中'],
      evaluationSnapshot: {},
    })),
  });
  for (const [index, stockId] of stockIds.entries()) {
    const withBenchmark = index >= withoutBenchmark;
    await ctx.repos.signalObservation.save({
      id: `${id}-observation-${index}`,
      sourceKind: 'strategy-signal',
      sourceId: `${id}-signal-${index}`,
      stockId,
      baselinePrice: money(100),
      baselineAt,
      horizon: 't5',
      closePrice: money(95),
      returnPct: excess + (withBenchmark ? 0.01 : 0),
      maxFavorableExcursionPct: 0.02,
      maxAdverseExcursionPct: -0.08,
      ...(withBenchmark ? { benchmarkReturnPct: 0.01 } : {}),
      benchmarkStatus: withBenchmark ? 'complete' : 'unavailable',
      status: 'complete',
      provenance: {
        provider: 'fixture',
        observedAt,
        fetchedAt: now,
        freshness: 'fresh',
      },
      observedAt,
    });
  }
};

const existingPauseAction = (strategyId: string, createdAt: Date): StrategyAutonomyAction => ({
  id: `${strategyId}-pause-history`,
  kind: 'pause',
  status: 'executed',
  strategyId,
  trigger: 'weekly-review',
  ruleSnapshot: {
    sampleCount: 22,
    benchmarkCoverage: 0.95,
    avgExcessReturn: -0.01,
    medianExcessReturn: -0.01,
    thresholds: { minSampleCount: 20 },
  },
  factReferences: [],
  attempts: 0,
  createdAt,
  updatedAt: createdAt,
  completedAt: createdAt,
});

const existingProposeAction = (
  strategyId: string,
  versionId: string,
  createdAt: Date,
): StrategyAutonomyAction => ({
  id: `${strategyId}-propose-history`,
  kind: 'propose-version',
  status: 'validating',
  strategyId,
  strategyVersionId: versionId,
  evaluationSessionId: `${strategyId}-session-history`,
  trigger: 'weekly-review',
  factReferences: [],
  attempts: 0,
  createdAt,
  updatedAt: createdAt,
});

/** 模块级 validating 动作 fixture（默认 8 天前创建，避开 7 天提议冷却窗口）。 */
const validatingActionFixture = (
  strategyId: string,
  overrides: Partial<StrategyAutonomyAction> = {},
): StrategyAutonomyAction => ({
  id: `${strategyId}-propose-validating`,
  kind: 'propose-version',
  status: 'validating',
  strategyId,
  strategyVersionId: `${strategyId}:v2`,
  evaluationSessionId: `${strategyId}-session`,
  trigger: 'weekly-review',
  factReferences: [],
  attempts: 0,
  createdAt: new Date(now.getTime() - 8 * 86_400_000),
  updatedAt: new Date(now.getTime() - 8 * 86_400_000),
  ...overrides,
});

/** 与 FakeLLMAdapter strategy_version_proposal 默认输出一致：基线规则 when 追加收敛条件。 */
const fakeProposedDefinition: StrategyDslV1 = {
  ...definition,
  selection: {
    logic: 'all',
    rules: [
      {
        id: 'quality',
        name: '质量门槛',
        when: 'quote.close > 10 && quote.close > 0',
        evidence: ['收盘价'],
      },
    ],
  },
};

describe('strategy-autonomy-weekly · AI 提议与自动验证', () => {
  it('正常提议：AI 产出 → 建版本 → 校验 valid → 落动作 → 建验证 session → 同周期推进至晋级门', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    // 样本不足暂停阈值，策略保持 active 进入提议步骤。
    await seedActiveStrategy(ctx, { id: 'strategy-propose', name: '待优化策略', samples: 10 });

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result).toMatchObject({ ok: true, data: { paused: 0 } });
    if (!result.ok) return;
    expect(result.data.proposals).toMatchObject({ evaluated: 1, validating: 1, failed: 0 });
    const item = result.data.proposals.items[0];
    expect(item).toMatchObject({
      strategyId: 'strategy-propose',
      decision: 'validating',
      proposalProvider: 'fake-llm',
    });

    const versions = await ctx.repos.strategy.listVersions('strategy-propose');
    expect(versions).toHaveLength(2);
    const candidate = versions.find((version) => version.version === 2);
    expect(candidate).toMatchObject({
      parentVersionId: 'strategy-propose:v1',
      validationStatus: 'valid',
      changeSummary: '测试提议：在基线规则上追加收敛条件',
    });
    expect(candidate?.definition.selection.rules[0]?.when).toBe(
      'quote.close > 10 && quote.close > 0',
    );

    const actions = await ctx.repos.strategyAutonomyAction.list({
      strategyId: 'strategy-propose',
      kind: 'propose-version',
    });
    expect(actions).toHaveLength(1);
    const action = actions[0];
    // M2-S3 起同周期继续推进验证并做晋级门复核；fixture 缺少 vintage/观察事实，
    // 动作从 validating 进入 blocked 人工队列（S2 的链路断言不受影响）。
    expect(action).toMatchObject({
      kind: 'propose-version',
      status: 'blocked',
      strategyVersionId: candidate?.id,
      evaluationSessionId: item?.evaluationSessionId,
      trigger: 'weekly-review',
    });
    expect(action?.factReferences).toEqual(
      expect.arrayContaining(['strategy:strategy-propose', 'strategy-version:strategy-propose:v1']),
    );
    expect(action?.ruleSnapshot).toMatchObject({
      baseVersionId: 'strategy-propose:v1',
      candidateVersionId: candidate?.id,
      validationWindowDays: 30,
    });

    const session = await ctx.repos.strategyEvaluation.findSessionById(
      item?.evaluationSessionId ?? '',
    );
    expect(session).toMatchObject({
      strategyId: 'strategy-propose',
      strategyVersionId: candidate?.id,
    });
    // 验证窗口：30 个自然日，结束于昨天（UTC 日界）。
    expect(session?.from.toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(session?.to.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    // M2-S3 起同周期继续推进 session 并做晋级门复核：fixture 缺少 PIT vintage
    // 与观察事实，session 推进为 complete 后晋级门拦截，动作进入 blocked 人工队列。
    expect(session?.status).toBe('complete');
    const days = await ctx.repos.strategyEvaluation.listDays(session?.id ?? '');
    expect(days.length).toBeGreaterThanOrEqual(20);
    expect(days.every((day) => day.status === 'complete')).toBe(true);

    const proposed = await ctx.repos.strategyAutonomyAction.findById(action?.id ?? '');
    expect(proposed?.status).toBe('blocked');
    expect(proposed?.lastError).toContain('pit-vintage-coverage-insufficient');
    expect(result.data.validation.items[0]?.decision).toBe('advanced');
    expect(result.data.promotion.items[0]?.decision).toBe('blocked');
    // 30 天窗口的逐日 replay 推进在并行全量运行时可能超过默认 5s 超时。
  }, 30_000);

  it('本周刚被自动暂停的策略跳过提议', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, { id: 'strategy-paused-first', name: '先止损策略', samples: 20 });

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result).toMatchObject({ ok: true, data: { paused: 1 } });
    if (!result.ok) return;
    expect(result.data.proposals.evaluated).toBe(0);
    const versions = await ctx.repos.strategy.listVersions('strategy-paused-first');
    expect(versions).toHaveLength(1);
    const proposals = await ctx.repos.strategyAutonomyAction.list({
      strategyId: 'strategy-paused-first',
      kind: 'propose-version',
    });
    expect(proposals).toEqual([]);
  });

  it('AI 不可用（调用抛错）当周跳过提议，不落动作，不影响暂停步骤', async () => {
    const base = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(base);
    await seedActiveStrategy(base, { id: 'strategy-ai-off', name: 'AI 离线策略', samples: 10 });
    const ctx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        llm: {
          name: 'offline-llm',
          generate: async <T>() => Promise.reject<T>(new Error('provider unavailable')),
        },
      },
    };

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result).toMatchObject({ ok: true, data: { paused: 0, failed: 0 } });
    if (!result.ok) return;
    expect(result.data.proposals).toMatchObject({ evaluated: 1, validating: 0, skipped: 1 });
    expect(result.data.proposals.items[0]).toMatchObject({
      strategyId: 'strategy-ai-off',
      decision: 'skipped',
    });
    expect(result.data.proposals.items[0]?.reasons.join()).toContain('AI 不可用');
    expect(await ctx.repos.strategy.listVersions('strategy-ai-off')).toHaveLength(1);
    expect(
      await ctx.repos.strategyAutonomyAction.list({
        strategyId: 'strategy-ai-off',
        kind: 'propose-version',
      }),
    ).toEqual([]);
  });

  it('AI 输出不过 DSL schema → 落 failed 动作且不建版本', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, {
      id: 'strategy-schema-bad',
      name: '坏输出策略',
      samples: 10,
      description: 'proposal-fixture:schema-error',
    });

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposals).toMatchObject({ validating: 0, failed: 1 });
    expect(result.data.proposals.items[0]).toMatchObject({
      strategyId: 'strategy-schema-bad',
      decision: 'failed',
    });
    expect(await ctx.repos.strategy.listVersions('strategy-schema-bad')).toHaveLength(1);
    const actions = await ctx.repos.strategyAutonomyAction.list({
      strategyId: 'strategy-schema-bad',
      kind: 'propose-version',
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: 'failed' });
    expect(actions[0]?.lastError).toContain('StrategyDslV1Schema');
    expect(actions[0]?.strategyVersionId).toBeUndefined();
    expect(actions[0]?.completedAt).toBeDefined();
  });

  it('候选版本静态校验 invalid → 落 failed 动作并记录校验错误', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, {
      id: 'strategy-invalid-field',
      name: '未知字段策略',
      samples: 10,
      description: 'proposal-fixture:unknown-field',
    });

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposals).toMatchObject({ validating: 0, failed: 1 });
    const item = result.data.proposals.items[0];
    expect(item).toMatchObject({ strategyId: 'strategy-invalid-field', decision: 'failed' });

    const versions = await ctx.repos.strategy.listVersions('strategy-invalid-field');
    expect(versions).toHaveLength(2);
    const candidate = versions.find((version) => version.version === 2);
    expect(candidate?.validationStatus).toBe('invalid');

    const actions = await ctx.repos.strategyAutonomyAction.list({
      strategyId: 'strategy-invalid-field',
      kind: 'propose-version',
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      status: 'failed',
      strategyVersionId: candidate?.id,
    });
    expect(actions[0]?.lastError).toContain('未注册的 Strategy 字段');
    expect(actions[0]?.evaluationSessionId).toBeUndefined();
  });

  it('AI 提议与现有未发布 draft 的 definitionHash 相同则不重复建版本', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, { id: 'strategy-dup', name: '重复提议策略', samples: 10 });
    await ctx.repos.strategy.createVersion({
      id: 'strategy-dup:v2',
      strategyId: 'strategy-dup',
      version: 2,
      definition: fakeProposedDefinition,
      definitionHash: strategyDefinitionHash(fakeProposedDefinition),
      parentVersionId: 'strategy-dup:v1',
      validationStatus: 'valid',
      validationErrors: [],
      createdAt: now,
    });

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposals).toMatchObject({ validating: 0, skipped: 1, failed: 0 });
    expect(result.data.proposals.items[0]).toMatchObject({
      strategyId: 'strategy-dup',
      decision: 'skipped',
    });
    expect(result.data.proposals.items[0]?.reasons.join()).toContain('definitionHash');
    expect(await ctx.repos.strategy.listVersions('strategy-dup')).toHaveLength(2);
    expect(
      await ctx.repos.strategyAutonomyAction.list({
        strategyId: 'strategy-dup',
        kind: 'propose-version',
      }),
    ).toEqual([]);
  });

  it('7 天冷却窗口内已有 propose-version 动作则跳过', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, {
      id: 'strategy-propose-cooldown',
      name: '提议冷却策略',
      samples: 10,
    });
    await ctx.repos.strategyAutonomyAction.save(
      existingProposeAction(
        'strategy-propose-cooldown',
        'strategy-propose-cooldown:v2',
        new Date(now.getTime() - 3 * 86_400_000),
      ),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.proposals).toMatchObject({ validating: 0, skipped: 1 });
    expect(result.data.proposals.items[0]?.reasons.join()).toContain('冷却窗口');
    expect(await ctx.repos.strategy.listVersions('strategy-propose-cooldown')).toHaveLength(1);
    expect(
      await ctx.repos.strategyAutonomyAction.list({
        strategyId: 'strategy-propose-cooldown',
        kind: 'propose-version',
      }),
    ).toHaveLength(1);
  });

  it('builtin 策略永不进入提议步骤', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await ctx.repos.strategy.create({
      id: 'strategy-builtin-active',
      name: '内置模板策略',
      description: 'builtin 不参与自治提议',
      owner: 'builtin',
      status: 'active',
      currentVersionId: 'strategy-builtin-active:v1',
      createdAt: now,
      updatedAt: now,
    });
    await ctx.repos.strategy.createVersion({
      id: 'strategy-builtin-active:v1',
      strategyId: 'strategy-builtin-active',
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: now,
      createdAt: now,
    });

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result).toMatchObject({
      ok: true,
      data: { evaluated: 0, proposals: { evaluated: 0 } },
    });
    expect(
      await ctx.repos.strategyAutonomyAction.list({ strategyId: 'strategy-builtin-active' }),
    ).toEqual([]);
    expect(await ctx.repos.strategy.listVersions('strategy-builtin-active')).toHaveLength(1);
  });
});

describe('strategy-autonomy-weekly', () => {
  it('命中全部阈值的 active 用户策略被自动暂停并落审计动作', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, { id: 'strategy-hit', name: '跑输策略', samples: 20 });

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result).toMatchObject({ ok: true, data: { evaluated: 1, paused: 1, failed: 0 } });
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      strategyId: 'strategy-hit',
      decision: 'paused',
      narrativeProvider: 'fake-llm',
    });
    const strategy = await ctx.repos.strategy.findById('strategy-hit');
    expect(strategy?.status).toBe('paused');
    const actions = await ctx.repos.strategyAutonomyAction.list({ strategyId: 'strategy-hit' });
    expect(actions).toHaveLength(1);
    const action = actions[0];
    expect(action).toMatchObject({
      kind: 'pause',
      status: 'executed',
      trigger: 'weekly-review',
    });
    expect(action?.ruleSnapshot).toMatchObject({
      sampleCount: 20,
      benchmarkCoverage: 1,
    });
    const snapshot = action?.ruleSnapshot as Record<string, unknown>;
    expect(snapshot.avgExcessReturn as number).toBeCloseTo(-0.06, 10);
    expect(snapshot.medianExcessReturn as number).toBeCloseTo(-0.06, 10);
    const thresholds = action?.ruleSnapshot?.thresholds as Record<string, unknown> | undefined;
    expect(thresholds).toMatchObject({
      minSampleCount: 20,
      minBenchmarkCoverage: 0.9,
      cooldownDays: 30,
    });
    expect(action?.aiNarrative).toBeDefined();
  });

  it('完整样本不足阈值时不动作', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, { id: 'strategy-thin', name: '样本不足策略', samples: 10 });
    // 本用例只断言暂停步骤；冷却窗口内的 propose 动作让提议步骤跳过，
    // 避免无关的验证 session 推进拖慢测试（M2-S3 起同周期会推进 replay）。
    await ctx.repos.strategyAutonomyAction.save(
      existingProposeAction(
        'strategy-thin',
        'strategy-thin:v2',
        new Date(now.getTime() - 86_400_000),
      ),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result).toMatchObject({ ok: true, data: { evaluated: 1, paused: 0, failed: 0 } });
    if (!result.ok) return;
    expect(result.data.items[0]?.decision).toBe('kept');
    const strategy = await ctx.repos.strategy.findById('strategy-thin');
    expect(strategy?.status).toBe('active');
    // 暂停步骤不动作；提议步骤会生成 propose-version 动作，这里只断言无 pause。
    expect(
      await ctx.repos.strategyAutonomyAction.list({ strategyId: 'strategy-thin', kind: 'pause' }),
    ).toEqual([]);
  });

  it('benchmark 覆盖率不足时不动作', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, {
      id: 'strategy-no-benchmark',
      name: '基准缺失策略',
      samples: 20,
      withoutBenchmark: 3,
    });
    // 只断言暂停步骤；冷却窗口内的 propose 动作让提议步骤跳过（M2-S3 起同周期会推进 replay）。
    await ctx.repos.strategyAutonomyAction.save(
      existingProposeAction(
        'strategy-no-benchmark',
        'strategy-no-benchmark:v2',
        new Date(now.getTime() - 86_400_000),
      ),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result).toMatchObject({ ok: true, data: { evaluated: 1, paused: 0 } });
    if (!result.ok) return;
    expect(result.data.items[0]?.decision).toBe('kept');
    expect(result.data.items[0]?.reasons.join()).toContain('benchmark 覆盖不足');
    const strategy = await ctx.repos.strategy.findById('strategy-no-benchmark');
    expect(strategy?.status).toBe('active');
  });

  it('平均或中位数超额非负时不动作', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, {
      id: 'strategy-winning',
      name: '跑赢策略',
      samples: 20,
      excess: 0.03,
    });
    // 只断言暂停步骤；冷却窗口内的 propose 动作让提议步骤跳过（M2-S3 起同周期会推进 replay）。
    await ctx.repos.strategyAutonomyAction.save(
      existingProposeAction(
        'strategy-winning',
        'strategy-winning:v2',
        new Date(now.getTime() - 86_400_000),
      ),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result).toMatchObject({ ok: true, data: { paused: 0 } });
    const strategy = await ctx.repos.strategy.findById('strategy-winning');
    expect(strategy?.status).toBe('active');
  });

  it('冷却窗口内已有 pause 动作时抑制重复暂停', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, { id: 'strategy-cooldown', name: '冷却策略', samples: 20 });
    await ctx.repos.strategyAutonomyAction.save(
      existingPauseAction('strategy-cooldown', new Date(now.getTime() - 10 * 86_400_000)),
    );
    // 只断言暂停步骤；冷却窗口内的 propose 动作让提议步骤跳过（M2-S3 起同周期会推进 replay）。
    await ctx.repos.strategyAutonomyAction.save(
      existingProposeAction(
        'strategy-cooldown',
        'strategy-cooldown:v2',
        new Date(now.getTime() - 86_400_000),
      ),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result).toMatchObject({ ok: true, data: { paused: 0, failed: 0 } });
    if (!result.ok) return;
    expect(result.data.items[0]?.decision).toBe('kept');
    expect(result.data.items[0]?.reasons.join()).toContain('冷却窗口');
    const strategy = await ctx.repos.strategy.findById('strategy-cooldown');
    expect(strategy?.status).toBe('active');
    // 提议步骤会新增 propose-version 动作，这里只断言 pause 侧不重复。
    const pauses = await ctx.repos.strategyAutonomyAction.list({
      strategyId: 'strategy-cooldown',
      kind: 'pause',
    });
    expect(pauses).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'strategy-cooldown-pause-history' })]),
    );
    expect(pauses.length).toBe(1);
  });

  it('AI 失败时 aiNarrative 缺省，暂停动作照常完成', async () => {
    const base = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(base);
    await seedActiveStrategy(base, { id: 'strategy-ai-down', name: 'AI 离线策略', samples: 20 });
    const ctx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        llm: {
          name: 'offline-llm',
          generate: async <T>() => Promise.reject<T>(new Error('provider unavailable')),
        },
      },
    };

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result).toMatchObject({ ok: true, data: { paused: 1, failed: 0 } });
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({ decision: 'paused' });
    expect(result.data.items[0]?.narrativeProvider).toBeUndefined();
    const actions = await ctx.repos.strategyAutonomyAction.list({ strategyId: 'strategy-ai-down' });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.aiNarrative).toBeUndefined();
    expect(actions[0]?.status).toBe('executed');
  });

  it('单策略失败隔离：失败策略记 error，其它策略照常判定', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, { id: 'strategy-good', name: '正常策略', samples: 20 });
    await seedActiveStrategy(ctx, { id: 'strategy-bad', name: '异常策略', samples: 20 });
    const findById = ctx.repos.strategy.findById.bind(ctx.repos.strategy);
    ctx.repos.strategy.findById = async (id: string) => {
      if (id === 'strategy-bad') throw new Error('repo boom');
      return findById(id);
    };

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.evaluated).toBe(2);
    expect(result.data.paused).toBe(1);
    expect(result.data.failed).toBe(1);
    const good = result.data.items.find((item) => item.strategyId === 'strategy-good');
    const bad = result.data.items.find((item) => item.strategyId === 'strategy-bad');
    expect(good?.decision).toBe('paused');
    expect(bad?.decision).toBe('error');
    expect(bad?.error).toBeDefined();
    const strategy = await findById('strategy-good');
    expect(strategy?.status).toBe('paused');
  });
});

describe('strategy-autonomy-weekly · session 推进与晋级门复核（M2-S3）', () => {
  const DAY_MS = 86_400_000;

  const weekdays = (from: Date, to: Date): Date[] => {
    const days: Date[] = [];
    for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
      const day = new Date(t);
      const dow = day.getUTCDay();
      if (dow !== 0 && dow !== 6) days.push(day);
    }
    return days;
  };

  /** 候选版本：与 FakeLLMAdapter 默认提议同 hash，保证提议步骤走 definitionHash 去重跳过。 */
  const seedCandidateVersion = async (
    ctx: ToolContext,
    strategyId: string,
    validationStatus: 'valid' | 'pending' = 'valid',
  ): Promise<void> => {
    await ctx.repos.strategy.createVersion({
      id: `${strategyId}:v2`,
      strategyId,
      version: 2,
      definition: fakeProposedDefinition,
      definitionHash: strategyDefinitionHash(fakeProposedDefinition),
      parentVersionId: `${strategyId}:v1`,
      validationStatus,
      validationErrors: [],
      createdAt: now,
    });
  };

  const validatingAction = (
    strategyId: string,
    overrides: Partial<StrategyAutonomyAction> = {},
  ): StrategyAutonomyAction => ({
    id: `${strategyId}-propose-validating`,
    kind: 'propose-version',
    status: 'validating',
    strategyId,
    strategyVersionId: `${strategyId}:v2`,
    evaluationSessionId: `${strategyId}-session`,
    trigger: 'weekly-review',
    factReferences: [],
    attempts: 0,
    // 避开 7 天提议冷却窗口，让提议步骤走 definitionHash 去重跳过而非冷却跳过。
    createdAt: new Date(now.getTime() - 8 * DAY_MS),
    updatedAt: new Date(now.getTime() - 8 * DAY_MS),
    ...overrides,
  });

  it('running session 被逐日推进至 complete；晋级门未通过 → 动作 blocked 并记 reasons', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, { id: 'strategy-gate-block', name: '门禁拦截策略', samples: 10 });
    await seedCandidateVersion(ctx, 'strategy-gate-block');
    const sessionId = 'strategy-gate-block-session';
    const from = new Date('2026-08-27T00:00:00.000Z');
    const to = new Date('2026-08-28T00:00:00.000Z');
    await ctx.repos.strategyEvaluation.saveSession({
      id: sessionId,
      strategyId: 'strategy-gate-block',
      strategyVersionId: 'strategy-gate-block:v2',
      from,
      to,
      status: 'running',
      definitionHash: strategyDefinitionHash(fakeProposedDefinition),
      createdAt: new Date(now.getTime() - 8 * DAY_MS),
    });
    // 两个交易日的 replay 事实已存在，推进应走断点续跑并把 session 收尾为 complete。
    for (const day of weekdays(from, to)) {
      await ctx.repos.strategyEvaluation.saveDay({
        sessionId,
        dataAsOf: day,
        status: 'complete',
        vintageStatus: 'available',
      });
    }
    await ctx.repos.strategyAutonomyAction.save(validatingAction('strategy-gate-block'));

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.validation.items[0]).toMatchObject({
      actionId: 'strategy-gate-block-propose-validating',
      decision: 'advanced',
    });
    const session = await ctx.repos.strategyEvaluation.findSessionById(sessionId);
    expect(session?.status).toBe('complete');

    expect(result.data.promotion).toMatchObject({ evaluated: 1, blocked: 1, published: 0 });
    expect(result.data.promotion.items[0]).toMatchObject({ decision: 'blocked' });
    expect(result.data.promotion.items[0]?.reasons).toContain('validation-days-insufficient');
    const action = await ctx.repos.strategyAutonomyAction.findById(
      'strategy-gate-block-propose-validating',
    );
    expect(action?.status).toBe('blocked');
    expect(action?.lastError).toContain('validation-days-insufficient');
    // blocked 不是终态，无 completedAt，等待人工队列处理。
    expect(action?.completedAt).toBeUndefined();
  });

  it('晋级门通过 → 自动 publish 候选版本，动作转移 published', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, { id: 'strategy-gate-pass', name: '晋级策略', samples: 10 });
    await seedCandidateVersion(ctx, 'strategy-gate-pass');
    const sessionId = 'strategy-gate-pass-session';
    const from = new Date('2026-08-03T00:00:00.000Z');
    const to = new Date('2026-08-31T00:00:00.000Z');
    await ctx.repos.strategyEvaluation.saveSession({
      id: sessionId,
      strategyId: 'strategy-gate-pass',
      strategyVersionId: 'strategy-gate-pass:v2',
      from,
      to,
      status: 'complete',
      definitionHash: strategyDefinitionHash(fakeProposedDefinition),
      createdAt: new Date(now.getTime() - 8 * DAY_MS),
      finishedAt: new Date(now.getTime() - DAY_MS),
    });
    // 21 个 complete 且 vintage available 的交易日（满足 ≥20 与 vintage 覆盖 1.0）。
    const days = weekdays(from, to);
    expect(days.length).toBeGreaterThanOrEqual(20);
    const evalRunId = 'strategy-gate-pass-eval-run';
    for (const [index, day] of days.entries()) {
      await ctx.repos.strategyEvaluation.saveDay({
        sessionId,
        dataAsOf: day,
        status: 'complete',
        vintageStatus: 'available',
        ...(index === 0 ? { runId: evalRunId } : {}),
      });
    }
    // 候选版本的 evaluation run：30 个信号各带一条 benchmark 完整的 T+5 观察。
    const stockIds = Array.from(
      { length: 30 },
      (_, index) => `61${String(index).padStart(4, '0')}.SH`,
    );
    await ctx.repos.strategyRun.commitRun({
      run: {
        id: evalRunId,
        strategyId: 'strategy-gate-pass',
        strategyVersionId: 'strategy-gate-pass:v2',
        mode: 'replay',
        scope: 'evaluation',
        coverage: 'CN_A_SHARES_SH_SZ',
        dataAsOf: baselineAt,
        startedAt: baselineAt,
        finishedAt: baselineAt,
        status: 'complete',
        inputSnapshot: {},
        providerStatuses: [],
        summary: {
          schemaVersion: 3,
          dataHealth: 'complete',
          universeCount: stockIds.length,
          evaluatedCount: stockIds.length,
          selectedCount: stockIds.length,
          signalCount: stockIds.length,
          incompleteCount: 0,
          failedCount: 0,
          failureSamples: [],
        },
      },
      results: stockIds.map((stockId, index) => ({
        runId: evalRunId,
        stockId,
        selected: true,
        score: 80,
        rank: index + 1,
        ruleEvaluations: [],
        evidence: ['命中'],
        dataAsOf: baselineAt,
      })),
      signals: stockIds.map((stockId, index) => ({
        id: `strategy-gate-pass-eval-signal-${index}`,
        strategyId: 'strategy-gate-pass',
        strategyVersionId: 'strategy-gate-pass:v2',
        runId: evalRunId,
        ruleId: 'quality',
        stockId,
        ts: baselineAt,
        score: 80,
        direction: 'bullish' as const,
        evidence: ['命中'],
        evaluationSnapshot: {},
      })),
    });
    for (const [index, stockId] of stockIds.entries()) {
      await ctx.repos.signalObservation.save({
        id: `strategy-gate-pass-observation-${index}`,
        sourceKind: 'strategy-signal',
        sourceId: `strategy-gate-pass-eval-signal-${index}`,
        stockId,
        baselinePrice: money(100),
        baselineAt,
        horizon: 't5',
        closePrice: money(105),
        returnPct: 0.05,
        maxFavorableExcursionPct: 0.06,
        maxAdverseExcursionPct: -0.01,
        benchmarkReturnPct: 0.01,
        benchmarkStatus: 'complete',
        status: 'complete',
        provenance: {
          provider: 'fixture',
          observedAt,
          fetchedAt: now,
          freshness: 'fresh',
        },
        observedAt,
      });
    }
    await ctx.repos.strategyAutonomyAction.save(validatingAction('strategy-gate-pass'));

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.validation.items[0]?.decision).toBe('already-complete');
    expect(result.data.promotion).toMatchObject({ evaluated: 1, published: 1, blocked: 0 });
    expect(result.data.promotion.items[0]).toMatchObject({ decision: 'published' });
    const action = await ctx.repos.strategyAutonomyAction.findById(
      'strategy-gate-pass-propose-validating',
    );
    expect(action?.status).toBe('published');
    expect(action?.completedAt).toBeDefined();
    const strategy = await ctx.repos.strategy.findById('strategy-gate-pass');
    expect(strategy?.currentVersionId).toBe('strategy-gate-pass:v2');
    expect(strategy?.status).toBe('active');
    const version = await ctx.repos.strategy.findVersionById('strategy-gate-pass:v2');
    expect(version?.publishedAt).toBeDefined();
  });

  it('session 推进后仍未 complete → 不评估，动作留在 validating', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    // 不 seed universe：PIT 快照缺失导致逐日失败，session 被推进收尾为 failed。
    const sessionId = 'strategy-stuck-session';
    await ctx.repos.strategyEvaluation.saveSession({
      id: sessionId,
      strategyId: 'strategy-stuck',
      strategyVersionId: 'strategy-stuck:v2',
      from: new Date('2026-08-27T00:00:00.000Z'),
      to: new Date('2026-08-28T00:00:00.000Z'),
      status: 'running',
      definitionHash: 'a'.repeat(64),
      createdAt: new Date(now.getTime() - 8 * DAY_MS),
    });
    await ctx.repos.strategyAutonomyAction.save(validatingAction('strategy-stuck'));

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.validation.items[0]?.decision).toBe('incomplete');
    expect(result.data.promotion.items[0]?.decision).toBe('pending');
    const session = await ctx.repos.strategyEvaluation.findSessionById(sessionId);
    expect(session?.status).toBe('failed');
    const action = await ctx.repos.strategyAutonomyAction.findById(
      'strategy-stuck-propose-validating',
    );
    expect(action?.status).toBe('validating');
    expect(action?.completedAt).toBeUndefined();
  });

  it('eligible 动作发布失败 → 保持 eligible，attempts+1 且记 lastError', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, { id: 'strategy-retry', name: '重试策略', samples: 10 });
    // validationStatus=pending 的候选版本不满足 publish 前置，发布必然失败。
    await seedCandidateVersion(ctx, 'strategy-retry', 'pending');
    await ctx.repos.strategyAutonomyAction.save(
      validatingAction('strategy-retry', {
        id: 'strategy-retry-eligible',
        status: 'eligible',
        evaluationSessionId: undefined,
      }),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.promotion).toMatchObject({ retry: 1, published: 0 });
    expect(result.data.promotion.items[0]).toMatchObject({ decision: 'retry' });
    const action = await ctx.repos.strategyAutonomyAction.findById('strategy-retry-eligible');
    expect(action?.status).toBe('eligible');
    expect(action?.attempts).toBe(1);
    expect(action?.lastError).toContain('发布失败');
    expect(action?.completedAt).toBeUndefined();
    const strategy = await ctx.repos.strategy.findById('strategy-retry');
    expect(strategy?.currentVersionId).toBe('strategy-retry:v1');
  });

  it('eligible 动作发布重试成功 → published 并切换 currentVersion', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, { id: 'strategy-republish', name: '补发布策略', samples: 10 });
    await seedCandidateVersion(ctx, 'strategy-republish');
    await ctx.repos.strategyAutonomyAction.save(
      validatingAction('strategy-republish', {
        id: 'strategy-republish-eligible',
        status: 'eligible',
        attempts: 1,
        lastError: '发布失败: 上周网络抖动',
        evaluationSessionId: undefined,
      }),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.promotion).toMatchObject({ published: 1, retry: 0 });
    const action = await ctx.repos.strategyAutonomyAction.findById('strategy-republish-eligible');
    expect(action?.status).toBe('published');
    expect(action?.completedAt).toBeDefined();
    const strategy = await ctx.repos.strategy.findById('strategy-republish');
    expect(strategy?.currentVersionId).toBe('strategy-republish:v2');
  });
});

describe('strategy-autonomy-weekly · 自动归档（§9.1）', () => {
  const DAY = 86_400_000;

  const seedPausedStrategy = async (
    ctx: ToolContext,
    options: SeedOptions & { readonly pausedDaysAgo: number },
  ): Promise<void> => {
    await seedActiveStrategy(ctx, options);
    const pausedAt = new Date(now.getTime() - options.pausedDaysAgo * DAY);
    await ctx.repos.strategy.pause(options.id, pausedAt);
  };

  it('自治暂停满 28 天且统计仍命中阈值 → 归档为终态并落 kind=archive 动作', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedPausedStrategy(ctx, {
      id: 'strategy-stale',
      name: '长期跑输策略',
      samples: 20,
      pausedDaysAgo: 35,
    });
    const pausedAt = new Date(now.getTime() - 35 * DAY);
    await ctx.repos.strategyAutonomyAction.save(existingPauseAction('strategy-stale', pausedAt));
    await ctx.repos.strategySchedule.save(
      buildStrategySchedule({
        strategyId: 'strategy-stale',
        cron: '0 18 * * 1-5',
        timezone: 'Asia/Shanghai',
        enabled: true,
        now,
      }),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.archive).toMatchObject({ evaluated: 1, archived: 1, failed: 0 });
    expect(result.data.archive.items[0]).toMatchObject({
      strategyId: 'strategy-stale',
      decision: 'archived',
    });
    const strategy = await ctx.repos.strategy.findById('strategy-stale');
    expect(strategy?.status).toBe('archived');
    // 收口：归档后调度配置被移除，claim 不再抢占该策略
    expect(await ctx.repos.strategySchedule.findByStrategyId('strategy-stale')).toBeNull();
    const actions = await ctx.repos.strategyAutonomyAction.list({
      strategyId: 'strategy-stale',
      kind: 'archive',
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      kind: 'archive',
      status: 'executed',
      trigger: 'weekly-review',
    });
    expect(actions[0]?.completedAt).toBeDefined();
    expect(actions[0]?.ruleSnapshot).toMatchObject({
      sampleCount: 20,
      benchmarkCoverage: 1,
      pausedSinceDays: 35,
    });
    const archiveThresholds = actions[0]?.ruleSnapshot?.thresholds as
      | Record<string, unknown>
      | undefined;
    expect(archiveThresholds?.minPausedDays).toBe(28);
    expect(actions[0]?.factReferences).toContain(
      'strategy-autonomy-action:strategy-stale-pause-history',
    );
  });

  it('自治暂停未满 28 天不动', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedPausedStrategy(ctx, {
      id: 'strategy-recent',
      name: '近期暂停策略',
      samples: 20,
      pausedDaysAgo: 10,
    });
    await ctx.repos.strategyAutonomyAction.save(
      existingPauseAction('strategy-recent', new Date(now.getTime() - 10 * DAY)),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.archive).toMatchObject({ evaluated: 1, archived: 0, failed: 0 });
    expect(result.data.archive.items[0]?.decision).toBe('kept');
    expect(result.data.archive.items[0]?.reasons.join()).toContain('未满');
    expect((await ctx.repos.strategy.findById('strategy-recent'))?.status).toBe('paused');
    expect(
      await ctx.repos.strategyAutonomyAction.list({
        strategyId: 'strategy-recent',
        kind: 'archive',
      }),
    ).toEqual([]);
  });

  it('统计已恢复（超额转正）不归档', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedPausedStrategy(ctx, {
      id: 'strategy-recovered',
      name: '统计恢复策略',
      samples: 20,
      excess: 0.03,
      pausedDaysAgo: 40,
    });
    await ctx.repos.strategyAutonomyAction.save(
      existingPauseAction('strategy-recovered', new Date(now.getTime() - 40 * DAY)),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.archive.items[0]?.decision).toBe('kept');
    expect(result.data.archive.items[0]?.reasons.join()).toContain('不再满足归档条件');
    expect((await ctx.repos.strategy.findById('strategy-recovered'))?.status).toBe('paused');
  });

  it('人工暂停（无自治 pause 动作）不参与自动归档', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedPausedStrategy(ctx, {
      id: 'strategy-manual',
      name: '人工暂停策略',
      samples: 20,
      pausedDaysAgo: 60,
    });

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.archive.items[0]?.decision).toBe('kept');
    expect(result.data.archive.items[0]?.reasons.join()).toContain('人工暂停');
    expect((await ctx.repos.strategy.findById('strategy-manual'))?.status).toBe('paused');
  });
});

describe('strategy-autonomy-weekly · AI 全新策略（§9.2）', () => {
  const DAY = 86_400_000;

  it('全新策略提议全链：create_strategy → 首版本 → 校验 → 验证 session → 动作', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, {
      id: 'strategy-inspire',
      name: '启发策略',
      samples: 10,
      description: 'proposal-fixture:new-strategy',
    });

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.data.proposals.items.find(
      (entry) => entry.strategyId !== 'strategy-inspire',
    );
    expect(item).toMatchObject({ decision: 'validating', proposalProvider: 'fake-llm' });
    const newId = item?.strategyId ?? '';
    const created = await ctx.repos.strategy.findById(newId);
    expect(created).toMatchObject({ name: 'fixture 全新策略', owner: 'user' });
    const versions = await ctx.repos.strategy.listVersions(newId);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, validationStatus: 'valid' });
    expect(versions[0]?.parentVersionId).toBeUndefined();
    const actions = await ctx.repos.strategyAutonomyAction.list({
      strategyId: newId,
      kind: 'propose-version',
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]?.ruleSnapshot).toMatchObject({ proposalKind: 'new-strategy' });
    expect(actions[0]?.ruleSnapshot?.baseVersionId).toBeUndefined();
    const session = await ctx.repos.strategyEvaluation.findSessionById(
      actions[0]?.evaluationSessionId ?? '',
    );
    expect(session).toMatchObject({ strategyId: newId, strategyVersionId: versions[0]?.id });
    // 同周期推进验证（draft 策略的 evaluation run 允许持久化）；fixture 缺 PIT vintage，
    // 首发门禁拦截进人工队列，策略保持 draft、未发布、无 schedule。
    expect(session?.status).toBe('complete');
    expect(actions[0]?.status).toBe('blocked');
    expect(actions[0]?.lastError).toContain('pit-vintage-coverage-insufficient');
    expect(created?.status).toBe('draft');
    expect(created?.currentVersionId).toBeUndefined();
    expect(await ctx.repos.strategySchedule.findByStrategyId(newId)).toBeNull();
    // 30 天窗口的逐日 replay 推进在并行全量运行时可能超过默认 5s 超时。
  }, 30_000);

  it('全新策略提议全局限额：本周已有 new-strategy 动作则跳过', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await seedActiveStrategy(ctx, {
      id: 'strategy-quota',
      name: '限额策略',
      samples: 10,
      description: 'proposal-fixture:new-strategy',
    });
    // 本周已存在一个全新策略提议动作（failed 终态也占限额）。
    await ctx.repos.strategyAutonomyAction.save({
      ...existingProposeAction(
        'strategy-earlier',
        'strategy-earlier:v1',
        new Date(now.getTime() - 3 * DAY),
      ),
      status: 'failed',
      lastError: '校验未通过',
      completedAt: new Date(now.getTime() - 3 * DAY),
      ruleSnapshot: { proposalKind: 'new-strategy' },
    });

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.data.proposals.items.find((entry) => entry.strategyId === 'strategy-quota');
    expect(item?.decision).toBe('skipped');
    expect(item?.reasons.join()).toContain('全局限额');
    // 没有创建任何新策略
    expect((await ctx.repos.strategy.list()).map((strategy) => strategy.id)).toEqual([
      'strategy-quota',
    ]);
  });

  it('首发门禁通过 → 自动 publish，新策略从 draft 变 active', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    // AI 创造的新策略：draft 状态、单个未发布 valid 版本、无基线。
    await ctx.repos.strategy.create({
      id: 'strategy-first',
      name: '首发策略',
      description: '首发门禁通过测试',
      owner: 'user',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });
    await ctx.repos.strategy.createVersion({
      id: 'strategy-first:v1',
      strategyId: 'strategy-first',
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      createdAt: now,
    });
    const sessionId = 'strategy-first-session';
    const from = new Date('2026-08-03T00:00:00.000Z');
    const to = new Date('2026-08-31T00:00:00.000Z');
    await ctx.repos.strategyEvaluation.saveSession({
      id: sessionId,
      strategyId: 'strategy-first',
      strategyVersionId: 'strategy-first:v1',
      from,
      to,
      status: 'complete',
      definitionHash: strategyDefinitionHash(definition),
      createdAt: new Date(now.getTime() - 8 * DAY),
      finishedAt: new Date(now.getTime() - DAY),
    });
    const days: Date[] = [];
    for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
      const day = new Date(t);
      const dow = day.getUTCDay();
      if (dow !== 0 && dow !== 6) days.push(day);
    }
    expect(days.length).toBeGreaterThanOrEqual(20);
    const evalRunId = 'strategy-first-eval-run';
    for (const [index, day] of days.entries()) {
      await ctx.repos.strategyEvaluation.saveDay({
        sessionId,
        dataAsOf: day,
        status: 'complete',
        vintageStatus: 'available',
        ...(index === 0 ? { runId: evalRunId } : {}),
      });
    }
    const stockIds = Array.from(
      { length: 30 },
      (_, index) => `62${String(index).padStart(4, '0')}.SH`,
    );
    await ctx.repos.strategyRun.commitRun({
      run: {
        id: evalRunId,
        strategyId: 'strategy-first',
        strategyVersionId: 'strategy-first:v1',
        mode: 'replay',
        scope: 'evaluation',
        coverage: 'CN_A_SHARES_SH_SZ',
        dataAsOf: baselineAt,
        startedAt: baselineAt,
        finishedAt: baselineAt,
        status: 'complete',
        inputSnapshot: {},
        providerStatuses: [],
        summary: {
          schemaVersion: 3,
          dataHealth: 'complete',
          universeCount: stockIds.length,
          evaluatedCount: stockIds.length,
          selectedCount: stockIds.length,
          signalCount: stockIds.length,
          incompleteCount: 0,
          failedCount: 0,
          failureSamples: [],
        },
      },
      results: stockIds.map((stockId, index) => ({
        runId: evalRunId,
        stockId,
        selected: true,
        score: 80,
        rank: index + 1,
        ruleEvaluations: [],
        evidence: ['命中'],
        dataAsOf: baselineAt,
      })),
      signals: stockIds.map((stockId, index) => ({
        id: `strategy-first-eval-signal-${index}`,
        strategyId: 'strategy-first',
        strategyVersionId: 'strategy-first:v1',
        runId: evalRunId,
        ruleId: 'quality',
        stockId,
        ts: baselineAt,
        score: 80,
        direction: 'bullish' as const,
        evidence: ['命中'],
        evaluationSnapshot: {},
      })),
    });
    for (const [index, stockId] of stockIds.entries()) {
      await ctx.repos.signalObservation.save({
        id: `strategy-first-observation-${index}`,
        sourceKind: 'strategy-signal',
        sourceId: `strategy-first-eval-signal-${index}`,
        stockId,
        baselinePrice: money(100),
        baselineAt,
        horizon: 't5',
        closePrice: money(105),
        returnPct: 0.05,
        maxFavorableExcursionPct: 0.06,
        maxAdverseExcursionPct: -0.01,
        benchmarkReturnPct: 0.01,
        benchmarkStatus: 'complete',
        status: 'complete',
        provenance: { provider: 'fixture', observedAt, fetchedAt: now, freshness: 'fresh' },
        observedAt,
      });
    }
    await ctx.repos.strategyAutonomyAction.save(
      validatingActionFixture('strategy-first', {
        strategyVersionId: 'strategy-first:v1',
      }),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.promotion).toMatchObject({ evaluated: 1, published: 1, blocked: 0 });
    expect(result.data.promotion.items[0]).toMatchObject({ decision: 'published' });
    const action = await ctx.repos.strategyAutonomyAction.findById(
      'strategy-first-propose-validating',
    );
    expect(action?.status).toBe('published');
    const strategy = await ctx.repos.strategy.findById('strategy-first');
    expect(strategy).toMatchObject({ status: 'active', currentVersionId: 'strategy-first:v1' });
    const version = await ctx.repos.strategy.findVersionById('strategy-first:v1');
    expect(version?.publishedAt).toBeDefined();
  });

  it('首发门禁未通过（观察不足）→ blocked 进人工队列，新策略保持 draft 未发布', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    await seedTestStockUniverse(ctx);
    await ctx.repos.strategy.create({
      id: 'strategy-first-blocked',
      name: '首发拦截策略',
      description: '首发门禁拦截测试',
      owner: 'user',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });
    await ctx.repos.strategy.createVersion({
      id: 'strategy-first-blocked:v1',
      strategyId: 'strategy-first-blocked',
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      createdAt: now,
    });
    const sessionId = 'strategy-first-blocked-session';
    const from = new Date('2026-08-03T00:00:00.000Z');
    const to = new Date('2026-08-31T00:00:00.000Z');
    await ctx.repos.strategyEvaluation.saveSession({
      id: sessionId,
      strategyId: 'strategy-first-blocked',
      strategyVersionId: 'strategy-first-blocked:v1',
      from,
      to,
      status: 'complete',
      definitionHash: strategyDefinitionHash(definition),
      createdAt: new Date(now.getTime() - 8 * DAY),
      finishedAt: new Date(now.getTime() - DAY),
    });
    for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
      const day = new Date(t);
      const dow = day.getUTCDay();
      if (dow === 0 || dow === 6) continue;
      await ctx.repos.strategyEvaluation.saveDay({
        sessionId,
        dataAsOf: day,
        status: 'complete',
        vintageStatus: 'available',
      });
    }
    await ctx.repos.strategyAutonomyAction.save(
      validatingActionFixture('strategy-first-blocked', {
        strategyVersionId: 'strategy-first-blocked:v1',
      }),
    );

    const result = await strategyAutonomyWeeklyWorkflow.run({}, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.promotion).toMatchObject({ evaluated: 1, blocked: 1, published: 0 });
    expect(result.data.promotion.items[0]?.decision).toBe('blocked');
    // 首发门禁不查 base/parent/diff：reasons 只含证据类条目
    expect(result.data.promotion.items[0]?.reasons).toContain('observations-insufficient');
    expect(result.data.promotion.items[0]?.reasons).not.toContain('base-version-missing');
    const action = await ctx.repos.strategyAutonomyAction.findById(
      'strategy-first-blocked-propose-validating',
    );
    expect(action?.status).toBe('blocked');
    const strategy = await ctx.repos.strategy.findById('strategy-first-blocked');
    expect(strategy).toMatchObject({ status: 'draft' });
    expect(strategy?.currentVersionId).toBeUndefined();
  });
});
