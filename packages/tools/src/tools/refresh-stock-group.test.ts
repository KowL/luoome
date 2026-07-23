import type { LLMAdapterLike, StockGroup, Tactic, ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { refreshStockGroupTool } from './refresh-stock-group.js';

const T0 = new Date('2026-07-22T00:00:00.000Z');

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
    resolver: { kind: 'manual', stockIds: ['002594.SZ'] },
    refreshPolicy: 'daily',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });

describe('refresh_stock_group', () => {
  it('分组不存在 → not_found', async () => {
    const ctx = await buildTestContext();
    const r = await refreshStockGroupTool.execute({ groupId: 'missing' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('not_found');
  });

  it('manual / holdings 组 → invalid_input（无刷新动作）', async () => {
    const ctx = await buildTestContext();
    await seedGroup(ctx, 'g-manual');
    const r = await refreshStockGroupTool.execute({ groupId: 'g-manual' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('formula 组：run_tactic 命中 → 写新批次，entered=全部成员', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.tactic.save(ALWAYS_TACTIC);
    await seedGroup(ctx, 'g-f', {
      resolver: { kind: 'formula', tacticId: 'always-trigger', lookbackDays: 5, minScore: 60 },
    });
    const r = await refreshStockGroupTool.execute({ groupId: 'g-f' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.refreshed).toBe(true);
    expect(r.data.refreshId).not.toBeNull();
    expect(r.data.memberCount).toBeGreaterThan(0);
    expect(r.data.entered.length).toBe(r.data.memberCount);
    expect(r.data.exited).toEqual([]);

    const current = await ctx.repos.groupMember.currentMembers('g-f');
    expect(current.length).toBe(r.data.memberCount);
    expect(current[0]?.refreshId).toBe(r.data.refreshId);
    expect(current[0]?.reason).toContain('战法 always-trigger 命中');
  });

  it('formula 组：minScore 高于信号分 → 空结果不写空批（refreshed=false，保留旧快照）', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.tactic.save(ALWAYS_TACTIC);
    await seedGroup(ctx, 'g-f', {
      resolver: { kind: 'formula', tacticId: 'always-trigger', lookbackDays: 5, minScore: 90 },
    });
    await ctx.repos.groupMember.saveBatch([
      {
        id: 's-1',
        groupId: 'g-f',
        stockId: '002594.SZ',
        refreshId: 'rf-old',
        reason: 'old',
        createdAt: T0,
      },
    ]);
    const r = await refreshStockGroupTool.execute({ groupId: 'g-f' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.refreshed).toBe(false);
    expect(r.data.failureReason).toContain('空');
    // 旧快照原样保留
    expect(await ctx.repos.groupMember.latestRefreshId('g-f')).toBe('rf-old');
  });

  it('formula 组：第二次刷新成员集合变化 → entered / exited 正确', async () => {
    const ctx = await buildTestContext();
    await ctx.repos.tactic.save(ALWAYS_TACTIC);
    await seedGroup(ctx, 'g-f', {
      resolver: { kind: 'formula', tacticId: 'always-trigger', lookbackDays: 5, minScore: 60 },
    });
    // 旧批：一只必然不在 all-stocks 结果里的股票（不在 mock stocks 中）
    await ctx.repos.groupMember.saveBatch([
      {
        id: 's-1',
        groupId: 'g-f',
        stockId: '000001.SZ',
        refreshId: 'rf-old',
        reason: 'old',
        createdAt: T0,
      },
    ]);
    const r = await refreshStockGroupTool.execute({ groupId: 'g-f' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.refreshed).toBe(true);
    expect(r.data.exited).toEqual(['000001.SZ']);
    expect(r.data.entered.length).toBe(r.data.memberCount);
  });

  it('llm 组：mock LLM 产出 → 写新批次', async () => {
    const ctx = await buildTestContext();
    await seedGroup(ctx, 'g-l', {
      resolver: { kind: 'llm', prompt: '选出龙头', maxMembers: 3 },
    });
    const r = await refreshStockGroupTool.execute({ groupId: 'g-l' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.refreshed).toBe(true);
    expect(r.data.memberCount).toBeGreaterThan(0);
    expect(r.data.memberCount).toBeLessThanOrEqual(3);
  });

  it('llm 组：LLM 失败 → refreshed=false，保留旧快照', async () => {
    const ctx = await buildTestContext();
    await seedGroup(ctx, 'g-l', {
      resolver: { kind: 'llm', prompt: '选出龙头', maxMembers: 3 },
    });
    await ctx.repos.groupMember.saveBatch([
      {
        id: 's-1',
        groupId: 'g-l',
        stockId: '002594.SZ',
        refreshId: 'rf-old',
        reason: 'old',
        createdAt: T0,
      },
    ]);
    const failingLlm: LLMAdapterLike = {
      name: 'stub-llm',
      generate: () => Promise.reject(new Error('boom')),
    };
    const ctx2: ToolContext = { ...ctx, adapters: { ...ctx.adapters, llm: failingLlm } };
    const r = await refreshStockGroupTool.execute({ groupId: 'g-l' }, ctx2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.refreshed).toBe(false);
    expect(r.data.failureReason).toContain('resolve_llm_group');
    expect(await ctx.repos.groupMember.latestRefreshId('g-l')).toBe('rf-old');
  });
});
