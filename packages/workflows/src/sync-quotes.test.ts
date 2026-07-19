import { buildMockContext } from '@luoome/tools';
import { describe, expect, it } from 'vitest';

import { syncQuotesWorkflow } from './sync-quotes.js';

describe('workflow/sync-quotes', () => {
  it('正常路径：返回 syncedCount + totalRequested + syncedAt', async () => {
    const ctx = await buildMockContext();
    const res = await syncQuotesWorkflow.run({}, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.totalRequested).toBeGreaterThan(0);
    expect(res.data.syncedCount).toBe(res.data.totalRequested);
    expect(() => new Date(res.data.syncedAt).toISOString()).not.toThrow();
  });

  it('正常路径：accountId 显式传', async () => {
    const ctx = await buildMockContext();
    const accounts = await ctx.repos.account.list();
    const [first] = accounts;
    if (first === undefined) throw new Error('no account');
    const res = await syncQuotesWorkflow.run({ accountId: first.id }, ctx);
    expect(res.ok).toBe(true);
  });

  it('错误路径：accountId 不是 uuid → invalid_input', async () => {
    const ctx = await buildMockContext();
    const res = await syncQuotesWorkflow.run({ accountId: 'not-uuid' }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });
});
