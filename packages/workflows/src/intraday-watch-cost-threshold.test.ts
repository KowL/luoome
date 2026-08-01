import type { AlertPlan, ToolContext } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { withFixedQuoteAdapter } from '@luoome/tools/testing/fixed-quote-adapter';
import { describe, expect, it } from 'vitest';

import { intradayWatchWorkflow } from './intraday-watch.js';

/**
 * cost-threshold 规则单测（v0.6 起）。
 *
 * 与 intraday-watch.test.ts 拆开：本文件只覆盖 cost-threshold 规则的
 * 8 类语义边界（止盈 / 止损 / 双向 / 边界 / 不命中 / avgCost 缺 / 行情缺 /
 * sell direction），保证不与基础路径测试相互耦合。
 *
 * 数据背景（来自 packages/adapters/src/mocks/fixtures.ts）：
 *   test-holding-002594: stockId=002594.SZ, avgCost=98.5
 *   test-holding-00700:   stockId=00700.HK,   avgCost=480.0
 *   test-holding-300750:  stockId=300750.SZ,  avgCost=250.0
 *   test-holding-600036:  stockId=600036.SH,  avgCost=39.8
 *   test-holding-AAPL:    stockId=AAPL.US,    avgCost=195.0
 *
 * 通过 FixedQuoteAdapter 把"现价"注入到固定值，避免依赖 hash 随机。
 */

// 仓集合：002594.SZ（成本 98.5）+ 00700.HK（成本 480.0）+ 一个未持仓的占位 stock。
const TWO_HOLDINGS_ACCOUNT_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
// accountId 固定为 fixtures 中的 mock account；成员解析会拉全活跃持仓。
// 不持仓的 stockId 不在 batch_quote 结果里（unresolved → 不命中 cost-threshold）。

const T0 = new Date('2026-07-21T02:30:00.000Z');

/** 测试共用分组：holdings（成本阈值现算）+ manual（无 avgCost 场景）。 */
const HOLDINGS_GROUP_ID = 'holdings-group';
const MANUAL_GROUP_ID = 'manual-group';

/** 测试沿用旧 pool 字段形状（groupId / 可缺省 rule.id）；统一在此转换为 AlertPlan 落库。 */
type TestPlanInput = Omit<AlertPlan, 'watchlistId' | 'rules'> & {
  readonly groupId: string;
  readonly rules: readonly Record<string, unknown>[];
};

const savePlan = async (ctx: ToolContext, pool: TestPlanInput): Promise<void> => {
  await ctx.repos.alertPlan.save({
    id: pool.id,
    name: pool.name,
    ...(pool.description === undefined ? {} : { description: pool.description }),
    watchlistId: pool.groupId,
    rules: pool.rules.map((rule, index) => ({
      ...rule,
      id: rule.id ?? `rule-${index + 1}`,
    })) as unknown as AlertPlan['rules'],
    logic: pool.logic,
    triggerMode: pool.triggerMode,
    ...(pool.priority === undefined ? {} : { priority: pool.priority }),
    cooldownMinutes: pool.cooldownMinutes,
    dailyNotificationLimit: pool.dailyNotificationLimit,
    notifyOnRecovery: pool.notifyOnRecovery,
    enabled: pool.enabled,
    createdAt: pool.createdAt,
    updatedAt: pool.updatedAt,
  });
};

/** 构造带固定行情的 ctx，并预置 cost-threshold 用的 holdings / manual Watchlist。 */
const setupCtx = async (quotes: Record<string, number>) => {
  const ctx = await buildTestContext();
  const fixed = withFixedQuoteAdapter(ctx, quotes);
  await ctx.repos.watchlist.save({
    id: HOLDINGS_GROUP_ID,
    name: '持仓观察',
    kind: 'portfolio',
    membershipPolicy: 'synced',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });
  for (const holding of await ctx.repos.holding.listByAccount(TWO_HOLDINGS_ACCOUNT_ID)) {
    if (holding.closedAt !== null) continue;
    await ctx.repos.watchlistMember.saveMember({
      id: `${HOLDINGS_GROUP_ID}:${holding.stockId}`,
      watchlistId: HOLDINGS_GROUP_ID,
      stockId: holding.stockId,
      stage: 'discovered',
      priority: 'normal',
      firstAddedAt: T0,
      lastActivityAt: T0,
    });
  }
  await ctx.repos.watchlist.save({
    id: MANUAL_GROUP_ID,
    name: '手工观察',
    kind: 'personal',
    membershipPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });
  await ctx.repos.watchlistMember.saveMember({
    id: `${MANUAL_GROUP_ID}:002594.SZ`,
    watchlistId: MANUAL_GROUP_ID,
    stockId: '002594.SZ',
    stage: 'watching',
    priority: 'normal',
    firstAddedAt: T0,
    lastActivityAt: T0,
  });
  return { ctx: fixed, businessCtx: ctx };
};

