import type { AlertPlan } from '../entity/alert-plan.js';
import type { WatchTrigger } from '../entity/watch-trigger.js';
import { dateInShanghai } from '../trading-calendar.js';
import type { PersonalRepository } from './repository.js';

export const preparePersonalDeliveryMutation = (input: {
  trigger: WatchTrigger | null;
  plan: AlertPlan | null;
  memberActive: boolean;
  priorTriggers: readonly WatchTrigger[];
  channel: 'email' | 'in-app';
  emailAttempt: number;
  maxDailyNotifications: number;
  now: Date;
}): { eligible: boolean; trigger: WatchTrigger | null } => {
  const { trigger, plan } = input;
  if (trigger === null) return { eligible: false, trigger: null };
  const personal =
    trigger.direction === 'watch' && ['price-level', 'price-change'].includes(trigger.ruleKind);
  if (
    !personal ||
    !input.memberActive ||
    plan?.enabled !== true ||
    plan.updatedAt > trigger.createdAt ||
    !['pending', 'sent', 'failed', 'unverifiable'].includes(trigger.deliveryStatus)
  )
    return { eligible: false, trigger };
  if (input.channel === 'in-app') return { eligible: true, trigger };
  if (input.emailAttempt > 3) return { eligible: false, trigger };
  const previous = trigger.deliveryAttempts ?? 0;
  const extra = Math.max(0, input.emailAttempt - Math.max(1, previous));
  const dayStart = new Date(`${dateInShanghai(input.now)}T00:00:00+08:00`);
  const reserved = input.priorTriggers.filter(
    (item) =>
      item.createdAt >= dayStart &&
      item.direction === 'watch' &&
      ['price-level', 'price-change'].includes(item.ruleKind) &&
      (['pending', 'sent', 'failed', 'fallback-log', 'unverifiable'].includes(
        item.deliveryStatus,
      ) ||
        (item.deliveryAttempts ?? 0) > 0),
  );
  const used = (items: readonly WatchTrigger[]) =>
    items.reduce((sum, item) => sum + Math.max(1, item.deliveryAttempts ?? 0), 0);
  if (
    used(reserved) + extra > input.maxDailyNotifications ||
    used(reserved.filter((item) => item.poolId === plan.id)) + extra > plan.dailyNotificationLimit
  )
    return { eligible: false, trigger };
  return {
    eligible: true,
    trigger: {
      ...trigger,
      deliveryAttempts: Math.max(previous, input.emailAttempt),
      lastDeliveryAttemptAt:
        input.emailAttempt > previous ? input.now : trigger.lastDeliveryAttemptAt,
    },
  };
};

export const syncPersonalDeliveryMutation = (
  trigger: WatchTrigger | null,
  input: Parameters<PersonalRepository['syncPersonalDelivery']>[0],
): WatchTrigger | null => {
  if (trigger === null) return null;
  if (input.channel === 'email' && input.attempts < (trigger.deliveryAttempts ?? 0)) return trigger;
  const attempts =
    input.channel === 'email'
      ? Math.max(trigger.deliveryAttempts ?? 0, input.attempts)
      : trigger.deliveryAttempts;
  if (input.channel === 'in-app' && (attempts ?? 0) > 0) return trigger;
  const status =
    input.state === 'accepted'
      ? 'sent'
      : input.state === 'unknown'
        ? 'unverifiable'
        : input.state === 'suppressed'
          ? 'invalidated'
          : input.state === 'failed'
            ? 'failed'
            : 'pending';
  const invalidated = ['invalidated', 'expired'].includes(trigger.deliveryStatus);
  return {
    ...trigger,
    deliveryAttempts: attempts,
    deliveryStatus: invalidated ? trigger.deliveryStatus : status,
    notified: !invalidated && input.state === 'accepted',
    notificationId: input.notificationId,
    deliveryCompletedAt: ['accepted', 'failed', 'suppressed'].includes(input.state)
      ? input.now
      : trigger.deliveryCompletedAt,
  };
};
