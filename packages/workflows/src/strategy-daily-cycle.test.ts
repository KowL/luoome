import type {
  StockCode,
  StockUniverseManagerLike,
  StrategyDslV1,
  StrategySchedule,
  StrategyVersion,
  ToolContext,
} from '@luoome/core';
import { money, strategyDefinitionHash } from '@luoome/core';
import { addHoldingTool, addTradeTool, getIntradayDeliveryAuditTool } from '@luoome/tools';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { closingReportWorkflow } from './closing-report.js';
import { closingReportCutoffWorkflow } from './closing-report-cutoff.js';
import { intradayTradingPlanWatchWorkflow } from './intraday-trading-plan-watch.js';
import { strategyDailyCycleWorkflow } from './strategy-daily-cycle.js';

const NOW = new Date('2026-08-10T10:00:00.000Z');

const seedSchedule = async (
  ctx: ToolContext,
  options: {
    readonly withSignal?: boolean;
    readonly key?: string;
    readonly scheduledAt?: Date;
    readonly cron?: string;
    readonly nextRunAt?: Date;
  } = {},
): Promise<void> => {
  const key = options.key ?? 'cycle';
  const scheduledAt = options.scheduledAt ?? NOW;
  await seedTestStockUniverse(ctx, { limit: 1, observedAt: scheduledAt });
  const definition: StrategyDslV1 = {
    schemaVersion: 1,
    metadata: {},
    universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
    selection: {
      logic: 'all',
      rules: [{ id: 'all', name: '全选', when: 'true', evidence: ['fixture'] }],
    },
    signals: {
      entry: options.withSignal
        ? [
            {
              id: 'entry',
              name: '测试入场',
              when: 'true',
              score: '80',
              direction: 'bullish' as const,
              evidence: ['fixture'],
            },
          ]
        : [],
      exit: [],
      risk: [],
    },
  };
  const version: StrategyVersion = {
    id: `${key}-v1`,
    strategyId: `${key}-strategy`,
    version: 1,
    definition,
    definitionHash: strategyDefinitionHash(definition),
    validationStatus: 'valid',
    validationErrors: [],
    publishedAt: scheduledAt,
    createdAt: scheduledAt,
  };
  await ctx.repos.strategy.create({
    id: `${key}-strategy`,
    name: '日循环故障矩阵',
    description: 'test',
    owner: 'user',
    status: 'active',
    currentVersionId: version.id,
    createdAt: scheduledAt,
    updatedAt: scheduledAt,
  });
  await ctx.repos.strategy.createVersion(version);
  const schedule: StrategySchedule = {
    id: `${key}-schedule`,
    strategyId: `${key}-strategy`,
    cron: options.cron ?? '0 18 * * 1-5',
    timezone: 'Asia/Shanghai',
    enabled: true,
    nextRunAt: options.nextRunAt ?? scheduledAt,
    createdAt: scheduledAt,
    updatedAt: scheduledAt,
  };
  await ctx.repos.strategySchedule.save(schedule);
};

