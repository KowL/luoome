import type { StockGroup, Tactic, ToolContext } from '@luoome/core';
import { buildMockContext } from '@luoome/tools';
import { beforeEach, describe, expect, it } from 'vitest';

import { intradayWatchWorkflow, resetDailyGroupRefreshFlagForTest } from './intraday-watch.js';

const T0 = new Date('2026-07-22T00:00:00.000Z');
/** 今日（Asia/Shanghai）= 2026-07-22（UTC 01:00 → Shanghai 09:00）。 */
const NOW = new Date('2026-07-22T01:00:00.000Z');
/** 昨日（Asia/Shanghai）= 2026-07-21。 */
const YESTERDAY = new Date('2026-07-21T01:00:00.000Z');

/** 恒触发 user 战法（mock 行情 quote.close=10 > 0，score 恒 80）。 */
const ALWAYS_TACTIC: Tactic = {
  id: 'always-trigger',
  name: '恒触发',
  tag: 'momentum',
  description: '测试用：quote.close > 0 恒触发',
  triggerWhen: 'quote.close > 0',
  scoreExpression: '80',
  direction: 'bullish',
  evidenceTemplate: ['恒触发'],
  source: 'user',
  definedAt: T0,
};

const seedGroup = (ctx: ToolContext, id: string, overrides: Partial<StockGroup> = {}) =>
  ctx.repos.stockGroup.save({
    id,
    name: id,
    resolver: { kind: 'formula', tacticId: 'always-trigger', lookbackDays: 5, minScore: 60 },
    refreshPolicy: 'daily',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });

describe('intraday-watch daily 刷新接线（docs/stock-group-design.md §7）', () => {
  beforeEach(() => {
    resetDailyGroupRefreshFlagForTest();
  });

  it('daily formula 组今日无快照 → watch 首轮前先跑 refresh-groups', async () => {
    const ctx = await buildMockContext({ clock: () => NOW });
    await ctx.repos.tactic.save(ALWAYS_TACTIC);
    await seedGroup(ctx, 'g-daily');

    const r = await intradayWatchWorkflow.run({ seedTacticSources: false, notify: false }, ctx);
    expect(r.ok).toBe(true);
    // watch 跑完后，daily 分组已有今日批次快照
    const current = await ctx.repos.groupMember.currentMembers('g-daily');
    expect(current.length).toBeGreaterThan(0);
  });

  it('今日已成功刷过 → watch 不再重复刷新', async () => {
    const ctx = await buildMockContext({ clock: () => NOW });
    await ctx.repos.tactic.save(ALWAYS_TACTIC);
    await seedGroup(ctx, 'g-daily');
    // 预置今日批次
    await ctx.repos.groupMember.saveBatch([
      {
        id: 's-1',
        groupId: 'g-daily',
        stockId: '002594.SZ',
        refreshId: 'rf-today',
        reason: 'today',
        createdAt: NOW,
      },
    ]);

    const r = await intradayWatchWorkflow.run({ seedTacticSources: false, notify: false }, ctx);
    expect(r.ok).toBe(true);
    // refreshId 未变 → 没有跑新一轮刷新
    expect(await ctx.repos.groupMember.latestRefreshId('g-daily')).toBe('rf-today');
  });

  it('昨日批次 → 今日首轮刷新一次；同进程第二轮不再刷', async () => {
    const ctx = await buildMockContext({ clock: () => NOW });
    await ctx.repos.tactic.save(ALWAYS_TACTIC);
    await seedGroup(ctx, 'g-daily');
    await ctx.repos.groupMember.saveBatch([
      {
        id: 's-1',
        groupId: 'g-daily',
        stockId: '002594.SZ',
        refreshId: 'rf-yesterday',
        reason: 'old',
        createdAt: YESTERDAY,
      },
    ]);

    const r1 = await intradayWatchWorkflow.run({ seedTacticSources: false, notify: false }, ctx);
    expect(r1.ok).toBe(true);
    const afterFirst = await ctx.repos.groupMember.latestRefreshId('g-daily');
    expect(afterFirst).not.toBe('rf-yesterday');

    // 同进程第二轮：内存 flag 已记，不再重复刷新
    const r2 = await intradayWatchWorkflow.run({ seedTacticSources: false, notify: false }, ctx);
    expect(r2.ok).toBe(true);
    expect(await ctx.repos.groupMember.latestRefreshId('g-daily')).toBe(afterFirst);
  });

  it('manual 组（非动态）不触发刷新；无分组时正常跑', async () => {
    const ctx = await buildMockContext({ clock: () => NOW });
    await seedGroup(ctx, 'g-manual', {
      resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
      refreshPolicy: 'daily',
    });
    const r = await intradayWatchWorkflow.run({ seedTacticSources: false, notify: false }, ctx);
    expect(r.ok).toBe(true);
    expect(await ctx.repos.groupMember.latestRefreshId('g-manual')).toBeNull();
  });
});
