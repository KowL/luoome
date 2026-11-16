import type { ToolContext, ToolError } from '@luoome/core';

export const notificationAvailable = (ctx: ToolContext): boolean => {
  const admission = ctx.executionPolicy?.acquire('business.notification');
  return admission?.ok === true && ctx.executionPolicy?.valid(admission.permit) === true;
};

export const notificationDenied = (error: ToolError): boolean =>
  error.kind === 'permission_denied' && error.required === 'plugin:business.notification';