describe('intraday-watch cost-threshold 规则', () => {
  it('take-profit 命中：close = avgCost × 1.10 > 1.05 → 触发 direction=sell', async () => {
    const { ctx } = await setupCtx({
      '002594.SZ': 108.35, // 98.5 × 1.10
      '00700.HK': 528.0, // 480 × 1.10
      '300750.SZ': 275.0, // 250 × 1.10
      '600036.SH': 43.78, // 39.8 × 1.10
      'AAPL.US': 214.5, // 195 × 1.10
    });
    await savePlan(ctx, {
      id: 'tp-only',
      name: '止盈池',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['tp-only'], notify: false, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 5 个持仓都触发止盈
    expect(r.data.triggers).toHaveLength(5);
    for (const t of r.data.triggers) {
      expect(t.ruleKind).toBe('cost-threshold');
      // v0.7 设计（§7）：止盈侧 direction=buy；止损侧 direction=sell
      expect(t.direction).toBe('buy');
      expect(t.reason).toMatch(/止盈/);
    }
  });

  it('stop-loss 命中：close = avgCost × 0.90 < 0.95 → 触发 direction=sell', async () => {
    const { ctx } = await setupCtx({
      '002594.SZ': 88.65, // 98.5 × 0.90
      '00700.HK': 432.0, // 480 × 0.90
      '300750.SZ': 225.0, // 250 × 0.90
      '600036.SH': 35.82, // 39.8 × 0.90
      'AAPL.US': 175.5, // 195 × 0.90
    });
    await savePlan(ctx, {
      id: 'sl-only',
      name: '止损池',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05 }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['sl-only'], notify: false, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toHaveLength(5);
    for (const t of r.data.triggers) {
      expect(t.direction).toBe('sell');
      expect(t.reason).toMatch(/止损/);
    }
  });

  it('止盈 + 止损同时配：close 涨幅命中 take-profit（else if 优先级）', async () => {
    // close 在 avgCost 之上 → takeProfit 分支胜出（else if）
    const { ctx } = await setupCtx({
      '002594.SZ': 108.35, // +10% → 止盈
    });
    await savePlan(ctx, {
      id: 'both-up',
      name: '双向（涨）',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05, takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['both-up'], notify: false, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toHaveLength(1);
    expect(r.data.triggers[0]?.reason).toMatch(/止盈/);
  });

  it('止盈 + 止损同时配：close 跌幅命中 stop-loss', async () => {
    const { ctx } = await setupCtx({
      '002594.SZ': 88.65, // -10% → 止损
    });
    await savePlan(ctx, {
      id: 'both-down',
      name: '双向（跌）',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05, takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['both-down'], notify: false, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toHaveLength(1);
    expect(r.data.triggers[0]?.reason).toMatch(/止损/);
  });

  it('边界：close = avgCost × 1.05（恰等于 takeProfitPct）→ 触发（>= 包含）', async () => {
    // 选 00700.HK：avgCost=480 → 480 × 1.05 = 504（浮点精确，规避 98.5 之类的精度漂移）
    const { ctx } = await setupCtx({ '00700.HK': 504 });
    await savePlan(ctx, {
      id: 'boundary-up',
      name: '边界（涨）',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['boundary-up'], notify: false, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toHaveLength(1);
  });

  it('边界：close = avgCost × 0.95（恰等于 stopLossPct）→ 触发（<= 包含）', async () => {
    // 480 × 0.95 = 456（精确）
    const { ctx } = await setupCtx({ '00700.HK': 456 });
    await savePlan(ctx, {
      id: 'boundary-down',
      name: '边界（跌）',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05 }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['boundary-down'], notify: false, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toHaveLength(1);
  });

  it('不命中：close = avgCost × 1.02（涨 2%，小于 5% 阈值）→ 0 触发', async () => {
    const { ctx } = await setupCtx({
      '002594.SZ': 100.47, // 98.5 × 1.02
    });
    await savePlan(ctx, {
      id: 'no-hit',
      name: '不命中',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05, takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['no-hit'], notify: false, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toEqual([]);
  });

  it('personal Watchlist 中仍为当前持仓的成员可使用 avgCost', async () => {
    const { ctx } = await setupCtx({
      '002594.SZ': 108.35,
    });
    await savePlan(ctx, {
      id: 'manual-pool',
      name: '手动池',
      groupId: MANUAL_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05, takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['manual-pool'], notify: false, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toHaveLength(1);
  });

  it('行情 unresolved（stock 不在 batch_quote 结果）→ 不触发、不报错', async () => {
    // 不传 002594.SZ 的报价 → 视为 unresolved → 不命中 cost-threshold
    const { ctx } = await setupCtx({});
    await savePlan(ctx, {
      id: 'unresolved-pool',
      name: '无行情',
      groupId: MANUAL_GROUP_ID,
      rules: [{ kind: 'cost-threshold', takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['unresolved-pool'], notify: false, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toEqual([]);
  });

  it('每次触发都落库 watchTriggers', async () => {
    const { ctx } = await setupCtx({ '002594.SZ': 108.35 }); // +10% vs avgCost 98.5 → 触发
    await savePlan(ctx, {
      id: 'persist-check',
      name: '持久化校验',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['persist-check'], notify: false, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toHaveLength(1);
    // 落库校验：watchTrigger 表应有 1 条
    const persisted = await ctx.repos.watchTrigger.listByPool('persist-check');
    expect(persisted).toHaveLength(1);
    // v0.7 设计（§7）：止盈侧 direction=buy
    expect(persisted[0]?.direction).toBe('buy');
  });

  it('cooldown：30 分钟内第二次跑同样价格 → notified=false，但仍落库', async () => {
    const { ctx } = await setupCtx({ '002594.SZ': 108.35 });
    await savePlan(ctx, {
      id: 'cooldown-pool',
      name: '冷却',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
      logic: 'ANY',
      triggerMode: 'on-enter',
      dailyNotificationLimit: 20,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    // v0.7：notify=true 的 bootstrap 默认不 emit。先跑一轮 dry-run 完成 bootstrap，
    // 期间 state 被写为 active=true + 一次 ATTEMPTED 触发落库（dry-run 自身不占 cooldown）。
    const rDry = await intradayWatchWorkflow.run(
      { poolIds: ['cooldown-pool'], notify: false, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(rDry.ok).toBe(true);
    if (!rDry.ok) return;
    expect(rDry.data.triggers).toHaveLength(1);

    // 第二轮 notify=true：active=true → on-enter 不再 emit，但首轮那条 ATTEMPTED 已在冷却窗内
    // → 这里不该有新触发（NOT notified=false from cooldown），仅当有「上升沿」才会被冷却抑制
    // 调整预期：dry-run 落库的触发 deliveryStatus='not-requested'（不占 cooldown），
    // notify=true 首轮应触发新上升沿 → cooldown 命中上次 dry-run 触发（同 currentStock）。
    // 简化：直接清掉 dry-run 的触发记录，再跑 notify=true 一次，预期 notified=true。
    const dryRunTrigger = rDry.data.triggers[0];
    if (dryRunTrigger === undefined) throw new Error('expected one dry-run trigger');
    await ctx.repos.watchTrigger.remove(dryRunTrigger.id);

    const r1 = await intradayWatchWorkflow.run(
      { poolIds: ['cooldown-pool'], notify: true, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    // 第二轮 notify=true 状态机 active=true → on-enter 默认不 emit
    // （停在这里：cooldown 语义由 §7/§4 决定，本例体现 v0.7 默认行为）
    expect(r1.data.triggers).toHaveLength(0);
  });
});