describe('strategy-daily-cycle reliability matrix', () => {
  it('AI 恢复到计划、次日投递重试、登记交易和隔日复盘保持同一事实链', async () => {
    let currentTime = NOW;
    let failAI = true;
    let failNotification = false;
    let riskPrice: number | undefined;
    const accountId = 'a1b2c3d4-0001-4000-8000-000000000001';
    const stockId = '000858.SZ';
    const ctx = await buildTestContext({
      advices: [],
      clock: () => currentTime,
      marketTimestampSource: 'upstream',
    });
    const fetchQuote = ctx.adapters.market.fetchQuote.bind(ctx.adapters.market);
    ctx.adapters.market.fetchQuote = async (id) => {
      const quote = await fetchQuote(id);
      const observedAt =
        currentTime.getUTCHours() >= 7
          ? new Date(`${currentTime.toISOString().slice(0, 10)}T07:00:00.000Z`)
          : currentTime;
      return {
        ...quote,
        ...(id === stockId && riskPrice !== undefined ? { close: money(riskPrice) } : {}),
        observedAt,
        ts: observedAt,
      };
    };
    const generate = ctx.adapters.llm.generate.bind(ctx.adapters.llm);
    ctx.adapters.llm.generate = async <T = unknown>(
      request: Parameters<typeof generate>[0],
    ): Promise<T> => {
      if (!request.system.startsWith('analyze_position')) return generate<T>(request);
      if (failAI) throw new Error('fixture AI unavailable');
      const { quote } = request.data as { quote: { close: number } };
      return {
        decision: 'hold',
        confidence: 60,
        horizon: 'short',
        entryPrice: quote.close,
        stopLoss: money(quote.close * 0.95),
        targetPrice: money(quote.close * 1.1),
        reasoning: {
          premise: '测试持仓复核完成',
          evidence: ['固定行情事实'],
          counterEvidence: ['价格可能跌破风险条件'],
        },
        risks: ['测试波动风险'],
      } as T;
    };
    const notification = ctx.notification;
    if (notification === undefined) throw new Error('notification fixture missing');
    const send = notification.send.bind(notification);
    notification.send = async (input) => {
      if (!failNotification) return send(input);
      const failed = {
        id: input.id ?? 'journey-failed-notification',
        channel: input.channel,
        payload: input.payload,
        result: 'failed' as const,
        errorMessage: 'fixture channel unavailable',
        sentAt: currentTime,
      };
      await ctx.repos.notification.save(failed);
      return { notification: failed };
    };
    expect(
      await addHoldingTool.execute({ accountId, stockId, quantity: 100, avgCost: 100 }, ctx),
    ).toMatchObject({ ok: true });

    const failedCycle = await strategyDailyCycleWorkflow.run({ owner: 'journey-failed-ai' }, ctx);
    expect(failedCycle.ok).toBe(true);
    const main = (await ctx.repos.report.list({ kind: 'closing' })).find(
      (report) => report.scope.kind === 'account' && report.scope.accountId === accountId,
    );
    if (main === undefined) throw new Error('main report missing');
    expect(main.version).toBe(1);
    expect(main.missingDimensions).toContainEqual(
      expect.objectContaining({ dimension: 'trading-plans.daily-cycle' }),
    );

    currentTime = new Date(NOW.getTime() + 16 * 60_000);
    failAI = false;
    expect(
      await strategyDailyCycleWorkflow.run({ owner: 'journey-ai-restored' }, ctx),
    ).toMatchObject({
      ok: true,
    });
    const supplement = (await ctx.repos.report.list({ kind: 'closing' })).find(
      (report) => report.supersedesReportId === main.id,
    );
    expect(supplement?.version).toBe(2);
    expect(
      supplement?.missingDimensions.some((gap) => gap.dimension === 'trading-plans.daily-cycle'),
    ).toBe(false);
    expect((await ctx.repos.report.findById(main.id))?.sections).toEqual(main.sections);
    const plan = (await ctx.repos.tradingPlan.list({ accountId })).find(
      (candidate) => candidate.stockId === stockId,
    );
    if (plan?.exit.stopLoss === undefined) throw new Error('risk plan missing');
    expect(plan.status).toBe('active');
    riskPrice = plan.exit.stopLoss - 0.01;

    currentTime = new Date('2026-08-11T02:00:00.000Z');
    failNotification = true;
    const signal = await intradayTradingPlanWatchWorkflow.run({ accountId }, ctx);
    expect(signal.ok).toBe(true);
    if (!signal.ok) return;
    expect(signal.data.notifyFailed).toBe(1);
    const triggerId = signal.data.triggers[0]?.id;
    if (triggerId === undefined) throw new Error('risk trigger missing');
    expect(signal.data.triggers[0]?.deliveryStatus).toBe('failed');

    currentTime = new Date('2026-08-11T02:02:00.000Z');
    failNotification = false;
    expect(await intradayTradingPlanWatchWorkflow.run({ accountId }, ctx)).toMatchObject({
      ok: true,
    });
    expect(await ctx.repos.watchTrigger.findById(triggerId)).toMatchObject({
      deliveryStatus: 'sent',
      deliveryAttempts: 2,
    });
    const audit = await getIntradayDeliveryAuditTool.execute(
      { accountId, date: '2026-08-11' },
      ctx,
    );
    expect(audit).toMatchObject({
      ok: true,
      data: {
        candidateCount: 1,
        channelAcceptance: { accepted: 1, withinTenMinutes: 1, maxMs: 120_000 },
        deviceDeliveryVerified: false,
      },
    });
    expect((await ctx.repos.holding.findByAccountAndStock(accountId, stockId))?.quantity).toBe(100);
    expect(await ctx.repos.trade.listByAccount(accountId)).toEqual([]);

    const trade = await addTradeTool.execute(
      {
        accountId,
        stockId,
        side: 'sell',
        quantity: 10,
        price: riskPrice,
        executedAt: currentTime,
        adviceId: plan.source.adviceIds[0],
      },
      ctx,
    );
    expect(trade.ok).toBe(true);
    expect((await ctx.repos.holding.findByAccountAndStock(accountId, stockId))?.quantity).toBe(90);
    const stale = await intradayTradingPlanWatchWorkflow.run({ accountId }, ctx);
    expect(stale).toMatchObject({ ok: true, data: { stalePlans: 1, triggers: [], notified: 0 } });

    currentTime = new Date('2026-08-11T10:00:00.000Z');
    expect(
      await strategyDailyCycleWorkflow.run({ owner: 'journey-next-close' }, ctx),
    ).toMatchObject({
      ok: true,
    });
    currentTime = new Date('2026-08-12T10:00:00.000Z');
    const review = await closingReportWorkflow.run(
      { date: '2026-08-12', scope: { kind: 'account', accountId }, notify: false },
      ctx,
    );
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    const section = review.data.report.sections.find((item) => item.key === 'prior-day-review');
    const metrics = section?.blocks.find((block) => block.kind === 'metrics');
    expect(metrics?.kind === 'metrics' ? metrics.items : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'planVersions', value: 1 }),
        expect.objectContaining({ key: 'triggerCount', value: 1 }),
        expect.objectContaining({ key: 'registeredTrades', value: 1 }),
      ]),
    );
    expect(JSON.stringify(section)).toContain('同股票、同日期不能证明提醒被执行');
  });

  it('数据 checkpoint 无法建立时失败并推进 schedule，不生成 run', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedSchedule(ctx);
    const failedDataCtx: ToolContext = {
      ...ctx,
      adapters: {
        ...ctx.adapters,
        market: {
          ...ctx.adapters.market,
          fetchDailyBars: async () => {
            throw new Error('provider unavailable');
          },
        },
      },
    };
    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-worker', asOf: NOW, leaseMinutes: 5 },
      failedDataCtx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      status: 'failed',
      phase: 'finish',
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' })).toEqual([]);
    expect(
      await ctx.repos.workflowRun.listRecent({ workflowName: 'strategy-daily-cycle' }),
    ).toHaveLength(1);
  });

  it('AI 失败时保留已发布事实并返回 facts-only partial 周期', async () => {
    const base = await buildTestContext({
      clock: () => NOW,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    await seedSchedule(base);
    const ctx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        llm: {
          name: 'failing-llm',
          generate: async () => {
            throw new Error('provider unavailable');
          },
        },
      },
    };
    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-worker', asOf: NOW, leaseMinutes: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      status: 'partial',
      insightProvider: 'facts-only',
    });
    const runId = result.data.items[0]?.runId;
    expect(runId).toBeDefined();
    expect(
      runId === undefined ? null : await ctx.repos.strategyRun.findRunById(runId),
    ).toMatchObject({
      status: 'complete',
      publication: { status: 'published' },
    });
    expect(
      await ctx.repos.workflowRun.listRecent({ workflowName: 'strategy-daily-cycle' }),
    ).toHaveLength(1);
    const audit = (
      await ctx.repos.workflowRun.listRecent({
        workflowName: 'strategy-daily-cycle',
      })
    )[0];
    expect(audit?.inputSummary).toMatchObject({
      schemaVersion: 1,
      strategyId: 'cycle-strategy',
      scheduleId: 'cycle-schedule',
      requestedBy: 'historical',
    });
    expect(audit?.outputSummary).toMatchObject({
      schemaVersion: 1,
      benchmarkSync: {
        status: 'skipped',
        dataVersion: '000300.SH:qfq:daily:v1',
        stockId: '000300.SH',
      },
    });
  });

  it('观察阶段失败时不回滚已发布 StrategyRun，WorkflowRun 保留后阶段审计', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    await seedSchedule(base, { withSignal: true });
    const observationRepo = base.repos.signalObservation;
    const ctx: ToolContext = {
      ...base,
      repos: {
        ...base.repos,
        signalObservation: {
          ...observationRepo,
          save: async () => {
            throw new Error('observation store unavailable');
          },
        },
      },
    };
    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-observation-failure', asOf: NOW, leaseMinutes: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({ status: 'failed', phase: 'finish' });
    const runs = await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'complete', publication: { status: 'published' } });
    const audits = await ctx.repos.workflowRun.listRecent({ workflowName: 'strategy-daily-cycle' });
    expect(audits[0]).toMatchObject({ status: 'failed' });
    expect(audits[0]?.outputSummary).toMatchObject({ status: 'failed', publication: 'published' });
    expect(audits[0]?.outputSummary?.phaseTimings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'observations' }),
        expect.objectContaining({ phase: 'finish' }),
      ]),
    );
  });

  it('schedule lease 丢失时不提交运行事实', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    await seedSchedule(base);
    const ctx: ToolContext = {
      ...base,
      repos: {
        ...base.repos,
        strategySchedule: {
          save: (...args: Parameters<typeof base.repos.strategySchedule.save>) =>
            base.repos.strategySchedule.save(...args),
          removeByStrategyId: (
            ...args: Parameters<typeof base.repos.strategySchedule.removeByStrategyId>
          ) => base.repos.strategySchedule.removeByStrategyId(...args),
          findById: (...args: Parameters<typeof base.repos.strategySchedule.findById>) =>
            base.repos.strategySchedule.findById(...args),
          findByStrategyId: (
            ...args: Parameters<typeof base.repos.strategySchedule.findByStrategyId>
          ) => base.repos.strategySchedule.findByStrategyId(...args),
          list: (...args: Parameters<typeof base.repos.strategySchedule.list>) =>
            base.repos.strategySchedule.list(...args),
          claimDue: (...args: Parameters<typeof base.repos.strategySchedule.claimDue>) =>
            base.repos.strategySchedule.claimDue(...args),
          claimDueWithFence: (
            ...args: Parameters<typeof base.repos.strategySchedule.claimDueWithFence>
          ) => base.repos.strategySchedule.claimDueWithFence(...args),
          renewClaim: async () => false,
          finishClaim: (...args: Parameters<typeof base.repos.strategySchedule.finishClaim>) =>
            base.repos.strategySchedule.finishClaim(...args),
        },
      },
    };
    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-worker', asOf: NOW, leaseMinutes: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({
      status: 'failed',
      reason: 'lease_lost_before_commit',
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' })).toEqual([]);
  });

  it('数据准备后被另一实例接管时，旧 owner 在 run/观察/Advice 前被同步 fence 拒绝', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    await seedSchedule(base, { withSignal: true });
    const adviceIdsBefore = new Set(
      (await base.repos.advice.query({ includeExpired: true })).map((advice) => advice.id),
    );
    let renewals = 0;
    const strategySchedule = base.repos.strategySchedule;
    const ctx: ToolContext = {
      ...base,
      repos: {
        ...base.repos,
        strategySchedule: {
          save: (...args: Parameters<typeof strategySchedule.save>) =>
            strategySchedule.save(...args),
          removeByStrategyId: (...args: Parameters<typeof strategySchedule.removeByStrategyId>) =>
            strategySchedule.removeByStrategyId(...args),
          findById: (...args: Parameters<typeof strategySchedule.findById>) =>
            strategySchedule.findById(...args),
          findByStrategyId: (...args: Parameters<typeof strategySchedule.findByStrategyId>) =>
            strategySchedule.findByStrategyId(...args),
          list: (...args: Parameters<typeof strategySchedule.list>) =>
            strategySchedule.list(...args),
          claimDue: (...args: Parameters<typeof strategySchedule.claimDue>) =>
            strategySchedule.claimDue(...args),
          claimDueWithFence: (...args: Parameters<typeof strategySchedule.claimDueWithFence>) =>
            strategySchedule.claimDueWithFence(...args),
          renewClaim: async (...args: Parameters<typeof strategySchedule.renewClaim>) => {
            renewals += 1;
            return renewals === 1 ? strategySchedule.renewClaim(...args) : false;
          },
          finishClaim: (...args: Parameters<typeof strategySchedule.finishClaim>) =>
            strategySchedule.finishClaim(...args),
        },
      },
    };

    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'stale-owner', asOf: NOW, leaseMinutes: 5 },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(renewals).toBe(2);
    expect(result.data.items[0]).toMatchObject({
      status: 'failed',
      reason: 'lease_lost_before_commit',
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' })).toEqual([]);
    expect(await ctx.repos.signalObservation.list({ sourceKind: 'strategy-signal' })).toEqual([]);
    expect(
      (await ctx.repos.advice.query({ includeExpired: true })).map((advice) => advice.id),
    ).toEqual([...adviceIdsBefore]);
  });

  it('生产日运行前同步真实目录快照，显式历史 asOf 不触发实时同步', async () => {
    const LATER = new Date('2026-08-11T12:00:00.000Z');
    const base = await buildTestContext({ clock: () => LATER });
    await seedSchedule(base);
    let fetches = 0;
    const dailyBarFetches: string[] = [];
    const stockUniverse: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['real-test-source'],
      fetchStockUniverse: async () => {
        fetches += 1;
        return {
          source: 'real-test-source',
          coverage: 'CN_A_SHARES_SH_SZ' as const,
          observedAt: LATER,
          complete: true,
          reportedTotal: 1,
          entries: [
            {
              stockId: '002594.SZ',
              code: '002594' as StockCode,
              exchange: 'SZ' as const,
              name: '测试股票',
              listingStatus: 'listed' as const,
            },
          ],
        };
      },
    };
    const productionCtx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        stockUniverse,
        market: {
          ...base.adapters.market,
          fetchDailyBars: async (stockId, range) => {
            dailyBarFetches.push(stockId);
            return base.adapters.market.fetchDailyBars(stockId, range);
          },
        },
      },
    };

    const production = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-production', leaseMinutes: 5 },
      productionCtx,
    );
    expect(production.ok).toBe(true);
    expect(fetches).toBe(1);
    expect(dailyBarFetches).toContain('000300.SH');
    const benchmarkFetchesAfterProduction = dailyBarFetches.filter(
      (stockId) => stockId === '000300.SH',
    ).length;
    const synced = await productionCtx.repos.stockUniverse.latestSnapshotAtOrBefore({
      coverage: 'CN_A_SHARES_SH_SZ',
      asOf: LATER,
    });
    expect(synced).toMatchObject({ source: 'real-test-source', observedAt: LATER });

    const scheduled = await productionCtx.repos.strategySchedule.findById('cycle-schedule');
    expect(scheduled).not.toBeNull();
    if (scheduled === null) return;
    await productionCtx.repos.strategySchedule.save({ ...scheduled, nextRunAt: LATER });
    const historical = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-historical', asOf: NOW, leaseMinutes: 5 },
      productionCtx,
    );
    expect(historical.ok).toBe(true);
    expect(fetches).toBe(1);
    expect(dailyBarFetches.filter((stockId) => stockId === '000300.SH')).toHaveLength(
      benchmarkFetchesAfterProduction,
    );
  });

  it('生产日目录同步失败时不使用旧快照继续发布策略运行', async () => {
    const LATER = new Date('2026-08-11T12:00:00.000Z');
    const base = await buildTestContext({ clock: () => LATER });
    await seedSchedule(base);
    const stockUniverse: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['real-source'],
      fetchStockUniverse: async () => {
        throw new Error('real provider unavailable');
      },
    };
    const ctx: ToolContext = { ...base, adapters: { ...base.adapters, stockUniverse } };
    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-no-stale-fallback', leaseMinutes: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]).toMatchObject({ status: 'failed', phase: 'finish' });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' })).toEqual([]);
  });

  it('同一 schedule 交易日已有正式运行时跳过后续 cron tick', async () => {
    let now = NOW;
    const base = await buildTestContext({ clock: () => now });
    const ctx: ToolContext = {
      ...base,
      adapters: {
        ...base.adapters,
        stockUniverse: {
          name: 'stock-universe',
          sources: ['stock-universe'],
          fetchStockUniverse: async () => ({
            source: 'stock-universe',
            coverage: 'CN_A_SHARES_SH_SZ' as const,
            observedAt: now,
            complete: true,
            reportedTotal: 1,
            entries: [
              {
                stockId: '600519.SH',
                code: '600519' as StockCode,
                exchange: 'SH' as const,
                name: '贵州茅台',
                listingStatus: 'listed' as const,
              },
            ],
          }),
        },
      },
    };
    await seedSchedule(ctx);

    const first = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-first', leaseMinutes: 5 },
      ctx,
    );
    expect(first.ok).toBe(true);
    const firstRuns = await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' });
    expect(firstRuns).toHaveLength(1);
    const firstRun = firstRuns[0];
    if (firstRun === undefined) return;

    // 让第二次 claim 的“今天”与 checkpoint 交易日一致；文件 SQLite 读回 JSON
    // 时可能是 ISO 字符串，不能只依赖内存 repo 的 Date 形态。
    const snapshot = firstRun.inputSnapshot;
    const checkpoint =
      typeof snapshot === 'object' && snapshot !== null && 'dataCheckpoint' in snapshot
        ? snapshot.dataCheckpoint
        : undefined;
    const checkpointDataAsOf =
      typeof checkpoint === 'object' && checkpoint !== null && 'dataAsOf' in checkpoint
        ? checkpoint.dataAsOf
        : undefined;
    now = new Date(
      typeof checkpointDataAsOf === 'string' || typeof checkpointDataAsOf === 'number'
        ? checkpointDataAsOf
        : firstRun.dataAsOf,
    );
    const schedule = await ctx.repos.strategySchedule.findById('cycle-schedule');
    expect(schedule).not.toBeNull();
    if (schedule === null) return;
    await ctx.repos.strategySchedule.save({ ...schedule, nextRunAt: now });

    const second = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-duplicate', leaseMinutes: 5 },
      ctx,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.items[0]).toMatchObject({
      status: 'skipped',
      reason: 'schedule-day-duplicate',
    });
    expect(await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' })).toHaveLength(1);
  });

  it('生产日多个策略共用发现批次，截止后每个账户各发布一份主报告', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    const stockUniverse: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['test-source'],
      fetchStockUniverse: async () => ({
        source: 'test-source',
        coverage: 'CN_A_SHARES_SH_SZ' as const,
        observedAt: NOW,
        complete: true,
        reportedTotal: 1,
        entries: [
          {
            stockId: '600519.SH',
            code: '600519' as StockCode,
            exchange: 'SH' as const,
            name: '贵州茅台',
            listingStatus: 'listed' as const,
          },
        ],
      }),
    };
    const ctx: ToolContext = { ...base, adapters: { ...base.adapters, stockUniverse } };
    await seedSchedule(ctx, { key: 'cycle-a' });
    await seedSchedule(ctx, { key: 'cycle-b' });

    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-reports', limit: 1, leaseMinutes: 5 },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(2);
    for (const item of result.data.items) {
      expect(item.runId).toBeDefined();
      expect(item.status).not.toBe('failed');
    }
    const accountIds = (await ctx.repos.account.list()).map((account) => account.id).sort();
    expect(await ctx.repos.workflowRun.listRecent({ workflowName: 'closing-report' })).toHaveLength(
      accountIds.length,
    );
    const reports = await ctx.repos.report.list({ kind: 'closing' });
    expect(reports).toHaveLength(accountIds.length);
    expect(
      reports.map((report) => report.scope.kind === 'account' && report.scope.accountId).sort(),
    ).toEqual(accountIds);
    for (const report of reports) {
      expect(report).toMatchObject({
        kind: 'closing',
        periodStart: '2026-08-10',
        periodEnd: '2026-08-10',
      });
      const strategySection = report.sections.find((section) => section.key === 'strategy-actions');
      const strategyTable = strategySection?.blocks.find((block) => block.kind === 'table');
      expect(strategyTable?.kind === 'table' ? strategyTable.rows : []).toHaveLength(2);
    }
  });

  it('收盘报告生成失败时本轮记 partial，不回滚已提交的 run', async () => {
    const base = await buildTestContext({ clock: () => NOW });
    const stockUniverse: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['test-source'],
      fetchStockUniverse: async () => ({
        source: 'test-source',
        coverage: 'CN_A_SHARES_SH_SZ' as const,
        observedAt: NOW,
        complete: true,
        reportedTotal: 1,
        entries: [
          {
            stockId: '600519.SH',
            code: '600519' as StockCode,
            exchange: 'SH' as const,
            name: '贵州茅台',
            listingStatus: 'listed' as const,
          },
        ],
      }),
    };
    await seedSchedule(base);
    const reportRepo = base.repos.report;
    const ctx: ToolContext = {
      ...base,
      adapters: { ...base.adapters, stockUniverse },
      repos: {
        ...base.repos,
        report: {
          reuseDecisionReviewReport: (
            ...args: Parameters<typeof reportRepo.reuseDecisionReviewReport>
          ) => reportRepo.reuseDecisionReviewReport(...args),
          findRefreshReceipt: (...args: Parameters<typeof reportRepo.findRefreshReceipt>) =>
            reportRepo.findRefreshReceipt(...args),
          appendDecisionReviewSupplement: (
            ...args: Parameters<typeof reportRepo.appendDecisionReviewSupplement>
          ) => reportRepo.appendDecisionReviewSupplement(...args),
          upsertForPeriod: async () => {
            throw new Error('report store unavailable');
          },
          findById: (...args: Parameters<typeof reportRepo.findById>) =>
            reportRepo.findById(...args),
          findByPeriodVersion: (...args: Parameters<typeof reportRepo.findByPeriodVersion>) =>
            reportRepo.findByPeriodVersion(...args),
          findByPeriod: (...args: Parameters<typeof reportRepo.findByPeriod>) =>
            reportRepo.findByPeriod(...args),
          list: (...args: Parameters<typeof reportRepo.list>) => reportRepo.list(...args),
          claimDelivery: (...args: Parameters<typeof reportRepo.claimDelivery>) =>
            reportRepo.claimDelivery(...args),
          finishDelivery: (...args: Parameters<typeof reportRepo.finishDelivery>) =>
            reportRepo.finishDelivery(...args),
          setDeliveryStatus: (...args: Parameters<typeof reportRepo.setDeliveryStatus>) =>
            reportRepo.setDeliveryStatus(...args),
          remove: (...args: Parameters<typeof reportRepo.remove>) => reportRepo.remove(...args),
        },
      },
    };

    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-report-failure', leaseMinutes: 5 },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]?.status).toBe('partial');
    expect(result.data.items[0]?.reason).toContain('收盘复盘生成失败');
    const runs = await ctx.repos.strategyRun.listRuns({ strategyId: 'cycle-strategy' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'complete', publication: { status: 'published' } });
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(0);
  });

  it('显式历史 asOf 运行不触发收盘报告', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    await seedSchedule(ctx);

    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-historical-no-report', asOf: NOW, leaseMinutes: 5 },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items[0]?.runId).toBeDefined();
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(0);
    expect(await ctx.repos.workflowRun.listRecent({ workflowName: 'closing-report' })).toHaveLength(
      0,
    );
  });

  it('领取到 schedule 但没有产生 run 时仍生成当日计划批次与主报告', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    // 指向不存在的 Strategy：schedule 被领取但不可运行，本轮没有任何 runId。
    await ctx.repos.strategySchedule.save({
      id: 'ineligible-schedule',
      strategyId: 'missing-strategy',
      cron: '0 18 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
      nextRunAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await strategyDailyCycleWorkflow.run(
      { owner: 'cycle-silent-day', leaseMinutes: 5 },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]?.runId).toBeUndefined();
    expect(result.data.items[0]?.status).toBe('skipped');
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(3);
    expect(await ctx.repos.workflowRun.listRecent({ workflowName: 'closing-report' })).toHaveLength(
      3,
    );
  });

  it('没有到期策略时，18:00 后仍为每个账户出报且重复 tick 不覆盖主报告', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const first = await strategyDailyCycleWorkflow.run({ owner: 'cutoff-first' }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.items).toEqual([]);
    const original = await ctx.repos.report.list({ kind: 'closing' });
    expect(original).toHaveLength(3);

    const repeated = await strategyDailyCycleWorkflow.run({ owner: 'cutoff-again' }, ctx);
    expect(repeated.ok).toBe(true);
    const after = await ctx.repos.report.list({ kind: 'closing' });
    expect(after.map((report) => report.id)).toEqual(original.map((report) => report.id));
    expect(await ctx.repos.workflowRun.listRecent({ workflowName: 'closing-report' })).toHaveLength(
      3,
    );
  });

  it('截止 tick 在渠道故障恢复后补投已存在的主报告，不生成新版本', async () => {
    let currentTime = NOW;
    let failDelivery = true;
    const base = await buildTestContext({ clock: () => currentTime });
    const healthyNotification = base.notification;
    if (healthyNotification === undefined) throw new Error('notification fixture missing');
    const ctx: ToolContext = {
      ...base,
      notification: {
        send: async (input) => {
          if (!failDelivery) return healthyNotification.send(input);
          const notification = {
            id: input.id ?? 'missing-report-id',
            channel: input.channel,
            payload: input.payload,
            result: 'failed' as const,
            errorMessage: 'fixture channel unavailable',
            sentAt: currentTime,
          };
          await base.repos.notification.save(notification);
          return { notification };
        },
      },
    };
    const first = await closingReportCutoffWorkflow.run({}, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.created).toHaveLength(3);
    const original = await ctx.repos.report.list({ kind: 'closing' });
    expect(original.map((report) => report.deliveryStatus)).toEqual(['failed', 'failed', 'failed']);

    failDelivery = false;
    currentTime = new Date(NOW.getTime() + 16 * 60_000);
    const retry = await closingReportCutoffWorkflow.run({}, ctx);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.created).toEqual([]);
    expect(retry.data.failed).toEqual([]);
    const delivered = await ctx.repos.report.list({ kind: 'closing' });
    expect(delivered.map((report) => report.id)).toEqual(original.map((report) => report.id));
    expect(delivered.map((report) => report.deliveryStatus)).toEqual(['sent', 'sent', 'sent']);
    expect(await ctx.repos.notification.listRecent()).toHaveLength(3);
  });

  it('飞书未配置的主报告在渠道恢复后补投，不生成新版本', async () => {
    let currentTime = NOW;
    let unconfigured = true;
    let attempts = 0;
    const base = await buildTestContext({ clock: () => currentTime });
    const ctx: ToolContext = {
      ...base,
      notification: {
        send: async (input) => {
          attempts += 1;
          const notification = {
            id: input.id ?? 'missing-report-id',
            channel: input.channel,
            payload: input.payload,
            result: unconfigured ? ('suppressed' as const) : ('success' as const),
            sentAt: currentTime,
          };
          await base.repos.notification.save(notification);
          return { notification };
        },
      },
    };
    const first = await closingReportCutoffWorkflow.run({}, ctx);
    expect(first.ok).toBe(true);
    const original = await ctx.repos.report.list({ kind: 'closing' });
    expect(original).toHaveLength(3);
    expect(original.every((report) => report.deliveryStatus === 'fallback-log')).toBe(true);

    unconfigured = false;
    currentTime = new Date(NOW.getTime() + 16 * 60_000);
    const retry = await closingReportCutoffWorkflow.run({}, ctx);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.data.created).toEqual([]);
    expect(retry.data.failed).toEqual([]);
    expect(attempts).toBe(6);
    const delivered = await ctx.repos.report.list({ kind: 'closing' });
    expect(delivered.map((report) => report.id)).toEqual(original.map((report) => report.id));
    expect(delivered.map((report) => report.deliveryStatus)).toEqual(['sent', 'sent', 'sent']);
  });

  it('跨天缺失主版补记为 partial，历史行情与账户快照明确不可用', async () => {
    let currentTime = NOW;
    const ctx = await buildTestContext({ clock: () => currentTime });
    const first = await closingReportCutoffWorkflow.run({}, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const previous = await ctx.repos.report.list({ kind: 'closing' });
    expect(previous).toHaveLength(3);
    const missingAccount = (await ctx.repos.account.list())[0];
    if (missingAccount === undefined) throw new Error('account fixture missing');
    const missingReport = previous.find(
      (report) => report.scope.kind === 'account' && report.scope.accountId === missingAccount.id,
    );
    if (missingReport === undefined) throw new Error('report fixture missing');
    await ctx.repos.report.remove(missingReport.id);

    currentTime = new Date('2026-08-11T10:30:00.000Z');
    const historical = await closingReportCutoffWorkflow.run({ date: '2026-08-10' }, ctx);
    expect(historical.ok).toBe(true);
    if (!historical.ok) return;
    expect(historical.data.created).toEqual([missingAccount.id]);
    expect(historical.data.failed).toEqual([]);
    const recovered = await ctx.repos.report.list({ kind: 'closing' });
    expect(recovered).toHaveLength(3);
    const gap = recovered.find(
      (report) => report.scope.kind === 'account' && report.scope.accountId === missingAccount.id,
    );
    expect(gap?.status).toBe('partial');
    expect(gap?.title).toContain('逾期缺口补记');
    expect(gap?.generatedAt).toEqual(currentTime);
    expect(gap?.sections.every((section) => section.status === 'unavailable')).toBe(true);
    expect(
      gap?.missingDimensions.every((item) => item.errorKind === 'historical_snapshot_unavailable'),
    ).toBe(true);
    expect(gap?.missingDimensions.every((item) => item.retryable === false)).toBe(true);
    expect(
      gap?.sections.find((section) => section.key === 'historical-recovery')?.blocks[0],
    ).toMatchObject({ text: expect.stringContaining('不使用当前数据代替') });
    const repeated = await closingReportCutoffWorkflow.run({ date: '2026-08-10' }, ctx);
    expect(repeated.ok).toBe(true);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(3);
  });

  it('18:00 之后新建的账户不计入当天截止报告', async () => {
    const now = new Date(NOW.getTime() + 20 * 60_000);
    const ctx = await buildTestContext({ clock: () => now });
    const lateAccount = (await ctx.repos.account.list())[0];
    if (lateAccount === undefined) throw new Error('account fixture missing');
    await ctx.repos.account.save({
      ...lateAccount,
      createdAt: new Date(NOW.getTime() + 5 * 60_000),
    });
    const cutoff = await closingReportCutoffWorkflow.run({}, ctx);
    expect(cutoff.ok).toBe(true);
    if (!cutoff.ok) return;
    expect(cutoff.data.created).toHaveLength(2);
    expect(cutoff.data.created).not.toContain(lateAccount.id);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(2);
  });

  it('截止时间之前没有到期策略时不提前发布空报告', async () => {
    const beforeCutoff = new Date(NOW.getTime() - 60_000);
    const ctx = await buildTestContext({ clock: () => beforeCutoff });
    const result = await strategyDailyCycleWorkflow.run({ owner: 'before-cutoff' }, ctx);
    expect(result.ok).toBe(true);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toEqual([]);
  });

  it('预期策略与全部账户批次在 18:00 前完成时提前发布，账本变化形成补充版', async () => {
    const scheduledAt = new Date('2026-08-10T08:30:00.000Z');
    let currentTime = new Date('2026-08-10T08:31:00.000Z');
    const stockUniverse: StockUniverseManagerLike = {
      name: 'stock-universe',
      sources: ['test-source'],
      fetchStockUniverse: async () => ({
        source: 'test-source',
        coverage: 'CN_A_SHARES_SH_SZ' as const,
        observedAt: scheduledAt,
        complete: true,
        reportedTotal: 1,
        entries: [
          {
            stockId: '600519.SH',
            code: '600519' as StockCode,
            exchange: 'SH' as const,
            name: '贵州茅台',
            listingStatus: 'listed' as const,
          },
        ],
      }),
    };
    const ctx = await buildTestContext({ clock: () => currentTime, stockUniverse });
    await seedSchedule(ctx, { key: 'early', scheduledAt, cron: '30 16 * * 1-5' });
    await seedSchedule(ctx, {
      key: 'later',
      scheduledAt,
      cron: '0 17 * * 1-5',
      nextRunAt: new Date('2026-08-10T09:00:00.000Z'),
    });

    const first = await strategyDailyCycleWorkflow.run({ owner: 'early-main' }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.items).toHaveLength(1);
    expect(first.data.items[0]?.runId).toBeDefined();
    expect(await ctx.repos.report.list({ kind: 'closing' })).toEqual([]);

    currentTime = new Date('2026-08-10T09:01:00.000Z');
    const finishClaim = ctx.repos.strategySchedule.finishClaim.bind(ctx.repos.strategySchedule);
    let releaseFinish = (): void => {};
    let signalFinish = (): void => {};
    const finishGate = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    const reachedFinish = new Promise<void>((resolve) => {
      signalFinish = resolve;
    });
    ctx.repos.strategySchedule.finishClaim = async (input) => {
      if (input.id === 'later-schedule') {
        signalFinish();
        await finishGate;
      }
      await finishClaim(input);
    };
    const running = strategyDailyCycleWorkflow.run({ owner: 'all-ready' }, ctx);
    await reachedFinish;
    try {
      const concurrent = await strategyDailyCycleWorkflow.run({ owner: 'while-finishing' }, ctx);
      expect(concurrent.ok).toBe(true);
      expect(await ctx.repos.report.list({ kind: 'closing' })).toEqual([]);
    } finally {
      releaseFinish();
    }
    const finished = await running;
    ctx.repos.strategySchedule.finishClaim = finishClaim;
    expect(finished.ok).toBe(true);
    if (!finished.ok) return;
    expect(finished.data.items).toHaveLength(1);
    expect(finished.data.items[0]?.runId).toBeDefined();
    const main = await ctx.repos.report.list({ kind: 'closing' });
    expect(main).toHaveLength(3);
    expect(main.every((report) => report.version === 1)).toBe(true);
    expect(main.every((report) => report.generatedAt < NOW)).toBe(true);
    expect(
      main.every(
        (report) =>
          !report.missingDimensions.some((gap) =>
            gap.dimension.startsWith('strategy-actions.run.'),
          ),
      ),
    ).toBe(true);

    currentTime = new Date('2026-08-10T09:10:00.000Z');
    const unchanged = await strategyDailyCycleWorkflow.run({ owner: 'early-repeat' }, ctx);
    expect(unchanged.ok).toBe(true);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(3);

    const account = (await ctx.repos.account.list())[0];
    if (account === undefined) throw new Error('account fixture missing');
    await ctx.repos.account.save({ ...account, cashBalance: money(account.cashBalance + 100) });
    const changed = await strategyDailyCycleWorkflow.run({ owner: 'early-ledger-change' }, ctx);
    expect(changed.ok).toBe(true);
    const after = await ctx.repos.report.list({ kind: 'closing' });
    expect(after).toHaveLength(4);
    const accountReports = after.filter(
      (report) => report.scope.kind === 'account' && report.scope.accountId === account.id,
    );
    expect(accountReports.map((report) => report.version)).toEqual([2, 1]);
    expect(accountReports[1]?.id).toBe(
      main.find(
        (report) => report.scope.kind === 'account' && report.scope.accountId === account.id,
      )?.id,
    );
  });

  it('16:30 提前持久化所有账户计划批次，18:00 主报告读取批次状态', async () => {
    let currentTime = new Date('2026-08-10T08:30:00.000Z');
    const ctx = await buildTestContext({ clock: () => currentTime });
    const prepared = await strategyDailyCycleWorkflow.run({ owner: 'early-plan' }, ctx);
    expect(prepared.ok).toBe(true);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(0);
    const batches = await ctx.repos.workflowRun.listRecent({ workflowName: 'account-plan-batch' });
    expect(batches).toHaveLength(3);
    expect(batches.every((batch) => batch.status !== 'running')).toBe(true);

    currentTime = NOW;
    const cutoff = await closingReportCutoffWorkflow.run({}, ctx);
    expect(cutoff.ok).toBe(true);
    if (!cutoff.ok) return;
    expect(cutoff.data.created).toHaveLength(3);
    const reports = await ctx.repos.report.list({ kind: 'closing' });
    expect(reports).toHaveLength(3);
    for (const report of reports) {
      const plans = report.sections.find((section) => section.key === 'trading-plans');
      expect(
        plans?.missingDimensions.some((gap) => gap.dimension === 'trading-plans.daily-cycle'),
      ).toBe(false);
    }
    const repeated = await strategyDailyCycleWorkflow.run({ owner: 'early-plan-repeat' }, ctx);
    expect(repeated.ok).toBe(true);
    expect(
      await ctx.repos.workflowRun.listRecent({ workflowName: 'account-plan-batch' }),
    ).toHaveLength(3);
    expect(await ctx.repos.report.list({ kind: 'closing' })).toHaveLength(3);
  });

  it('计划批次完成后账户账本变化，截止报告不复用旧批次的完成状态', async () => {
    let currentTime = new Date('2026-08-10T08:30:00.000Z');
    const ctx = await buildTestContext({ clock: () => currentTime });
    const early = await strategyDailyCycleWorkflow.run({ owner: 'before-ledger-change' }, ctx);
    expect(early.ok).toBe(true);
    const account = (await ctx.repos.account.list())[0];
    if (account === undefined) return;
    await ctx.repos.account.save({ ...account, cashBalance: money(account.cashBalance + 100) });

    currentTime = NOW;
    const cutoff = await closingReportCutoffWorkflow.run({}, ctx);
    expect(cutoff.ok).toBe(true);
    const reports = await ctx.repos.report.list({ kind: 'closing' });
    const changed = reports.find(
      (report) => report.scope.kind === 'account' && report.scope.accountId === account.id,
    );
    const planSection = changed?.sections.find((section) => section.key === 'trading-plans');
    expect(planSection?.status).toBe('partial');
    expect(planSection?.missingDimensions).toContainEqual(
      expect.objectContaining({ dimension: 'trading-plans.daily-cycle' }),
    );
  });

  it('截止时账户批次缺失，主报告标 partial，随后批次完成生成补充版本', async () => {
    const ctx = await buildTestContext({ clock: () => NOW });
    const original = await closingReportCutoffWorkflow.run({}, ctx);
    expect(original.ok).toBe(true);
    if (!original.ok) return;
    expect(original.data.created).toHaveLength(3);
    const primary = await ctx.repos.report.list({ kind: 'closing' });
    expect(primary).toHaveLength(3);
    for (const report of primary) {
      const plans = report.sections.find((section) => section.key === 'trading-plans');
      expect(plans?.status).toBe('partial');
      expect(
        plans?.missingDimensions.some((gap) => gap.dimension === 'trading-plans.daily-cycle'),
      ).toBe(true);
    }

    const resumed = await strategyDailyCycleWorkflow.run({ owner: 'late-plan' }, ctx);
    expect(resumed.ok).toBe(true);
    const reports = await ctx.repos.report.list({ kind: 'closing' });
    expect(reports).toHaveLength(6);
    for (const report of primary) {
      const supplement = reports.find((item) => item.supersedesReportId === report.id);
      expect(supplement?.version).toBe(2);
      expect((await ctx.repos.report.findById(report.id))?.version).toBe(1);
    }
  });

  it('主报告发布后才完成的策略批次形成补充版本，不覆盖原报告', async () => {
    let currentTime = NOW;
    const ctx = await buildTestContext({ clock: () => currentTime });
    const first = await strategyDailyCycleWorkflow.run({ owner: 'late-first' }, ctx);
    expect(first.ok).toBe(true);
    const originals = await ctx.repos.report.list({ kind: 'closing' });
    expect(originals).toHaveLength(3);
    await seedSchedule(ctx, { key: 'late' });

    currentTime = new Date(NOW.getTime() + 60_000);
    const late = await strategyDailyCycleWorkflow.run(
      { owner: 'late-second', leaseMinutes: 5 },
      ctx,
    );
    expect(late.ok).toBe(true);
    if (!late.ok) return;
    expect(late.data.items).toHaveLength(1);
    const reports = await ctx.repos.report.list({ kind: 'closing' });
    expect(reports).toHaveLength(6);
    for (const original of originals) {
      const supplement = reports.find((report) => report.supersedesReportId === original.id);
      expect(supplement?.version).toBe(2);
      expect((await ctx.repos.report.findById(original.id))?.version).toBe(1);
    }
  });
});
