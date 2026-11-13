import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { reportWorkflow } from './report.js';
import { strategyWorkflow } from './strategy.js';
import { syncMarketWorkflow } from './sync-market.js';

describe('workflow facades', () => {
  it('report 只接受 opening/closing/weekly/daily-review', () => {
    expect(reportWorkflow.inputSchema.safeParse({ kind: 'opening' }).success).toBe(true);
    expect(reportWorkflow.inputSchema.safeParse({ kind: 'closing' }).success).toBe(true);
    expect(reportWorkflow.inputSchema.safeParse({ kind: 'weekly' }).success).toBe(true);
    expect(reportWorkflow.inputSchema.safeParse({ kind: 'daily-review' }).success).toBe(true);
    expect(reportWorkflow.inputSchema.safeParse({ kind: 'unknown' }).success).toBe(false);
  });

  it('strategy 只接受 run/scheduled/daily/observations', () => {
    expect(strategyWorkflow.inputSchema.safeParse({ job: 'run' }).success).toBe(true);
    expect(strategyWorkflow.inputSchema.safeParse({ job: 'scheduled' }).success).toBe(true);
    expect(strategyWorkflow.inputSchema.safeParse({ job: 'unknown' }).success).toBe(false);
  });

  it('sync-market 未配置 dump 适配器时显式失败，不回退其它目标', async () => {
    const ctx = await buildTestContext();
    const result = await syncMarketWorkflow.run({ target: 'dump' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('report 分发到 daily-review 管线并返回其输出', async () => {
    const ctx = await buildTestContext();
    const result = await reportWorkflow.run({ kind: 'daily-review' }, ctx);
    expect(result.ok).toBe(true);
  });
});
