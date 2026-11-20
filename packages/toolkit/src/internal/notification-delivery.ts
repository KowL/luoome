import { PluginExecutionDenied, type ToolContext } from '@luoome/core';

export const assertNotificationDelivery = (ctx: ToolContext): void => {
  ctx.executionGuard?.();
  if (ctx.executionPolicy !== undefined && !ctx.executionPolicy.isEnabled('business.notification'))
    throw new PluginExecutionDenied('plugin:business.notification');
  const denied = ctx.executionPolicy?.authorizeTool('send_notification', {}, ['external']);
  if (denied != null && !denied.ok && denied.error.kind === 'permission_denied')
    throw new PluginExecutionDenied(denied.error.required);
};
