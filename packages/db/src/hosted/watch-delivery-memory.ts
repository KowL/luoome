import {
  defaultWatchNotificationSettings,
  hostedTradingPlanTriggerSource,
  isAshareTradingSession,
  isWatchAlertDeliveryEligible,
  type WatchDeliveryIntent,
  type WatchNotificationSettings,
} from '@luoome/core';
import type { InMemoryAlertPlanRepository } from '../repository/memory/alert-plan.js';
import type { InMemoryWatchTriggerRepository } from '../repository/memory/watch-trigger.js';
import type {
  InMemoryWatchlistMemberRepository,
  InMemoryWatchlistRepository,
} from '../repository/memory/watchlist.js';
import { createWatchDeliveryRepository } from './watch-delivery-store.js';

export const createMemoryWatchDeliveryRepository = (deps: {
  watchTrigger: InMemoryWatchTriggerRepository;
  alertPlan: InMemoryAlertPlanRepository;
  watchlist: InMemoryWatchlistRepository;
  watchlistMember: InMemoryWatchlistMemberRepository;
}) => {
  let settings: WatchNotificationSettings | null = null;
  let intents = new Map<string, WatchDeliveryIntent>();
  const repository = createWatchDeliveryRepository({
    transaction: (run) => {
      const before = structuredClone({ settings, intents });
      try {
        return run();
      } catch (error) {
        settings = before.settings;
        intents = before.intents;
        throw error;
      }
    },
    settings: () => structuredClone(settings),
    putSettings: (value) => {
      settings = structuredClone(value);
    },
    list: () => structuredClone([...intents.values()]),
    get: (id) => structuredClone(intents.get(id) ?? null),
    put: (intent) => {
      intents.set(intent.id, structuredClone(intent));
    },
    owns: (owner, now) => deps.watchTrigger.ownsExecution(owner, now),
    trigger: (id) =>
      deps.watchTrigger.snapshotForExport().find((trigger) => trigger.id === id) ?? null,
    eligible: (trigger, now) => {
      const source = hostedTradingPlanTriggerSource(trigger);
      // Synthetic plan pools have no AlertPlan; the sender rechecks the live plan and ledger.
      if (source !== null) return source.validUntil > now && isAshareTradingSession(now);
      const plan = deps.alertPlan.snapshotForExport().find((entry) => entry.id === trigger.poolId);
      if (plan === undefined) return false;
      const watchlist = deps.watchlist
        .snapshotForExport()
        .find((entry) => entry.id === plan.watchlistId);
      const member = deps.watchlistMember
        .snapshotForExport()
        .members.find(
          (entry) => entry.watchlistId === plan.watchlistId && entry.stockId === trigger.stockId,
        );
      return isWatchAlertDeliveryEligible(trigger, plan, watchlist, member);
    },
  });
  return {
    ...repository,
    snapshotSettings: () => structuredClone(settings ?? defaultWatchNotificationSettings()),
  };
};
