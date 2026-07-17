import { AccountSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const GetAccountInput = z.object({
  /** 账户 id；缺省为当前用户默认账户。 */
  accountId: z.string().min(1).optional(),
});

export const GetAccountOutput = z.object({
  account: AccountSchema,
});

export const getAccountTool = defineTool({
  name: 'get_account',
  description: '按 id 查询单个账户详情（缺省查默认账户）',
  sideEffect: 'read',
  input: GetAccountInput,
  output: GetAccountOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);
    return { account };
  },
});
