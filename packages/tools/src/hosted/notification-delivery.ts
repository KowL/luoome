import { FeishuAdapterError, FeishuWebhookAdapter } from '@luoome/adapters';
import type { Notification, NotificationPayload, ToolContext } from '@luoome/core';

export const sendHostedFeishu = async (
  ctx: ToolContext,
  webhookUrl: string | null,
  id: string,
  payload: NotificationPayload,
  suppressionKind = 'fallback-log',
): Promise<{
  notification: Notification;
  state: 'accepted' | 'failed' | 'unknown' | 'suppressed';
  errorKind: string | null;
}> => {
  let result: Notification['result'];
  let state: 'accepted' | 'failed' | 'unknown' | 'suppressed';
  let errorKind: string | null = null;
  if (webhookUrl === null) {
    result = 'suppressed';
    state = 'suppressed';
    errorKind = suppressionKind;
  } else {
    try {
      await new FeishuWebhookAdapter({ webhookUrl }).send(payload);
      result = 'success';
      state = 'accepted';
    } catch (error) {
      result = 'failed';
      state =
        error instanceof FeishuAdapterError && error.statusCode !== undefined
          ? 'failed'
          : 'unknown';
      errorKind = state === 'unknown' ? 'provider-outcome-unknown' : 'provider-rejected';
    }
  }
  const notification: Notification = {
    id,
    channel: 'feishu',
    payload,
    result,
    sentAt: ctx.clock(),
    ...(result === 'failed' || (result === 'suppressed' && errorKind !== 'fallback-log')
      ? { errorMessage: errorKind as string }
      : {}),
  };
  await ctx.repos.notification.save(notification);
  return { notification, state, errorKind };
};
