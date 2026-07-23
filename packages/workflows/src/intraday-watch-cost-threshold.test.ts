import type { ToolContext } from '@luoome/core';
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

/** 构造带固定行情的 ctx，并把默认 holdings-watch 池替换为 cost-threshold-only 池。 */
const setupCtx = async (quotes: Record<string, number>) => {
  const ctx = await buildTestContext();
  const fixed = withFixedQuoteAdapter(ctx, quotes);
  // 清掉默认 holdings-watch（避免干扰），新建专用 cost-threshold 池
  await ctx.repos.stockPool.remove('holdings-watch');
  await ctx.repos.stockGroup.save({
    id: HOLDINGS_GROUP_ID,
    name: '持仓分组',
    resolver: { kind: 'holdings', accountId: TWO_HOLDINGS_ACCOUNT_ID },
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });
  await ctx.repos.stockGroup.save({
    id: MANUAL_GROUP_ID,
    name: '手动分组',
    resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
    refreshPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
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
    await ctx.repos.stockPool.save({
      id: 'tp-only',
      name: '止盈池',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
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
      expect(t.direction).toBe('sell');
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
    await ctx.repos.stockPool.save({
      id: 'sl-only',
      name: '止损池',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05 }],
      cooldownMinutes: 30,
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
    await ctx.repos.stockPool.save({
      id: 'both-up',
      name: '双向（涨）',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05, takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
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
    await ctx.repos.stockPool.save({
      id: 'both-down',
      name: '双向（跌）',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05, takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
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
    await ctx.repos.stockPool.save({
      id: 'boundary-up',
      name: '边界（涨）',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
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
    await ctx.repos.stockPool.save({
      id: 'boundary-down',
      name: '边界（跌）',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05 }],
      cooldownMinutes: 30,
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
    await ctx.repos.stockPool.save({
      id: 'no-hit',
      name: '不命中',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05, takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
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

  it('avgCost = 0 的持仓被跳过（避免除零）→ 0 触发', async () => {
    // 用 manual 池（avgCost 始终 undefined）模拟"无 avgCost"的场景
    const { ctx } = await setupCtx({
      '002594.SZ': 108.35, // 即便大涨也无 avgCost → 不触发
    });
    await ctx.repos.stockPool.save({
      id: 'manual-pool',
      name: '手动池',
      groupId: MANUAL_GROUP_ID,
      rules: [{ kind: 'cost-threshold', stopLossPct: 0.05, takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
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
    expect(r.data.triggers).toEqual([]);
  });

  it('行情 unresolved（stock 不在 batch_quote 结果）→ 不触发、不报错', async () => {
    // 不传 002594.SZ 的报价 → 视为 unresolved → 不命中 cost-threshold
    const { ctx } = await setupCtx({});
    await ctx.repos.stockPool.save({
      id: 'unresolved-pool',
      name: '无行情',
      groupId: MANUAL_GROUP_ID,
      rules: [{ kind: 'cost-threshold', takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
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
    await ctx.repos.stockPool.save({
      id: 'persist-check',
      name: '持久化校验',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
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
    expect(persisted[0]?.direction).toBe('sell');
  });

  it('cooldown：30 分钟内第二次跑同样价格 → notified=false，但仍落库', async () => {
    const { ctx } = await setupCtx({ '002594.SZ': 108.35 });
    await ctx.repos.stockPool.save({
      id: 'cooldown-pool',
      name: '冷却',
      groupId: HOLDINGS_GROUP_ID,
      rules: [{ kind: 'cost-threshold', takeProfitPct: 0.05 }],
      cooldownMinutes: 30,
      enabled: true,
      createdAt: T0,
      updatedAt: T0,
    });
    const r1 = await intradayWatchWorkflow.run(
      { poolIds: ['cooldown-pool'], notify: true, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.data.triggers[0]?.notified).toBe(true);

    const r2 = await intradayWatchWorkflow.run(
      { poolIds: ['cooldown-pool'], notify: true, seedTacticSources: false },
      ctx as unknown as ToolContext,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.data.triggers).toHaveLength(1);
    expect(r2.data.triggers[0]?.notified).toBe(false);
    expect(r2.data.suppressedByCooldown).toBe(1);

    // 两次都落库 → 2 条
    const all = await ctx.repos.watchTrigger.listByPool('cooldown-pool');
    expect(all).toHaveLength(2);
  });
});
