import { AccountSchema, createDefaultAccount } from '@luoome/core';
import { z } from 'zod';
import { defineTool } from '../define-tool.js';

export const ensureDefaultAccountTool = defineTool({
  name: 'ensure_default_account',
  description: '托管内部初始化唯一默认投资账户；空库建立零本金 CNY 账户，重试保留已有账本',
  sideEffect: 'write',
  input: z.object({}).strict(),
  output: z.object({ account: AccountSchema }),
  handler: async (_input, ctx) => {
    if (ctx.identity?.mode !== 'hosted' || ctx.identity.actor !== 'worker') {
      return {
        ok: false,
        error: { kind: 'permission_denied', required: 'actor:hosted-worker' },
      };
    }
    return {
      account: await ctx.repos.account.ensureSingleDefault(createDefaultAccount(ctx.clock())),
    };
  },
});
