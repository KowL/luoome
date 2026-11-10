import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getWatchStatusTool } from './get-watch-status.js';

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
    await ctx.repos.workflowRun.save({
      id: 'watch-run-1',
      workflowName: 'intraday-watch',
      mode: 'daemon',
      status: 'succeeded',
      startedAt: new Date('2026-07-23T01:59:50.000Z'),
      finishedAt: new Date('2026-07-23T01:59:55.000Z'),
      inputSummary: { notify: true },
      outputSummary: { triggered: 2, notifyFailed: 0 },
      providerStatuses: [],
    });

    const healthy = await getWatchStatusTool.execute({ expectedIntervalSeconds: 60 }, ctx);
    expect(healthy.ok).toBe(true);
    if (!healthy.ok) return;
    expect(healthy.data.state).toBe('healthy');
    expect(healthy.data.latest?.outputSummary?.triggered).toBe(2);

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
    await ctx.repos.workflowRun.save({
      id: 'watch-run-failed',
      workflowName: 'intraday-watch',
      mode: 'manual',
      status: 'failed',
      startedAt: new Date('2026-07-23T01:59:50.000Z'),
      finishedAt: new Date('2026-07-23T01:59:51.000Z'),
      inputSummary: { notify: true },
      outputSummary: { triggered: 0, notifyFailed: 0 },
      providerStatuses: [],
      error: 'adapter unavailable',
    });

    const result = await getWatchStatusTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.state).toBe('failed');
    expect(result.data.latest?.error).toBe('adapter unavailable');
  });
});
