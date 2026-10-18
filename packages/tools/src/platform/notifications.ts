import {
  DeliveryIntentSchema,
  defaultNotificationPreferences,
  HostedQuietHoursSchema,
  hostedQuietUntil,
  NotificationPreferencesSchema,
} from '@luoome/core';
import { z } from 'zod';
import { errAdapterError, errNotFound } from '../define-tool.js';
import { randomAuthId } from './crypto.js';
import { definePlatformTool } from './define-platform-tool.js';

const Id = z.string().min(1).max(160);

export const getHostedNotificationPreferencesTool = definePlatformTool({
  name: 'get_hosted_notification_preferences',
  description: 'Read current notification preferences without exposing an editable recipient.',
  sideEffect: 'read',
  actors: ['user'],
  input: z.object({}).strict(),
  output: NotificationPreferencesSchema,
  handler: async (_input, ctx) => {
    if (ctx.principal.kind !== 'user') return errNotFound('NotificationPreferences', 'current');
    return (
      (await ctx.repos.notifications.findPreferences(ctx.principal.tenantId)) ??
      defaultNotificationPreferences(ctx.principal.tenantId, ctx.principal.userId, ctx.clock())
    );
  },
});

export const saveHostedNotificationPreferencesTool = definePlatformTool({
  name: 'save_hosted_notification_preferences',
  description: 'Save versioned preferences using only the verified login email binding.',
  sideEffect: 'write',
  actors: ['user'],
  input: z
    .object({
      expectedRevision: z.number().int().nonnegative().safe(),
      emailEnabled: z.boolean(),
      detail: z.enum(['minimal', 'summary']),
      quietHours: HostedQuietHoursSchema,
    })
    .strict(),
  output: NotificationPreferencesSchema,
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'user') return errNotFound('NotificationPreferences', 'current');
    return ctx.repos.notifications.savePreferences({
      ...input,
      tenantId: ctx.principal.tenantId,
      userId: ctx.principal.userId,
      now: ctx.clock(),
    });
  },
});

export const listHostedDeliveriesTool = definePlatformTool({
  name: 'list_hosted_deliveries',
  description: 'Read current-tenant delivery state separately from business result success.',
  sideEffect: 'read',
  actors: ['user'],
  input: z.object({ limit: z.number().int().min(1).max(100).default(50) }).strict(),
  output: z.array(DeliveryIntentSchema),
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'user') return errNotFound('DeliveryIntent', 'current');
    return [...(await ctx.repos.deliveries.list(ctx.principal.tenantId))]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, input.limit);
  },
});

export const listPendingHostedDeliveriesTool = definePlatformTool({
  name: 'list_pending_hosted_deliveries',
  description: 'Read due intents and unresolved attempts for a bounded worker dispatch pass.',
  sideEffect: 'read',
  actors: ['worker'],
  input: z.object({ limit: z.number().int().min(1).max(100).default(20) }).strict(),
  output: z.array(DeliveryIntentSchema),
  handler: async (input, ctx) => [
    ...(await ctx.repos.deliveries.listPending({
      states: ['pending', 'failed', 'sending', 'unknown'],
      now: ctx.clock(),
      limit: input.limit,
    })),
  ],
});

export const suppressHostedDeliveryTool = definePlatformTool({
  name: 'suppress_hosted_delivery',
  description: 'Suppress an unsent intent whose business conditions are no longer current.',
  sideEffect: 'write',
  actors: ['worker'],
  input: z.object({ deliveryId: Id }).strict(),
  output: DeliveryIntentSchema,
  handler: async (input, ctx) => {
    const intent = await ctx.repos.deliveries.findById(input.deliveryId);
    if (intent === null) return errNotFound('DeliveryIntent', input.deliveryId);
    if (!['pending', 'failed'].includes(intent.state)) return intent;
    return ctx.repos.deliveries.defer({
      id: intent.id,
      availableAt: intent.expiresAt,
      now: ctx.clock(),
    });
  },
});

