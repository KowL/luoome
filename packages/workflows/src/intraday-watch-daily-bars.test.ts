import type { StockPool, ToolContext } from '@luoome/core';
import { money } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { withFixedQuoteAdapter } from '@luoome/tools/testing/fixed-quote-adapter';
import { describe, expect, it } from 'vitest';

import { intradayWatchWorkflow } from './intraday-watch.js';

/**
 * v0.6.1 dailyBars 接入测试（docs/ddd/strategy-watchlist-unification-detailed-design.md §6 step 5）。
 *
 * 行为契约：
 * - get_previous_closes 有昨日 close → prevClose = bar.close
 * - 缺失 / close <= 0 → price-change 为 unknown，不使用 quote.open
 *
 * 测试策略：
 * - 用 withFixedQuoteAdapter 把现价固定（close = open = high = low = 100）
 * - 通过 ctx.repos.dailyBar.saveMany 灌历史 bar
 * - price-change pct 设小一点（如 0.04 = 4%），让 5% 区间内能触发
 */

const T0 = new Date('2026-07-21T02:30:00.000Z'); // 2026-07-21 Shanghai 10:30
const T_YESTERDAY = new Date('2026-07-20T00:00:00.000Z'); // 上一交易日
const T_DAY_BEFORE = new Date('2026-07-19T00:00:00.000Z');

/**
 * 构造带固定行情 + price-change-only AlertPlan 的 ctx。
 *
 * 注：withFixedQuoteAdapter 返回的是新 ctx（不修改原 ctx）；这里把 fixed ctx
 * 返回给 caller，且 AlertPlan 保存走 fixed.ctx（防 buildTestContext 的 seedMockData
 * 把 plan 覆盖）。fixed.adapters.market 才是 FixedQuoteAdapter，workflow 调
 * batch_quote tool 会走这条路径。
 */
const savePlan = async (ctx: ToolContext, pool: StockPool): Promise<void> => {
  await ctx.repos.alertPlan.save({
    id: pool.id,
    name: pool.name,
    watchlistId: pool.groupId,
    rules: pool.rules.map((rule, index) => ({
      ...rule,
      id: rule.id ?? `rule-${index + 1}`,
    })) as never,
    logic: pool.logic,
    triggerMode: pool.triggerMode,
    cooldownMinutes: pool.cooldownMinutes,
    dailyNotificationLimit: pool.dailyNotificationLimit,
    notifyOnRecovery: pool.notifyOnRecovery,
    enabled: pool.enabled,
    createdAt: pool.createdAt,
    updatedAt: pool.updatedAt,
  });
};

const setupCtx = async (quotes: Record<string, number>) => {
  const ctx = await buildTestContext({ clock: () => T0 });
  const fixed = withFixedQuoteAdapter(ctx, quotes);
  await fixed.repos.watchlist.save({
    id: 'p-change-group',
    name: 'price-change',
    kind: 'personal',
    membershipPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });
  await fixed.repos.watchlistMember.saveMember({
    id: 'p-change-group:600519.SH',
    watchlistId: 'p-change-group',
    stockId: '600519.SH',
    stage: 'watching',
    priority: 'normal',
    firstAddedAt: T0,
    lastActivityAt: T0,
  });
  await savePlan(fixed, {
    id: 'p-change',
    name: 'price-change',
    groupId: 'p-change-group',
    rules: [{ kind: 'price-change', pct: 0.04, direction: 'any' }],
    cooldownMinutes: 30,
    logic: 'ANY',
    triggerMode: 'on-enter',
    dailyNotificationLimit: 20,
    notifyOnRecovery: false,
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });
  return fixed as ToolContext;
};

