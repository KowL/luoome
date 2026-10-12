import { AccountNameSchema, AccountSchema } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errNotFound } from '../define-tool.js';

export const UpdateAccountInput = z
  .object({
    accountId: z.string().min(1).optional(),
    name: AccountNameSchema,
  })
  .strict();

export const UpdateAccountOutput = z.object({ account: AccountSchema });

export const updateAccountTool = defineTool({
  name: 'update_account',
  description: '修改投资账户名称；不改变开户本金、币种或现金账本，缺省修改默认账户',
  sideEffect: 'write',
  input: UpdateAccountInput,
  output: UpdateAccountOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (ctx.identity?.mode === 'hosted' && accountId !== ctx.user.defaultAccountId) {
      return errNotFound('Account', accountId);
    }
    const account = await ctx.repos.account.updateName(accountId, input.name);
    return account === null ? errNotFound('Account', accountId) : { account };
  },
});