export const sendHostedDeliveryTool = definePlatformTool({
  name: 'send_hosted_delivery',
  description:
    'Dispatch one eligible intent with a bound recipient; an unknown attempt is never blindly resent.',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  actors: ['worker'],
  input: z.object({ deliveryId: Id, summary: z.string().max(1000).optional() }).strict(),
  output: DeliveryIntentSchema,
  handler: async (input, ctx) => {
    const intent = await ctx.repos.deliveries.findById(input.deliveryId);
    if (intent === null) return errNotFound('DeliveryIntent', input.deliveryId);
    if (!['pending', 'failed'].includes(intent.state)) return intent;
    const tenant = await ctx.repos.tenants.findById(intent.tenantId);
    if (tenant === null) return errNotFound('Tenant', intent.tenantId);
    const preferences = await ctx.repos.notifications.findPreferences(intent.tenantId);
    const now = ctx.clock();
    const eligibleBinding = intent.channel === 'in-app' ? 1 : (preferences?.bindingVersion ?? 0);
    const currentEmailBinding =
      preferences?.emailEnabled === true && preferences.bindingVersion === intent.bindingVersion;
    if (
      intent.channel === 'email' &&
      currentEmailBinding &&
      intent.expiresAt > now &&
      tenant.status === 'active' &&
      tenant.generation === intent.generation
    ) {
      const until = hostedQuietUntil(preferences.quietHours, now);
      if (until !== null)
        return ctx.repos.deliveries.defer({ id: intent.id, availableAt: until, now });
    }
    const claimed = await ctx.repos.deliveries.claim({
      id: intent.id,
      generation: tenant.generation,
      bindingVersion: eligibleBinding,
      attemptId: randomAuthId(),
      now,
    });
    if (claimed === null)
      return (
        (await ctx.repos.deliveries.findById(intent.id)) ?? errNotFound('DeliveryIntent', intent.id)
      );
    if (claimed.attemptId === null) throw new Error('Claimed delivery has no attempt identity');
    if (claimed.channel === 'in-app') {
      return ctx.repos.deliveries.complete({
        id: claimed.id,
        attemptId: claimed.attemptId,
        state: 'accepted',
        providerMessageId: `in-app:${claimed.id}`,
        now: ctx.clock(),
      });
    }
    const [user, currentTenant, currentPreferences, entitlement] = await Promise.all([
      ctx.repos.auth.findUserById(tenant.ownerUserId),
      ctx.repos.tenants.findById(tenant.id),
      ctx.repos.notifications.findPreferences(tenant.id),
      ctx.repos.subscriptions.currentEntitlement({ tenantId: tenant.id, now: ctx.clock() }),
    ]);
    if (
      user?.status !== 'active' ||
      user.email === null ||
      currentTenant?.status !== 'active' ||
      currentTenant.generation !== claimed.generation ||
      currentPreferences?.emailEnabled !== true ||
      currentPreferences.bindingVersion !== claimed.bindingVersion ||
      entitlement === null ||
      claimed.expiresAt <= ctx.clock()
    ) {
      return ctx.repos.deliveries.complete({
        id: claimed.id,
        attemptId: claimed.attemptId,
        state: 'suppressed',
        errorKind: 'recipient-unavailable',
        now: ctx.clock(),
      });
    }
    const provider = ctx.notification;
    if (provider?.configured !== true || ctx.publicOrigin === undefined) {
      return ctx.repos.deliveries.complete({
        id: claimed.id,
        attemptId: claimed.attemptId,
        state: 'failed',
        errorKind: 'provider-unconfigured',
        now: ctx.clock(),
      });
    }
    const message =
      currentPreferences.detail === 'summary' && input.summary !== undefined
        ? `${input.summary}\n请登录查看来源、截止时间和缺口。`
        : '有新的自选摘要或条件提醒，请登录查看。';
    const url = new URL('/', ctx.publicOrigin);
    const trigger = claimed.businessKey === `watch-trigger:${claimed.resultRef}`;
    url.hash = trigger
      ? `alerts?${new URLSearchParams({ triggerId: claimed.resultRef })}`
      : `reports?${new URLSearchParams({ reportId: claimed.resultRef })}`;
    let outcome: Awaited<ReturnType<typeof provider.send>>;
    try {
      outcome = await provider.send({
        deliveryIntentId: claimed.id,
        destination: user.email,
        subject: 'luoome 有新的事实记录',
        message,
        authenticatedUrl: url.href,
      });
    } catch {
      return ctx.repos.deliveries.markUnknown({
        id: claimed.id,
        attemptId: claimed.attemptId,
        now: ctx.clock(),
      });
    }
    try {
      return await ctx.repos.deliveries.complete({
        id: claimed.id,
        attemptId: claimed.attemptId,
        state: outcome.state,
        now: ctx.clock(),
        ...(outcome.state === 'accepted' ? { providerMessageId: outcome.providerMessageId } : {}),
        ...(outcome.state === 'failed' ? { errorKind: outcome.errorKind } : {}),
      });
    } catch {
      await ctx.repos.deliveries.markUnknown({
        id: claimed.id,
        attemptId: claimed.attemptId,
        now: ctx.clock(),
      });
      return errAdapterError('hosted-notification', 'delivery_persistence_unknown', true);
    }
  },
});

