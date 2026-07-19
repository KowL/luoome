import { describe, expect, it } from 'vitest';
import { buildMockContext } from '../context.js';
import { syncQuotesTool } from './sync-quotes.js';

describe('tool/sync_quotes', () => {
  it('正常路径：同步默认账户下所有持仓', async () => {
    const ctx = await buildMockContext();
    const res = await syncQuotesTool.execute({}, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // fixtures 默认账户有 6 个持仓（每个 stockId 唯一）
    expect(res.data.totalRequested).toBeGreaterThan(0);
    expect(res.data.synced.length).toBe(res.data.totalRequested);
  });

  it('正常路径：显式 accountId', async () => {
    const ctx = await buildMockContext();
    const accounts = await ctx.repos.account.list();
    const [first] = accounts;
    if (first === undefined) throw new Error('no account');
    const res = await syncQuotesTool.execute({ accountId: first.id }, ctx);
    expect(res.ok).toBe(true);
  });

  it('错误路径：accountId 不是 uuid → invalid_input', async () => {
    const ctx = await buildMockContext();
    const res = await syncQuotesTool.execute({ accountId: 'not-uuid' }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });
});