describe('intraday-watch dailyBars 接入（v0.6.1）', () => {
  it('dailyBars 有昨收 ≠ 现价：price-change 用 dailyBars.close 计算 change', async () => {
    // 现价固定 = 100；dailBar 昨收 = 95 → change = (100-95)/95 = 5.26%
    // 阈值 4% → 触发
    const ctx = await setupCtx({ '600519.SH': 100 });
    await ctx.repos.dailyBar.saveMany([
      {
        stockId: '600519.SH',
        date: T_YESTERDAY,
        open: money(95),
        high: money(95),
        low: money(95),
        close: money(95),
        volume: 1_000_000,
        adjustment: 'qfq',
        source: 'intraday-test',
      },
    ]);
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['p-change'], notify: false, seedTacticSources: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toHaveLength(1);
    expect(r.data.triggers[0]?.quoteClose).toBe(100);
    // prevCloses 字段是 workflow 内部 Map，不暴露给客户端；
    // intraday-watch.output 不暴露 evidence 也不暴露 prevCloses，所以这里只验证 trigger 数量 + 实际取的现价。
  });

  it('dailyBars 缺失：price-change 为 unknown，不使用 quote.open', async () => {
    const ctx = await setupCtx({ '600519.SH': 100 });
    // 不 seed dailyBars
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['p-change'], notify: false, seedTacticSources: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toEqual([]);
  });

  it('dailyBars 两条 → latestBefore(., now, 1) 取最新一根', async () => {
    // seed day-before=90, yesterday=95；latestBefore(., now, 1) 应取 95（非 90）
    const ctx = await setupCtx({ '600519.SH': 100 });
    await ctx.repos.dailyBar.saveMany([
      {
        stockId: '600519.SH',
        date: T_DAY_BEFORE,
        open: money(90),
        high: money(90),
        low: money(90),
        close: money(90),
        volume: 1_000_000,
        adjustment: 'qfq',
        source: 'intraday-test',
      },
      {
        stockId: '600519.SH',
        date: T_YESTERDAY,
        open: money(95),
        high: money(95),
        low: money(95),
        close: money(95),
        volume: 1_000_000,
        adjustment: 'qfq',
        source: 'intraday-test',
      },
    ]);
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['p-change'], notify: false, seedTacticSources: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // latest 取 95，change = 5.26% > 4% → 触发
    expect(r.data.triggers).toHaveLength(1);
  });

  it('dailyBars close = 0（异常数据）→ price-change 为 unknown', async () => {
    const ctx = await setupCtx({ '600519.SH': 100 });
    await ctx.repos.dailyBar.saveMany([
      {
        stockId: '600519.SH',
        date: T_YESTERDAY,
        open: money(0),
        high: money(0),
        low: money(0),
        close: money(0), // 异常：bar.close <= 0
        volume: 0,
        adjustment: 'qfq',
        source: 'intraday-test',
      },
    ]);
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['p-change'], notify: false, seedTacticSources: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toEqual([]);
  });

  it('price-change 阈值 6%：dailyBars 昨收=95 现价=100（5.26%）→ 不触发（验证 threshold 精度）', async () => {
    const ctx = await setupCtx({ '600519.SH': 100 });
    await ctx.repos.dailyBar.saveMany([
      {
        stockId: '600519.SH',
        date: T_YESTERDAY,
        open: money(95),
        high: money(95),
        low: money(95),
        close: money(95),
        volume: 1_000_000,
        adjustment: 'qfq',
        source: 'intraday-test',
      },
    ]);
    // 把阈值改严到 6%（> 5.26%）— AlertPlanRepository.save 是 upsert，同 id 覆盖
    await savePlan(ctx, {
      id: 'p-change',
      name: 'price-change',
      groupId: 'p-change-group',
      rules: [{ kind: 'price-change', pct: 0.06, direction: 'any' }],
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
      { poolIds: ['p-change'], notify: false, seedTacticSources: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toEqual([]);
  });

  it('横盘：dailBar 昨收 = 现价 → 0 触发（边界）', async () => {
    const ctx = await setupCtx({ '600519.SH': 100 });
    await ctx.repos.dailyBar.saveMany([
      {
        stockId: '600519.SH',
        date: T_YESTERDAY,
        open: money(100),
        high: money(100),
        low: money(100),
        close: money(100),
        volume: 1_000_000,
        adjustment: 'qfq',
        source: 'intraday-test',
      },
    ]);
    const r = await intradayWatchWorkflow.run(
      { poolIds: ['p-change'], notify: false, seedTacticSources: false },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.triggers).toEqual([]);
  });
});
