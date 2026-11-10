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
});
