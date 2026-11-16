import { AccountSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const ListAccountsInput = z.object({}).default({});

export const ListAccountsOutput = z.object({
  accounts: z.array(AccountSchema),
  total: z.number().int().nonnegative(),
});

export const listAccountsTool = defineTool({
  name: 'list_accounts',
  description: '列出所有账户',
  sideEffect: 'read',
  input: ListAccountsInput,
  output: ListAccountsOutput,
  handler: async (_input, ctx) => {
    const accounts = await ctx.repos.account.list();
    return { accounts, total: accounts.length };
  },
});
