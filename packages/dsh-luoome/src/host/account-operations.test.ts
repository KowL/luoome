import { randomUUID } from 'node:crypto';
import { createPluginOperationService } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { updateAccountOperation } from './account-operations.js';

describe('account settings operation', () => {
  it('previews, confirms once, and reads back the same owner account', async () => {
    const ctx = await buildTestContext();
    const principal = { userId: ctx.user.id, accountId: ctx.user.defaultAccountId };
    const original = await ctx.repos.account.findById(principal.accountId);
    const service = createPluginOperationService({
      repository: ctx.repos.pluginAuthority,
      policies: [updateAccountOperation],
      capabilities: ['write'],
      policyVersion: 1,
      now: Date.now,
      context: () => ctx,
    });
    const id = randomUUID();
    const prepared = await service.prepare(principal, {
      id,
      tool: 'update_account',
      input: { name: '新的账户名称' },
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    expect(await ctx.repos.account.findById(principal.accountId)).toEqual(original);
    const { confirmationToken, input } = prepared.data as {
      confirmationToken: string;
      input: unknown;
    };
    expect(input).toEqual({ accountId: principal.accountId, name: '新的账户名称' });
    for (let index = 0; index < 2; index++)
      expect(
        await service.confirm(
          principal,
          { id, token: confirmationToken },
          new AbortController().signal,
        ),
      ).toMatchObject({ ok: true, data: { state: 'succeeded' } });
    expect(await ctx.repos.account.findById(principal.accountId)).toEqual({
      ...original,
      name: '新的账户名称',
    });
    expect(() =>
      updateAccountOperation.bind(
        { accountId: 'foreign', name: '覆盖' },
        principal,
        randomUUID(),
        ctx,
      ),
    ).toThrow();
    expect(await updateAccountOperation.receipt(input, ctx)).toMatchObject({ ok: true });
    service.dispose();
  });
});
