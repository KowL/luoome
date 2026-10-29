import { TEST_ACCOUNT } from '@luoome/adapters/testing';
import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { syncQuotesTool } from './sync-quotes.js';

describe('tool/sync_quotes', () => {
  it('正常路径：同步默认账户下所有持仓', async () => {
    const ctx = await buildTestContext();
    const res = await syncQuotesTool.execute({}, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // fixtures 默认账户有 6 个持仓（每个 stockId 唯一）
    expect(res.data.totalRequested).toBeGreaterThan(0);
    expect(res.data.synced.length).toBe(res.data.totalRequested);
  });

  it('正常路径：显式 accountId', async () => {
    const ctx = await buildTestContext();
    const accounts = await ctx.repos.account.list();
    const [first] = accounts;
    if (first === undefined) throw new Error('no account');
    const res = await syncQuotesTool.execute({ accountId: first.id }, ctx);
    expect(res.ok).toBe(true);
  });

  it('正常路径：非 UUID 账户键（如 default-account）不被 schema 拒绝', async () => {
    const ctx = await buildTestContext();
    const res = await syncQuotesTool.execute({ accountId: 'default-account' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.totalRequested).toBe(0);
  });

  it('正常路径：非 UUID 账户键持有持仓时照常同步', async () => {
    const ctx = await buildTestContext();
    const [holding] = await ctx.repos.holding.listByAccount(TEST_ACCOUNT.id);
    if (holding === undefined) throw new Error('no holding');
    await ctx.repos.account.save({
      id: 'default-account',
      name: '默认投资账户',
      kind: 'real',
      currency: 'CNY',
      initialCapital: money(0),
      cashBalance: money(0),
      createdAt: new Date('2026-01-05T01:00:00.000Z'),
    });
    await ctx.repos.holding.save({
      ...holding,
      id: 'holding-default-account',
      accountId: 'default-account',
    });
    const res = await syncQuotesTool.execute({ accountId: 'default-account' }, ctx);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.totalRequested).toBe(1);
  });

  it('错误路径：accountId 为空串 → invalid_input', async () => {
    const ctx = await buildTestContext();
    const res = await syncQuotesTool.execute({ accountId: '' }, ctx);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });
});
