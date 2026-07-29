import { createWatchlistTool, getWatchlistTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { syncPortfolioWatchlistsWorkflow } from './sync-portfolio-watchlists.js';

describe('sync-portfolio-watchlists workflow', () => {
  it('通过 tools 将账户 active holdings 完整同步到 portfolio Watchlist', async () => {
    const now = new Date('2026-07-29T02:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    const created = await createWatchlistTool.execute(
      {
        id: 'portfolio-main',
        name: '主账户持仓',
        kind: 'portfolio',
        membershipPolicy: 'synced',
      },
      ctx,
    );
    expect(created.ok).toBe(true);

    const result = await syncPortfolioWatchlistsWorkflow.run(
      { watchlistIds: ['portfolio-main'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ complete: 1, failed: 0 });
    expect(result.data.items[0]).toMatchObject({
      watchlistId: 'portfolio-main',
      status: 'complete',
      exited: 0,
    });
    expect(result.data.items[0]?.entered).toBeGreaterThan(0);

    const detail = await getWatchlistTool.execute({ watchlistId: 'portfolio-main' }, ctx);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.members).toHaveLength(result.data.items[0]?.entered ?? 0);
    expect(
      detail.data.members.flatMap((item) => item.sources.map((source) => source.sourceKey)),
    ).toEqual(detail.data.members.map(() => `portfolio:${ctx.user.defaultAccountId}`));
  });

  it('非 portfolio 目标记录失败但不阻塞其它目标', async () => {
    const ctx = await buildTestContext();
    await createWatchlistTool.execute(
      {
        id: 'personal-watch',
        name: '个人观察',
        kind: 'personal',
        membershipPolicy: 'manual',
      },
      ctx,
    );
    await createWatchlistTool.execute(
      {
        id: 'portfolio-watch',
        name: '持仓观察',
        kind: 'portfolio',
        membershipPolicy: 'synced',
      },
      ctx,
    );

    const result = await syncPortfolioWatchlistsWorkflow.run(
      { watchlistIds: ['personal-watch', 'portfolio-watch'] },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ complete: 1, failed: 1 });
    expect(result.data.items.map((item) => [item.watchlistId, item.status])).toEqual([
      ['personal-watch', 'failed'],
      ['portfolio-watch', 'complete'],
    ]);
  });
});
