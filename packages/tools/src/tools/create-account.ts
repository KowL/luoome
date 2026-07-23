import { type Account, AccountSchema, money } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput } from '../define-tool.js';
import { manualId } from '../internal/manual-entry.js';

export const CreateAccountInput = z.object({
  id: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(120),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase()),
  initialCapital: z.number().nonnegative(),
});

export const CreateAccountOutput = z.object({
  account: AccountSchema,
});

export const createAccountTool = defineTool({
  name: 'create_account',
  description: '创建一个真实投资账户；空数据库首次使用时先调用此工具',
  sideEffect: 'write',
  input: CreateAccountInput,
  output: CreateAccountOutput,
  handler: async (input, ctx) => {
    const id = input.id ?? manualId('account');
    if ((await ctx.repos.account.findById(id)) !== null) {
      return errInvalidInput(`账户 id=${id} 已存在`);
    }
    const account: Account = {
      id,
      name: input.name,
      kind: 'real',
      currency: input.currency,
      initialCapital: money(input.initialCapital),
      createdAt: ctx.clock(),
    };
    await ctx.repos.account.save(account);
    return { account };
  },
});
