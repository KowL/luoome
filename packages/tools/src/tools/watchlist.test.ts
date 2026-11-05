import { type StrategyDslV1, strategyDefinitionHash } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import {
  addWatchlistMembersTool,
  addWatchlistMemberTool,
  archiveWatchlistMemberTool,
  createWatchlistTool,
  getWatchlistTool,
  listWatchlistChangesTool,
  listWatchlistsTool,
  syncWatchlistSourceTool,
  updateWatchlistMemberTool,
} from './watchlist.js';

const T0 = new Date('2026-07-29T01:00:00.000Z');

describe('Watchlist tools', () => {
  it('省略类型与维护方式时创建 personal/mixed Watchlist，并可维护 manual member', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    const created = await createWatchlistTool.execute(
      { id: 'quality-watch', name: '质量观察' },
      ctx,
    );
    expect(created).toMatchObject({
      ok: true,
      data: { watchlist: { kind: 'personal', membershipPolicy: 'mixed', enabled: true } },
    });
    expect(await ctx.repos.watchlist.findById('quality-watch')).toMatchObject({
      kind: 'personal',
      membershipPolicy: 'mixed',
    });

    const added = await addWatchlistMemberTool.execute(
      { watchlistId: 'quality-watch', stockId: '600519.SH', reason: '用户关注' },
      ctx,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.data.sources).toMatchObject([
      { kind: 'manual', sourceKey: `manual:${added.data.member.id}`, status: 'active' },
    ]);

    const updated = await updateWatchlistMemberTool.execute(
      {
        watchlistId: 'quality-watch',
        stockId: '600519.SH',
        stage: 'researching',
        priority: 'important',
      },
      ctx,
    );
    expect(updated.ok).toBe(true);

    const detail = await getWatchlistTool.execute({ watchlistId: 'quality-watch' }, ctx);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.members[0]?.stockName).toBe(
      (await ctx.repos.stock.findById('600519.SH'))?.name,
    );
    expect(detail.data.members[0]?.member).toMatchObject({
      stockId: '600519.SH',
      stage: 'researching',
      priority: 'important',
    });

    const listed = await listWatchlistsTool.execute({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.items).toMatchObject([
      { watchlist: { id: 'quality-watch' }, memberCount: 1, sourceHealth: { active: 1 } },
    ]);
  });

  it.each([
    { input: { membershipPolicy: 'manual' }, kind: 'personal', membershipPolicy: 'manual' },
    { input: { kind: 'strategy' }, kind: 'strategy', membershipPolicy: 'mixed' },
  ])('仅补齐省略字段，保留显式配置 $input', async ({ input, kind, membershipPolicy }) => {
    const ctx = await buildTestContext({ clock: () => T0 });
    expect(
      await createWatchlistTool.execute({ id: 'explicit-watch', name: '显式配置', ...input }, ctx),
    ).toMatchObject({ ok: true, data: { watchlist: { kind, membershipPolicy } } });
  });

  it.each([
    { kind: 'portfolio', membershipPolicy: 'manual', errorKind: 'invariant_violation' },
    { kind: 'portfolio', membershipPolicy: 'mixed', errorKind: 'invariant_violation' },
    { kind: 'portfolio', errorKind: 'invariant_violation' },
    { kind: 'system', membershipPolicy: 'synced', errorKind: 'invalid_input' },
  ])('默认值不放宽显式类型约束 $kind/$membershipPolicy', async ({ errorKind, ...input }) => {
    const ctx = await buildTestContext({ clock: () => T0 });
    expect(
      await createWatchlistTool.execute({ id: 'invalid-watch', name: '无效组合', ...input }, ctx),
    ).toMatchObject({ ok: false, error: { kind: errorKind } });
    expect(await ctx.repos.watchlist.findById('invalid-watch')).toBeNull();
  });

  it('synced Watchlist 拒绝手工添加成员', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await createWatchlistTool.execute(
      {
        id: 'portfolio-watch',
        name: '持仓观察',
        kind: 'portfolio',
        membershipPolicy: 'synced',
      },
      ctx,
    );
    const result = await addWatchlistMemberTool.execute(
      { watchlistId: 'portfolio-watch', stockId: '600519.SH' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('批量添加成员只写一次并支持纯代码解析', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await createWatchlistTool.execute(
      { id: 'batch-watch', name: '批量', kind: 'personal', membershipPolicy: 'manual' },
      ctx,
    );
    const result = await addWatchlistMembersTool.execute(
      {
        watchlistId: 'batch-watch',
        members: [
          { stockId: '600519', reason: '白酒' },
          { stockId: '002594.SZ', reason: '新能源', priority: 'important' },
        ],
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(2);
    expect(result.data.members.map((row) => row.member.stockId)).toEqual([
      '600519.SH',
      '002594.SZ',
    ]);
  });

  it('批量添加任一成员无效时整批不落库', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await createWatchlistTool.execute(
      { id: 'atomic-watch', name: '原子', kind: 'personal', membershipPolicy: 'manual' },
      ctx,
    );
    const result = await addWatchlistMembersTool.execute(
      {
        watchlistId: 'atomic-watch',
        members: [{ stockId: '600519.SH' }, { stockId: 'NOT-FOUND' }],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(await ctx.repos.watchlistMember.listMembers('atomic-watch')).toEqual([]);
  });

  it('complete 会退出缺失成员；partial 只标 stale，changes 保留快照', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await createWatchlistTool.execute(
      {
        id: 'strategy-watch',
        name: '策略观察',
        kind: 'strategy',
        membershipPolicy: 'synced',
      },
      ctx,
    );
    const first = await syncWatchlistSourceTool.execute(
      {
        watchlistId: 'strategy-watch',
        sourceKind: 'ai',
        sourceKey: 'ai:quality',
        status: 'complete',
        candidates: [
          { stockId: '600519.SH', reason: '入选', evidence: ['质量得分'] },
          { stockId: '002594.SZ', reason: '入选', evidence: ['成长得分'] },
        ],
      },
      ctx,
    );
    expect(first.ok).toBe(true);

    const partial = await syncWatchlistSourceTool.execute(
      {
        watchlistId: 'strategy-watch',
        sourceKind: 'ai',
        sourceKey: 'ai:quality',
        status: 'partial',
        candidates: [{ stockId: '600519.SH', reason: '已确认', evidence: [] }],
        missingDimensions: [{ dimension: 'daily-bars', reason: '部分行情缺失', retryable: true }],
      },
      { ...ctx, clock: () => new Date(T0.getTime() + 1000) },
    );
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.data.run.exitedCount).toBe(0);
    expect(
      (await ctx.repos.watchlistMember.listMembers('strategy-watch')).map(
        (member) => member.stockId,
      ),
    ).toEqual(['002594.SZ', '600519.SH']);

    const changes = await listWatchlistChangesTool.execute({ watchlistId: 'strategy-watch' }, ctx);
    expect(changes.ok).toBe(true);
    if (!changes.ok) return;
    expect(changes.data.runs).toHaveLength(2);
    expect(changes.data.runs[0]?.run.status).toBe('partial');
  });

  it('归档 manual source 后归档无其它来源的 member', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await createWatchlistTool.execute(
      { id: 'manual-watch', name: '手工', kind: 'personal', membershipPolicy: 'manual' },
      ctx,
    );
    await addWatchlistMemberTool.execute(
      { watchlistId: 'manual-watch', stockId: '600519.SH' },
      ctx,
    );
    const result = await archiveWatchlistMemberTool.execute(
      { watchlistId: 'manual-watch', stockId: '600519.SH' },
      { ...ctx, clock: () => new Date(T0.getTime() + 1000) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.member.stage).toBe('archived');
    expect(result.data.sources[0]?.status).toBe('ended');
  });

  it('策略同步只接受完整入选集合，不接受缺漏或混入未入选股票', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    const definition: StrategyDslV1 = {
      schemaVersion: 1,
      metadata: {},
      universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
      selection: {
        logic: 'all',
        rules: [{ id: 'rule-1', name: '测试规则', when: 'quote.close > 0', evidence: ['事实'] }],
      },
      signals: { entry: [], exit: [], risk: [] },
    };
    await ctx.repos.strategy.create({
      id: 'selected-strategy',
      name: '入选集合',
      description: '校验同步候选',
      owner: 'user',
      status: 'active',
      currentVersionId: 'selected-version',
      createdAt: T0,
      updatedAt: T0,
    });
    await ctx.repos.strategy.createVersion({
      id: 'selected-version',
      strategyId: 'selected-strategy',
      version: 1,
      definition,
      definitionHash: strategyDefinitionHash(definition),
      validationStatus: 'valid',
      validationErrors: [],
      publishedAt: T0,
      createdAt: T0,
    });
    await ctx.repos.strategyRun.commitRun({
      run: {
        id: 'selected-run',
        strategyId: 'selected-strategy',
        strategyVersionId: 'selected-version',
        mode: 'scan',
        scope: 'operational',
        coverage: 'CN_A_SHARES_SH_SZ',
        dataAsOf: T0,
        startedAt: T0,
        finishedAt: T0,
        status: 'complete',
        inputSnapshot: {},
        providerStatuses: [],
        summary: { selected: 1 },
        publication: { status: 'published', reasons: [], decidedAt: T0 },
      },
      results: [
        { stockId: '600519.SH', selected: true },
        { stockId: '002594.SZ', selected: false },
      ].map((result) => ({
        ...result,
        runId: 'selected-run',
        ruleEvaluations: [],
        evidence: [],
        dataAsOf: T0,
      })),
      signals: [],
    });
    await createWatchlistTool.execute({ id: 'selected-watch', name: '只同步入选' }, ctx);
    const sync = (stockIds: string[]) =>
      syncWatchlistSourceTool.execute(
        {
          watchlistId: 'selected-watch',
          sourceKind: 'strategy',
          sourceKey: 'strategy:selected-strategy',
          sourceId: 'selected-strategy',
          sourceVersionId: 'selected-version',
          producerRunId: 'selected-run',
          status: 'complete',
          candidates: stockIds.map((stockId) => ({ stockId, reason: '入选', evidence: [] })),
        },
        ctx,
      );
    for (const candidates of [[], ['002594.SZ'], ['600519.SH', '002594.SZ']]) {
      expect(await sync(candidates)).toMatchObject({
        ok: false,
        error: { kind: 'invalid_input', message: expect.stringContaining('selected') },
      });
      expect(await ctx.repos.watchlistMember.listMembers('selected-watch')).toEqual([]);
      expect(await ctx.repos.watchlistMember.listSyncRuns('selected-watch')).toEqual([]);
    }
    expect(await sync(['600519.SH'])).toMatchObject({
      ok: true,
      data: { run: { status: 'complete', enteredCount: 1 } },
    });
    expect(await ctx.repos.watchlistMember.listMembers('selected-watch')).toMatchObject([
      { stockId: '600519.SH' },
    ]);
  });

  it('failed 同步不能携带候选，避免把失败结果写成 active source', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await createWatchlistTool.execute(
      {
        id: 'failed-watch',
        name: '失败同步',
        kind: 'strategy',
        membershipPolicy: 'synced',
      },
      ctx,
    );
    const result = await syncWatchlistSourceTool.execute(
      {
        watchlistId: 'failed-watch',
        sourceKind: 'ai',
        sourceKey: 'ai:failed',
        status: 'failed',
        error: 'provider unavailable',
        candidates: [{ stockId: '600519.SH', reason: '不应写入', evidence: [] }],
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });
});

describe('Watchlist 账户范围', () => {
  it('隐藏其它账户的 portfolio 来源，同时保留多来源中的手动关注', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    await createWatchlistTool.execute(
      { id: 'scoped-watch', name: '来源隔离', kind: 'personal', membershipPolicy: 'mixed' },
      ctx,
    );
    const synced = await syncWatchlistSourceTool.execute(
      {
        watchlistId: 'scoped-watch',
        sourceKind: 'portfolio',
        sourceKey: 'portfolio:other',
        sourceId: 'other',
        status: 'complete',
        candidates: [
          { stockId: '600519.SH', reason: '其它账户持仓', evidence: [] },
          { stockId: '002594.SZ', reason: '其它账户持仓', evidence: [] },
        ],
      },
      ctx,
    );
    expect(synced.ok).toBe(true);
    await addWatchlistMemberTool.execute(
      { watchlistId: 'scoped-watch', stockId: '002594.SZ', reason: '独立手动关注' },
      ctx,
    );
    const scoped = await getWatchlistTool.execute(
      { watchlistId: 'scoped-watch', accountId: 'current' },
      ctx,
    );
    expect(scoped.ok).toBe(true);
    if (!scoped.ok) return;
    expect(scoped.data.members.map(({ member }) => member.stockId)).toEqual(['002594.SZ']);
    expect(scoped.data.members[0]?.sources.map((source) => source.kind)).toEqual(['manual']);
    const owner = await getWatchlistTool.execute(
      { watchlistId: 'scoped-watch', accountId: 'other' },
      ctx,
    );
    expect(owner.ok).toBe(true);
    if (!owner.ok) return;
    expect(owner.data.members).toHaveLength(2);
    const unscoped = await getWatchlistTool.execute({ watchlistId: 'scoped-watch' }, ctx);
    expect(unscoped.ok && unscoped.data.members.length).toBe(2);
  });
});
