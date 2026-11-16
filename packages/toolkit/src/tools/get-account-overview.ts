import { AccountFactsSchema, AccountSchema, MoneySchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';
import { getAccountFactsTool } from './account-facts.js';
import { getAccountTool } from './get-account.js';
import { ListHoldingsInput, ListHoldingsOutput, listHoldingsTool } from './list-holdings.js';

export const GetAccountOverviewInput = z.object({
  accountId: z.string().min(1).optional(),
  holdingsStatus: ListHoldingsInput.shape.status,
  includeFacts: z.boolean().default(true),
});

export const GetAccountOverviewOutput = z.object({
  account: AccountSchema,
  accountId: z.string().min(1),
  holdingsStatus: ListHoldingsInput.shape.status,
  holdings: ListHoldingsOutput.shape.holdings,
  totalValue: MoneySchema,
  totalCost: MoneySchema,
  totalPnL: MoneySchema,
  facts: AccountFactsSchema.optional(),
});

export const getAccountOverviewTool = defineTool({
  name: 'get_account_overview',
  description:
    '一次性获取账户总资产、现金、仓位占比与持仓明细（合并账户 + 持仓 + 账户事实），可附计算事实与缺口',
  sideEffect: 'read',
  input: GetAccountOverviewInput,
  output: GetAccountOverviewOutput,
  handler: async (input, ctx) => {
    const accountResult = await getAccountTool.execute(
      { ...(input.accountId === undefined ? {} : { accountId: input.accountId }) },
      ctx,
    );
    if (!accountResult.ok) return accountResult;
    const accountId = accountResult.data.account.id;
    const holdingsResult = await listHoldingsTool.execute(
      { accountId, status: input.holdingsStatus },
      ctx,
    );
    if (!holdingsResult.ok) return holdingsResult;
    const output: z.infer<typeof GetAccountOverviewOutput> = {
      account: accountResult.data.account,
      accountId,
      holdingsStatus: input.holdingsStatus,
      holdings: holdingsResult.data.holdings,
      totalValue: holdingsResult.data.totalValue,
      totalCost: holdingsResult.data.totalCost,
      totalPnL: holdingsResult.data.totalPnL,
    };
    if (input.includeFacts) {
      const facts = await getAccountFactsTool.execute({ accountId }, ctx);
      if (facts.ok) output.facts = facts.data.facts;
    }
    return output;
  },
});
