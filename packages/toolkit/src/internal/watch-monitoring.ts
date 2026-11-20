import { PluginExecutionDenied, type ToolContext } from '@luoome/core';

export const assertWatchMonitoring = (ctx: ToolContext): void => {
  ctx.executionGuard?.();
  if (ctx.executionPolicy?.isEnabled('business.watch-monitoring') === false)
    throw new PluginExecutionDenied('plugin:business.watch-monitoring');
};
