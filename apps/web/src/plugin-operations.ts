import { dateInShanghai } from '@luoome/core';
import type { BuiltinPluginOperations } from '@luoome/tools';
import {
  closingReportCutoffWorkflow,
  intradayWatchWorkflow,
  previousTradingDay,
  runStrategySchedulesOperation,
  snapshotAccountPerformanceWorkflow,
} from '@luoome/workflows';

export const webPluginOperations: BuiltinPluginOperations = {
  strategy: {
    run: (ctx, input) => runStrategySchedulesOperation.run(input, ctx),
  },
  report: {
    run: async (ctx) => {
      const priorDate = previousTradingDay(dateInShanghai(ctx.clock()));
      const recovered = await closingReportCutoffWorkflow.run({ date: priorDate }, ctx);
      if (!recovered.ok || recovered.data.failed.length > 0)
        ctx.logger.error('前一交易日收盘报告补投失败', {
          date: priorDate,
          error: recovered.ok ? recovered.data.failed : recovered.error,
        });
      ctx.executionGuard?.();
      return closingReportCutoffWorkflow.run({}, ctx);
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
