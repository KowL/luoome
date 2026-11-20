import { PluginExecutionDenied, type ToolContext } from '@luoome/core';

export const assertReportGeneration = (ctx: ToolContext): void => {
  ctx.executionGuard?.();
  if (ctx.executionPolicy?.isEnabled('business.report') === false)
    throw new PluginExecutionDenied('plugin:business.report');
};
