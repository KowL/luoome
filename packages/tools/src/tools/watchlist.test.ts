import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import {
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
  it('创建 personal Watchlist 后可添加、更新和查询 manual member', async () => {
    const ctx = await buildTestContext({ clock: () => T0 });
    const created = await createWatchlistTool.execute(
      {
        id: 'quality-watch',
        name: '质量观察',
        kind: 'personal',
        membershipPolicy: 'mixed',
      },
      ctx,
    );
    expect(created.ok).toBe(true);

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
        priority: 'important',
      },
      ctx,
    );
    expect(updated.ok).toBe(true);

    const detail = await getWatchlistTool.execute({ watchlistId: 'quality-watch' }, ctx);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.members[0]?.member).toMatchObject({
      stockId: '600519.SH',
      priority: 'important',
    });

    const listed = await listWatchlistsTool.execute({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.items).toMatchObject([
      { watchlist: { id: 'quality-watch' }, memberCount: 1, sourceHealth: { active: 1 } },
    ]);
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
        sourceKind: 'strategy',
        sourceKey: 'strategy:quality',
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
        sourceKind: 'strategy',
        sourceKey: 'strategy:quality',
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

  it('归档 manual source 后删除无其它来源的 member 关系', async () => {
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
    expect(result.data.member).toMatchObject({
      watchlistId: 'manual-watch',
      stockId: '600519.SH',
    });
    expect(result.data.sources[0]?.status).toBe('ended');
    expect(await ctx.repos.watchlistMember.findMember('manual-watch', '600519.SH')).toBeNull();
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
        sourceKind: 'strategy',
        sourceKey: 'strategy:failed',
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
