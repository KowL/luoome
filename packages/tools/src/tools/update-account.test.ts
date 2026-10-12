import type { ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { updateAccountTool } from './update-account.js';

describe('update_account', () => {
  it('changes only the default account name and preserves its financial facts', async () => {
    const ctx = await buildTestContext();
    const before = await ctx.repos.account.findById(ctx.user.defaultAccountId);
    const result = await updateAccountTool.execute({ name: '  我的投资账户  ' }, ctx);
    expect(result).toEqual({ ok: true, data: { account: { ...before, name: '我的投资账户' } } });
  });

  it.each(['initialCapital', 'cashBalance', 'currency', 'kind', 'createdAt'])(
    'rejects changes to %s rather than silently accepting a partial financial edit',
    async (field) => {
      const ctx = await buildTestContext();
      const before = await ctx.repos.account.findById(ctx.user.defaultAccountId);
      const result = await updateAccountTool.execute(
        { name: '修改', [field]: field === 'currency' ? 'USD' : 1 },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('invalid_input');
      expect(await ctx.repos.account.findById(ctx.user.defaultAccountId)).toEqual(before);
    },
  );

  it('does not let a hosted request edit a different account even with a permissive outer gate', async () => {
    const base = await buildTestContext();
    const other = (await base.repos.account.list()).find(
      (account) => account.id !== base.user.defaultAccountId,
    );
    if (other === undefined) throw new Error('Expected multiple local accounts in fixture');
    const ctx: ToolContext = {
      ...base,
      identity: {
        mode: 'hosted',
        userId: base.user.id,
        tenantId: 'tenant-one',
        tenantGeneration: 1,
        actor: 'user',
        requestId: 'rename-one',
      },
      hostedAuthorization: () => null,
    };
    const result = await updateAccountTool.execute({ accountId: other.id, name: '越界' }, ctx);
    expect(result).toEqual({
      ok: false,
      error: { kind: 'not_found', entity: 'Account', id: other.id },
    });
    expect(await ctx.repos.account.findById(other.id)).toEqual(other);
    expect((await updateAccountTool.execute({ name: '本人账户' }, ctx)).ok).toBe(true);
  });
});
