import type { ToolContributions } from '@luoome/toolkit';
import { sendNotificationTool } from './tools/send-notification.js';

export const notificationToolContributions = {
  send_notification: {
    execution: 'p3',
    owner: 'business.notification',
    tool: sendNotificationTool,
    agent: false,
  },
} as const satisfies ToolContributions;
