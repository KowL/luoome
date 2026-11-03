import {
  analysisHash,
  type ConfirmablePluginTool,
  cancelGoalRunTool,
  goalRunReceipt,
  PluginOperationScopeError,
  StartGoalRunInput,
  startGoalRunTool,
} from '@luoome/tools';

export const createGoalOperationPolicies = (): readonly ConfirmablePluginTool[] => [
  {
    tool: startGoalRunTool,
    scheduled: false,
    hostBoundFields: ['accountId', 'requestId'],
    bind(raw, principal, operationId) {
      const input = StartGoalRunInput.parse(raw);
      if (input.accountId !== undefined && input.accountId !== principal.accountId)
        throw new PluginOperationScopeError('accountId');
      if (input.requestId !== undefined && input.requestId !== operationId)
        throw new PluginOperationScopeError('requestId');
      return { ...input, accountId: principal.accountId, requestId: operationId };
    },
    async receipt(raw, ctx) {
      const input = StartGoalRunInput.parse(raw);
      if (!input.accountId || !input.requestId) return null;
      const run = await ctx.repos.goalRun.find(input.accountId, `goal:${input.requestId}`);
      return run?.hostJobId &&
        run.requestHash === analysisHash({ accountId: input.accountId, request: input.request })
        ? { ok: true, data: goalRunReceipt(run) }
        : null;
    },
  },
  {
    tool: cancelGoalRunTool,
    scheduled: false,
    hostBoundFields: ['accountId'],
    bind(raw, principal) {
      const input = cancelGoalRunTool.inputSchema.parse(raw);
      if (input.accountId !== undefined && input.accountId !== principal.accountId)
        throw new PluginOperationScopeError('accountId');
      return { ...input, accountId: principal.accountId };
    },
    async receipt(raw, ctx) {
      const input = cancelGoalRunTool.inputSchema.parse(raw);
      if (!input.accountId) return null;
      const run = await ctx.repos.goalRun.find(input.accountId, input.goalId);
      return run?.status === 'cancelled' ? { ok: true, data: goalRunReceipt(run) } : null;
    },
  },
];
