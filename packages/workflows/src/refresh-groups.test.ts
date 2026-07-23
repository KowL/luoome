import type { LLMAdapterLike, StockGroup, Tactic, ToolContext } from '@luoome/core';
import { buildMockContext } from '@luoome/tools';
import { describe, expect, it } from 'vitest';

import { refreshGroupsWorkflow } from './refresh-groups.js';

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

const failingLlm: LLMAdapterLike = {
  name: 'stub-llm',
  generate: () => Promise.reject(new Error('boom')),
};

describe('refresh-groups workflow', () => {
  it('formula 组成功：写新批次，refreshed + entered 正确', async () => {
    const ctx = await buildMockContext();
    await ctx.repos.tactic.save(ALWAYS_TACTIC);
    await seedGroup(ctx, 'g-f', {
      resolver: { kind: 'formula', tacticId: 'always-trigger', lookbackDays: 5, minScore: 60 },
    });

    const r = await refreshGroupsWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.refreshed).toEqual(['g-f']);
    expect(r.data.failed).toEqual([]);
    expect(r.data.entered.length).toBeGreaterThan(0);
    expect(r.data.entered.every((e) => e.groupId === 'g-f')).toBe(true);
    expect(r.data.exited).toEqual([]);

    const current = await ctx.repos.groupMember.currentMembers('g-f');
    expect(current.length).toBe(r.data.entered.length);
  });

  it('manual / holdings 组不刷新；disabled 组不刷新', async () => {
    const ctx = await buildMockContext();
    await seedGroup(ctx, 'g-manual');
    await seedGroup(ctx, 'g-disabled', {
      resolver: { kind: 'llm', prompt: 'x', maxMembers: 5 },
      enabled: false,
    });
    const r = await refreshGroupsWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.refreshed).toEqual([]);
    expect(r.data.failed).toEqual([]);
  });

  it('llm 组失败：保留旧快照，计入 failed，绝不写空批', async () => {
    const ctx = await buildMockContext();
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
    const ctx2: ToolContext = { ...ctx, adapters: { ...ctx.adapters, llm: failingLlm } };
    const r = await refreshGroupsWorkflow.run({}, ctx2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.refreshed).toEqual([]);
    expect(r.data.failed).toHaveLength(1);
    expect(r.data.failed[0]?.groupId).toBe('g-l');
    // 旧快照原样保留
    expect(await ctx.repos.groupMember.latestRefreshId('g-l')).toBe('rf-old');
    expect((await ctx.repos.groupMember.currentMembers('g-l')).map((s) => s.stockId)).toEqual([
      '002594.SZ',
    ]);
  });

  it('成员变化检测：旧批退出 + 新批进入', async () => {
    const ctx = await buildMockContext();
    await ctx.repos.tactic.save(ALWAYS_TACTIC);
    await seedGroup(ctx, 'g-f', {
      resolver: { kind: 'formula', tacticId: 'always-trigger', lookbackDays: 5, minScore: 60 },
    });
    // 旧批成员：一只不在 mock stocks 里的股票（必然退出）+ 一只必然命中的（保留）
    await ctx.repos.groupMember.saveBatch([
      {
        id: 's-1',
        groupId: 'g-f',
        stockId: '000001.SZ',
        refreshId: 'rf-old',
        reason: 'old',
        createdAt: T0,
      },
      {
        id: 's-2',
        groupId: 'g-f',
        stockId: '002594.SZ',
        refreshId: 'rf-old',
        reason: 'old',
        createdAt: T0,
      },
    ]);
    const r = await refreshGroupsWorkflow.run({}, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.refreshed).toEqual(['g-f']);
    expect(r.data.exited).toEqual([{ groupId: 'g-f', stockId: '000001.SZ' }]);
    // 002594.SZ 保留（不在 entered）；entered 为其余命中股
    expect(r.data.entered.some((e) => e.stockId === '002594.SZ')).toBe(false);
    expect(r.data.entered.length).toBeGreaterThan(0);
  });

  it('groupIds 子集：只刷新指定分组', async () => {
    const ctx = await buildMockContext();
    await ctx.repos.tactic.save(ALWAYS_TACTIC);
    await seedGroup(ctx, 'g-a', {
      resolver: { kind: 'formula', tacticId: 'always-trigger', lookbackDays: 5, minScore: 60 },
    });
    await seedGroup(ctx, 'g-b', {
      resolver: { kind: 'formula', tacticId: 'always-trigger', lookbackDays: 5, minScore: 60 },
    });
    const r = await refreshGroupsWorkflow.run({ groupIds: ['g-a'] }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.refreshed).toEqual(['g-a']);
    expect(await ctx.repos.groupMember.latestRefreshId('g-b')).toBeNull();
  });
});
