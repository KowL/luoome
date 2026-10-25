import { BatchInput, batchTools } from '@luoome/batch';
import type { ConfirmablePluginTool } from '@luoome/tools';

/** 定时调用仍需宿主 delivery 身份及逐任务 grant；这里只冻结账户，不接受全账户提权。 */
export const createBatchOperationPolicies = (): readonly ConfirmablePluginTool[] =>
  batchTools.map((tool) => ({
    tool,
    scheduled: true,
    hostBoundFields: ['accountId'],
    async bind(raw, principal, _operationId, ctx) {
      const input = BatchInput.parse(raw);
      if (input.accountId !== undefined && input.accountId !== principal.accountId)
        throw new Error('Operation scope mismatch');
      if ((await ctx.repos.account.findById(principal.accountId)) === null)
        throw new Error('Operation account unavailable');
      return { ...input, accountId: principal.accountId };
    },
    // 批次可能部分提交多个领域事实；无法证明整个批次完成时保持 unknown，禁止盲目重跑。
    receipt: async () => null,
  }));
