import { z } from 'zod';
import type { WatchTrigger } from '../entity/watch-trigger.js';

const HostedTradingPlanTriggerSourceSchema = z.object({
  planVersionId: z.string().min(1),
  conditionId: z.string().min(1),
  accountFactsDigest: z.string().min(1),
  validUntil: z.coerce.date(),
});

export const hostedTradingPlanTriggerSource = (trigger: WatchTrigger) => {
  const prefix = 'trading-plan-watch:';
  if (!trigger.poolId.startsWith(prefix)) return null;
  const accountId = trigger.poolId.slice(prefix.length);
  const parsed = HostedTradingPlanTriggerSourceSchema.safeParse(trigger.evalSnapshot);
  if (
    accountId.length === 0 ||
    !parsed.success ||
    trigger.ruleId !== `${parsed.data.planVersionId}:${parsed.data.conditionId}`
  )
    return null;
  return { accountId, ...parsed.data };
};

export const HostedQuietHoursSchema = z
  .object({
    enabled: z.boolean(),
    startMinutes: z.number().int().min(0).max(1439),
    endMinutes: z.number().int().min(0).max(1439),
    timeZone: z.literal('Asia/Shanghai'),
  })
  .refine(
    (value) => !value.enabled || value.startMinutes !== value.endMinutes,
    'Enabled quiet hours must have distinct start and end times',
  );

export type HostedQuietHours = z.infer<typeof HostedQuietHoursSchema>;

export const NotificationPreferencesSchema = z.object({
  id: z.string().min(1).max(160),
  tenantId: z.string().min(1).max(160),
  userId: z.string().min(1).max(160),
  emailEnabled: z.boolean(),
  detail: z.enum(['minimal', 'summary']),
  quietHours: HostedQuietHoursSchema,
  bindingVersion: z.number().int().positive().safe(),
  revision: z.number().int().nonnegative().safe(),
  updatedAt: z.coerce.date(),
});

export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;

export const defaultNotificationPreferences = (
  tenantId: string,
  userId: string,
  now: Date,
): NotificationPreferences => ({
  id: tenantId,
  tenantId,
  userId,
  emailEnabled: false,
  detail: 'minimal',
  quietHours: {
    enabled: true,
    startMinutes: 22 * 60,
    endMinutes: 8 * 60,
    timeZone: 'Asia/Shanghai',
  },
  bindingVersion: 1,
  revision: 0,
  updatedAt: now,
});

export const hostedQuietUntil = (quietHours: HostedQuietHours, now: Date): Date | null => {
  if (!quietHours.enabled) return null;
  const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const minutes = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  const { startMinutes, endMinutes } = quietHours;
  const quiet =
    startMinutes < endMinutes
      ? minutes >= startMinutes && minutes < endMinutes
      : minutes >= startMinutes || minutes < endMinutes;
  if (!quiet) return null;
  const dayOffset = startMinutes > endMinutes && minutes >= startMinutes ? 1 : 0;
  return new Date(
    Date.UTC(
      shanghai.getUTCFullYear(),
      shanghai.getUTCMonth(),
      shanghai.getUTCDate() + dayOffset,
      0,
      endMinutes,
    ) -
      8 * 60 * 60 * 1000,
  );
};

export interface HostedNotificationRequest {
  readonly deliveryIntentId: string;
  readonly destination: string;
  readonly subject: string;
  readonly message: string;
  readonly authenticatedUrl: string;
}

export type HostedNotificationResult =
  | { readonly state: 'accepted'; readonly providerMessageId: string }
  | { readonly state: 'failed'; readonly errorKind: 'provider-unconfigured' | 'provider-rejected' }
  | { readonly state: 'unknown' };

export type HostedNotificationLookupResult =
  | { readonly state: 'accepted'; readonly providerMessageId: string }
  | { readonly state: 'not-found' }
  | { readonly state: 'unknown' };

export interface HostedNotificationPort {
  readonly name: string;
  readonly providerKind: 'fixture' | 'live';
  readonly configured: boolean;
  readonly idempotency: 'supported' | 'unsupported';
  send(input: HostedNotificationRequest): Promise<HostedNotificationResult>;
  lookup(deliveryIntentId: string): Promise<HostedNotificationLookupResult>;
}
