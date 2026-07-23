import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { createAccountTool } from './create-account.js';

describe('create_account', () => {
  it('creates a real account without inserting any holdings or trades', async () => {
    const ctx = await buildTestContext();
    const before = await ctx.repos.account.list();

    const result = await createAccountTool.execute(
      { name: '真实账户', currency: 'CNY', initialCapital: 200_000 },
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.account.kind).toBe('real');
    expect(result.data.account.name).toBe('真实账户');
    expect(await ctx.repos.account.list()).toHaveLength(before.length + 1);
    expect(await ctx.repos.holding.listByAccount(result.data.account.id)).toEqual([]);
    expect(await ctx.repos.trade.listByAccount(result.data.account.id)).toEqual([]);
  });

  it('rejects a duplicate explicit account id', async () => {
    const ctx = await buildTestContext();
    const first = await createAccountTool.execute(
      { id: 'real-main', name: '主账户', currency: 'CNY', initialCapital: 100_000 },
      ctx,
    );
    expect(first.ok).toBe(true);

    const duplicate = await createAccountTool.execute(
      { id: 'real-main', name: '重复账户', currency: 'CNY', initialCapital: 100_000 },
      ctx,
    );
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.error.kind).toBe('invalid_input');
  });
});
