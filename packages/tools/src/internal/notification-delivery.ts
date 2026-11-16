import { PluginExecutionDenied, type ToolContext } from '@luoome/core';

export const assertNotificationDelivery = (ctx: ToolContext): void => {
  ctx.executionGuard?.();
  const admission = ctx.executionPolicy?.acquire('business.notification');
  if (!admission?.ok || !ctx.executionPolicy?.valid(admission.permit))
    throw new PluginExecutionDenied('plugin:business.notification');
  const denied = ctx.executionPolicy.authorizeTool('send_notification', {}, ['external']);
  if (denied !== null && !denied.ok && denied.error.kind === 'permission_denied')
    throw new PluginExecutionDenied(denied.error.required);
};
