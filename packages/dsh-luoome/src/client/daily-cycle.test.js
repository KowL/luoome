import { describe, expect, it } from 'vitest';
import { dailyCycleAvailable, dailyCycleResult } from './daily-cycle.js';

describe('daily cycle operation presentation', () => {
  it('requires an account and the exact batch policy', () => {
    expect(dailyCycleAvailable(null)).toBe(false);
    expect(dailyCycleAvailable({ accountId: 'a', policies: [] })).toBe(false);
    expect(
      dailyCycleAvailable({
        accountId: 'a',
        policies: [{ name: 'run_strategy_daily_cycle' }],
      }),
    ).toBe(true);
  });

  it('distinguishes operation success from partial and failed business outcomes', () => {
    const operation = (outcome) => ({
      state: 'succeeded',
      result: {
        ok: true,
        data: {
          outcome,
          reason: '策略日循环已执行',
          summary: { complete: 2, partial: 1, skipped: 0, failed: outcome === 'failed' ? 3 : 0 },
        },
      },
    });
    expect(dailyCycleResult(operation('due'))).toMatchObject({ tone: 'ok' });
    expect(dailyCycleResult(operation('partial'))).toMatchObject({
      tone: 'warn',
      text: '日循环部分完成：完成 2 · 部分 1 · 跳过 0 · 失败 0',
    });
    expect(dailyCycleResult(operation('failed')).tone).toBe('bad');
    expect(dailyCycleResult(operation('skipped')).tone).toBe('warn');
  });

  it('keeps unknown and executing states explicit instead of offering success', () => {
    expect(dailyCycleResult({ state: 'unknown' })).toMatchObject({
      tone: 'warn',
      text: '日循环结果待核对，请勿重复执行。',
    });
    expect(dailyCycleResult({ state: 'executing' }).tone).toBe('warn');
  });
});
