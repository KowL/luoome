import { AccountSchema, createDefaultAccount } from '@luoome/core';
import { z } from 'zod';
import { defineTool } from '../define-tool.js';

export const ensureDefaultAccountTool = defineTool({
  name: 'ensure_default_account',
  description: '初始化唯一默认投资账户；空库建立零本金 CNY 账户，重试保留已有账本',
  sideEffect: 'write',
  input: z.object({}).strict(),
  output: z.object({ account: AccountSchema }),
  handler: async (_input, ctx) => {
    return {
      account: await ctx.repos.account.ensureSingleDefault(createDefaultAccount(ctx.clock())),
    };
  },
});
