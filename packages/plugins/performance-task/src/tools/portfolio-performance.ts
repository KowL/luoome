import { PluginExecutionDenied } from '@luoome/core';
import { defineTool } from '@luoome/toolkit';
import {
  GetAccountPerformanceInput,
  GetAccountPerformanceOutput,
  getAccountPerformanceTool,
} from '@luoome/toolkit/tools/portfolio-performance.js';

export const snapshotAccountPerformanceTool = defineTool({
  name: 'snapshot_account_performance',
  description: 'workflow-only：受控执行单账户绩效估值任务，复用共享计算与快照指纹',
  sideEffect: 'write',
  requiredCapabilities: ['write', 'external'],
  input: GetAccountPerformanceInput,
  output: GetAccountPerformanceOutput,
  handler: async (input, ctx) => {
    const check = () => {
      ctx.executionGuard?.();
      if (ctx.executionPolicy?.isEnabled('task.snapshot-account-performance') === false)
        throw new PluginExecutionDenied('plugin:task.snapshot-account-performance');
    };
    check();
    const result = await getAccountPerformanceTool.execute(input, {
      ...ctx,
      executionGuard: check,
    });
    return result.ok ? result.data : result;
  },
});
