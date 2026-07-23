import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { runIntradayWatchObserved } from './intraday-watch.js';

describe('runIntradayWatchObserved', () => {
  it('零触发的成功轮次也写入 WatchRun 心跳', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-23T02:00:00.000Z'),
    });

    const result = await runIntradayWatchObserved(
      { notify: false, seedTacticSources: false },
      ctx,
      'once',
    );

    expect(result.ok).toBe(true);
    const latest = await ctx.repos.watchRun.latest();
    expect(latest).toMatchObject({
      mode: 'once',
      status: 'succeeded',
      evaluatedPools: 0,
      evaluatedStocks: 0,
      triggered: 0,
      notified: 0,
      suppressedByCooldown: 0,
    });
    expect(latest?.finishedAt).not.toBeNull();
  });

  it('workflow 输入失败也写入 failed 轮次', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-23T02:00:00.000Z'),
    });
    const result = await runIntradayWatchObserved({ poolIds: [''], notify: false }, ctx, 'once');

    expect(result.ok).toBe(false);
    const latest = await ctx.repos.watchRun.latest();
    expect(latest?.status).toBe('failed');
    expect(latest?.error).toContain('invalid_input');
  });
});
