import { PluginExecutionDenied, type ToolContext } from '@luoome/core';

export const assertReportGeneration = (ctx: ToolContext): void => {
  ctx.executionGuard?.();
  const admission = ctx.executionPolicy?.acquire('business.report');
  if (!admission?.ok || !ctx.executionPolicy?.valid(admission.permit))
    throw new PluginExecutionDenied('plugin:business.report');
};
