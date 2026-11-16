import { PluginExecutionDenied, type ToolContext } from '@luoome/core';

export const assertWatchMonitoring = (ctx: ToolContext): void => {
  ctx.executionGuard?.();
  const admission = ctx.executionPolicy?.acquire('business.watch-monitoring');
  if (!admission?.ok || !ctx.executionPolicy?.valid(admission.permit))
    throw new PluginExecutionDenied('plugin:business.watch-monitoring');
};
