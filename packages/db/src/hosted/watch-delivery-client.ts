import {
  isWatchAlertDeliveryEligible,
  WatchDeliveryIntentSchema,
  WatchNotificationSettingsSchema,
} from '@luoome/core';
import { and, eq, gt } from 'drizzle-orm';
import type { DrizzleDb } from '../client.js';
import { DrizzleWatchTriggerRepository } from '../repository/drizzle/watch-trigger.js';
import { alertPlans, watchExecutionLease, watchlistMembers, watchlists } from '../schema/index.js';
import { watchDeliveryIntents, watchNotificationSettings } from './watch-delivery-schema.js';
import { createWatchDeliveryRepository } from './watch-delivery-store.js';

export const createDrizzleWatchDeliveryRepository = (db: DrizzleDb) =>
  createWatchDeliveryRepository({
    transaction: (run) => db.transaction(() => run(), { behavior: 'immediate' }),
    settings: () => {
      const row = db
        .select()
        .from(watchNotificationSettings)
        .where(eq(watchNotificationSettings.id, 'feishu'))
        .get();
      return row === undefined ? null : WatchNotificationSettingsSchema.parse(row.settings);
    },
    putSettings: (settings) => {
      db.insert(watchNotificationSettings)
        .values({ id: 'feishu', settings })
        .onConflictDoUpdate({ target: watchNotificationSettings.id, set: { settings } })
        .run();
    },
    list: () =>
      db
        .select()
        .from(watchDeliveryIntents)
        .all()
        .map((row) => WatchDeliveryIntentSchema.parse(row.intent)),
    get: (id) => {
      const row = db
        .select()
        .from(watchDeliveryIntents)
        .where(eq(watchDeliveryIntents.id, id))
        .get();
      return row === undefined ? null : WatchDeliveryIntentSchema.parse(row.intent);
    },
    put: (intent) => {
      db.insert(watchDeliveryIntents)
        .values({ id: intent.id, intent })
        .onConflictDoUpdate({ target: watchDeliveryIntents.id, set: { intent } })
        .run();
    },
    owns: (owner, now) =>
      db
        .select()
        .from(watchExecutionLease)
        .where(and(eq(watchExecutionLease.owner, owner), gt(watchExecutionLease.until, now)))
        .get() !== undefined,
    trigger: (id) => new DrizzleWatchTriggerRepository(db).getForDelivery(id),
    eligible: (trigger) => {
      const plan = db.select().from(alertPlans).where(eq(alertPlans.id, trigger.poolId)).get();
      if (plan === undefined) return false;
      const watchlist = db
        .select()
        .from(watchlists)
        .where(eq(watchlists.id, plan.watchlistId))
        .get();
      const member = db
        .select()
        .from(watchlistMembers)
        .where(
          and(
            eq(watchlistMembers.watchlistId, plan.watchlistId),
            eq(watchlistMembers.stockId, trigger.stockId),
          ),
        )
        .get();
      return isWatchAlertDeliveryEligible(trigger, plan, watchlist, member);
    },
  });
