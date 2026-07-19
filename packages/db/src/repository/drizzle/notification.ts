import {
  assertNotificationInvariants,
  type Notification,
  type NotificationRepository,
  type NotificationResult,
} from '@luoome/core';
import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { notifications, type Schema } from '../../schema/index.js';

type NotifRow = typeof notifications.$inferSelect;

const toNotification = (row: NotifRow): Notification => {
  // exactOptionalPropertyTypes 要求可选字段要么赋值，要么不出现键；用对象 spread
  const base: Notification = {
    id: row.id,
    channel: row.channel,
    payload: row.payload,
    result: row.result,
    sentAt: row.sentAt,
  };
  return Object.assign(base, {
    ...(row.errorMessage !== null ? { errorMessage: row.errorMessage } : {}),
    ...(row.adviceId !== null ? { adviceId: row.adviceId } : {}),
    ...(row.tacticSignalId !== null ? { tacticSignalId: row.tacticSignalId } : {}),
  });
};

export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async save(notification: Notification): Promise<void> {
    assertNotificationInvariants(notification);
    this.db
      .insert(notifications)
      .values({
        id: notification.id,
        channel: notification.channel,
        payload: notification.payload,
        result: notification.result,
        errorMessage: notification.errorMessage ?? null,
        adviceId: notification.adviceId ?? null,
        tacticSignalId: notification.tacticSignalId ?? null,
        sentAt: notification.sentAt,
      })
      .onConflictDoUpdate({
        target: notifications.id,
        set: {
          result: notification.result,
          errorMessage: notification.errorMessage ?? null,
        },
      })
      .run();
  }

  async findById(id: string): Promise<Notification | null> {
    const row = this.db.select().from(notifications).where(eq(notifications.id, id)).get();
    return row === undefined ? null : toNotification(row);
  }

  async listByAdvice(adviceId: string): Promise<readonly Notification[]> {
    return this.db
      .select()
      .from(notifications)
      .where(eq(notifications.adviceId, adviceId))
      .orderBy(desc(notifications.sentAt))
      .all()
      .map(toNotification);
  }

  async listBySignal(tacticSignalId: string): Promise<readonly Notification[]> {
    return this.db
      .select()
      .from(notifications)
      .where(eq(notifications.tacticSignalId, tacticSignalId))
      .orderBy(desc(notifications.sentAt))
      .all()
      .map(toNotification);
  }

  async listRecent(
    filter: {
      readonly channel?: Notification['channel'];
      readonly result?: NotificationResult;
      readonly since?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly Notification[]> {
    const conditions: SQL[] = [];
    if (filter.channel !== undefined) conditions.push(eq(notifications.channel, filter.channel));
    if (filter.result !== undefined) conditions.push(eq(notifications.result, filter.result));
    if (filter.since !== undefined) conditions.push(gte(notifications.sentAt, filter.since));
    const where = conditions.length === 0 ? undefined : and(...conditions);
    const limit = filter.limit ?? 50;
    return this.db
      .select()
      .from(notifications)
      .where(where)
      .orderBy(desc(notifications.sentAt))
      .limit(limit)
      .all()
      .map(toNotification);
  }
}