export const recoverSendingHostedDeliveryTool = definePlatformTool({
  name: 'recover_sending_hosted_delivery',
  description: 'Mark an abandoned sending attempt unknown for provider reconciliation.',
  sideEffect: 'write',
  actors: ['worker'],
  input: z.object({ deliveryId: Id }).strict(),
  output: DeliveryIntentSchema,
  handler: async (input, ctx) => {
    const intent = await ctx.repos.deliveries.findById(input.deliveryId);
    if (intent === null) return errNotFound('DeliveryIntent', input.deliveryId);
    const now = ctx.clock();
    if (
      intent.state !== 'sending' ||
      intent.attemptId === null ||
      now.getTime() - intent.updatedAt.getTime() < 120_000
    )
      return intent;
    return ctx.repos.deliveries.markUnknown({ id: intent.id, attemptId: intent.attemptId, now });
  },
});

export const reconcileHostedDeliveryTool = definePlatformTool({
  name: 'reconcile_hosted_delivery',
  description: 'Query the provider for an unknown attempt; only a confirmed absence permits retry.',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  actors: ['worker'],
  input: z.object({ deliveryId: Id }).strict(),
  output: DeliveryIntentSchema,
  handler: async (input, ctx) => {
    const intent = await ctx.repos.deliveries.findById(input.deliveryId);
    if (intent === null) return errNotFound('DeliveryIntent', input.deliveryId);
    if (intent.state !== 'unknown' || intent.attemptId === null) return intent;
    if (ctx.notification?.configured !== true)
      return errAdapterError('hosted-notification', 'provider_unconfigured');
    try {
      const lookup = await ctx.notification.lookup(intent.id);
      if (lookup.state === 'unknown') return intent;
      if (lookup.state === 'not-found' && ctx.notification.idempotency !== 'supported')
        return intent;
      return ctx.repos.deliveries.resolveUnknown({
        id: intent.id,
        attemptId: intent.attemptId,
        state: lookup.state === 'accepted' ? 'accepted' : 'failed',
        now: ctx.clock(),
        ...(lookup.state === 'accepted' ? { providerMessageId: lookup.providerMessageId } : {}),
      });
    } catch {
      return errAdapterError('hosted-notification', 'delivery_lookup_unknown', true);
    }
  },
});

export const applyHostedDeliveryReceiptTool = definePlatformTool({
  name: 'apply_hosted_delivery_receipt',
  description: 'Record delivered time exclusively from a verified configured-provider receipt.',
  sideEffect: 'write',
  actors: ['webhook'],
  input: z
    .object({
      deliveryId: Id,
      providerMessageId: z.string().min(1).max(256),
      deliveredAt: z.coerce.date(),
    })
    .strict(),
  output: DeliveryIntentSchema,
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'webhook' || ctx.principal.provider !== ctx.notification?.name)
      return errNotFound('DeliveryIntent', input.deliveryId);
    await ctx.repos.deliveries.markDelivered({
      id: input.deliveryId,
      providerMessageId: input.providerMessageId,
      deliveredAt: input.deliveredAt,
    });
    return (
      (await ctx.repos.deliveries.findById(input.deliveryId)) ??
      errNotFound('DeliveryIntent', input.deliveryId)
    );
  },
});

export const platformNotificationTools = [
  getHostedNotificationPreferencesTool,
  saveHostedNotificationPreferencesTool,
  listHostedDeliveriesTool,
  listPendingHostedDeliveriesTool,
  suppressHostedDeliveryTool,
  sendHostedDeliveryTool,
  recoverSendingHostedDeliveryTool,
  reconcileHostedDeliveryTool,
  applyHostedDeliveryReceiptTool,
] as const;
