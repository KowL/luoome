import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { syncQuotesWorkflow } from './sync-quotes.js';

describe('workflow/sync-quotes', () => {
  it('正常路径：返回 syncedCount + totalRequested + syncedAt', async () => {
    const ctx = await buildTestContext();
    const res = await syncQuotesWorkflow.run({}, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.totalRequested).toBeGreaterThan(0);
    expect(res.data.syncedCount).toBe(res.data.totalRequested);
    expect(() => new Date(res.data.syncedAt).toISOString()).not.toThrow();
  });

  it('正常路径：accountId 显式传', async () => {
    const ctx = await buildTestContext();
    const accounts = await ctx.repos.account.list();
    const [first] = accounts;
    if (first === undefined) throw new Error('no account');
    const res = await syncQuotesWorkflow.run({ accountId: first.id }, ctx);
    expect(res.ok).toBe(true);
  });

  it('使用 workflow context clock 生成审计时间，而不是读取系统时间', async () => {
    const clock = () => new Date('2026-07-28T09:10:11.000Z');
    const ctx = await buildTestContext({ clock });
    const res = await syncQuotesWorkflow.run({}, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.syncedAt).toBe(clock().toISOString());
  });

  it('错误路径：accountId 不是 uuid → invalid_input', async () => {
    const ctx = await buildTestContext();
    const res = await syncQuotesWorkflow.run({ accountId: 'not-uuid' }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });
});
