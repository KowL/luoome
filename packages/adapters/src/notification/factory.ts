import type { Logger, RepositoryRegistry } from '@luoome/core';

import { FeishuWebhookAdapter } from './feishu.js';
import { NotificationManager } from './manager.js';

export const createFeishuWebhookAdapterFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly logger: Logger },
): FeishuWebhookAdapter | undefined => {
  const webhookUrl = env.LUOOME_FEISHU_WEBHOOK_URL?.trim();
  return webhookUrl === undefined || webhookUrl === ''
    ? undefined
    : new FeishuWebhookAdapter({ webhookUrl, logger: options.logger });
};

export const createNotificationManagerFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  options: {
    readonly repos: RepositoryRegistry;
    readonly logger: Logger;
    readonly clock?: () => Date;
  },
): NotificationManager =>
  new NotificationManager({
    repos: options.repos,
    logger: options.logger,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    feishu: createFeishuWebhookAdapterFromEnv(env, options),
  });
