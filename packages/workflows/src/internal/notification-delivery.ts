import type { ToolContext, ToolError } from '@luoome/core';

export const notificationAvailable = (ctx: ToolContext): boolean => {
  return ctx.executionPolicy?.isEnabled('business.notification') === true;
};

export const notificationDenied = (error: ToolError): boolean =>
  error.kind === 'permission_denied' && error.required === 'plugin:business.notification';
