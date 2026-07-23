import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getWatchStatusTool } from './get-watch-status.js';
import { recordWatchRunTool } from './record-watch-run.js';

describe('get_watch_status', () => {
  it('从未运行时返回 never', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-23T02:00:00.000Z'),
    });
    const result = await getWatchStatusTool.execute({}, ctx);
    expect(result).toEqual({
      ok: true,
      data: { state: 'never', latest: null, staleAfterSeconds: 180 },
    });
  });

  it('成功心跳在窗口内 healthy，超过窗口 stale', async () => {
    let now = new Date('2026-07-23T02:00:00.000Z');
    const ctx = await buildTestContext({ clock: () => now });
    const recorded = await recordWatchRunTool.execute(
      {
        id: 'watch-run-1',
        mode: 'daemon',
        status: 'succeeded',
        startedAt: new Date('2026-07-23T01:59:50.000Z'),
        finishedAt: new Date('2026-07-23T01:59:55.000Z'),
        evaluatedPools: 1,
        evaluatedStocks: 6,
        triggered: 2,
        notified: 1,
        suppressedByCooldown: 1,
      },
      ctx,
    );
    expect(recorded.ok).toBe(true);

    const healthy = await getWatchStatusTool.execute({ expectedIntervalSeconds: 60 }, ctx);
    expect(healthy.ok).toBe(true);
    if (!healthy.ok) return;
    expect(healthy.data.state).toBe('healthy');
    expect(healthy.data.latest?.triggered).toBe(2);

    now = new Date('2026-07-23T02:04:00.000Z');
    const stale = await getWatchStatusTool.execute({ expectedIntervalSeconds: 60 }, ctx);
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.data.state).toBe('stale');
  });

  it('失败轮次返回 failed 并保留错误', async () => {
    const ctx = await buildTestContext({
      clock: () => new Date('2026-07-23T02:00:00.000Z'),
    });
    await recordWatchRunTool.execute(
      {
        id: 'watch-run-failed',
        mode: 'once',
        status: 'failed',
        startedAt: new Date('2026-07-23T01:59:50.000Z'),
        finishedAt: new Date('2026-07-23T01:59:51.000Z'),
        evaluatedPools: 0,
        evaluatedStocks: 0,
        triggered: 0,
        notified: 0,
        suppressedByCooldown: 0,
        error: 'adapter unavailable',
      },
      ctx,
    );

    const result = await getWatchStatusTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.state).toBe('failed');
    expect(result.data.latest?.error).toBe('adapter unavailable');
  });
});
