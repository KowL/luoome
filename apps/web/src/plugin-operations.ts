import type { BuiltinPluginOperations } from '@luoome/tools';
import {
  intradayWatchWorkflow,
  snapshotAccountPerformanceWorkflow,
  weeklyReportOperation,
} from '@luoome/workflows';

export const webPluginOperations: BuiltinPluginOperations = {
  report: {
    run: async (ctx) => {
      const result = await weeklyReportOperation.run({ mode: 'scheduled' }, ctx);
      ctx.executionGuard?.();
      return result;
    },
  },
  performance: {
    run: (ctx, tradingDay) =>
      snapshotAccountPerformanceWorkflow.run({ to: tradingDay, mode: 'scheduled' }, ctx),
  },
  watch: {
    runAccount: async (ctx, accountId) => {
      const result = await intradayWatchWorkflow.run({ accountId }, ctx);
      if (!result.ok) return result;
      const watch = result.data.tradingPlanWatch;
      if (watch === undefined)
        return {
          ok: false,
          error: { kind: 'internal', cause: 'intraday-watch 未返回交易计划结果' },
        };
      return { ok: true, data: watch };
    },
  },
};
