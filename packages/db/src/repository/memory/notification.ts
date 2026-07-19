import {
  assertNotificationInvariants,
  type Notification,
  type NotificationRepository,
  type NotificationResult,
} from '@luoome/core';

/** Notification 的 in-memory 实现。Key 用 notification.id。 */
export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly items = new Map<string, Notification>();

  put(n: Notification): void {
    assertNotificationInvariants(n);
    this.items.set(n.id, n);
  }

  async save(notification: Notification): Promise<void> {
    this.put(notification);
  }

  async findById(id: string): Promise<Notification | null> {
    return this.items.get(id) ?? null;
  }

  async listByAdvice(adviceId: string): Promise<readonly Notification[]> {
    return [...this.items.values()]
      .filter((n) => n.adviceId === adviceId)
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  }

  async listBySignal(tacticSignalId: string): Promise<readonly Notification[]> {
    return [...this.items.values()]
      .filter((n) => n.tacticSignalId === tacticSignalId)
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
  }

  async listRecent(
    filter: {
      readonly channel?: Notification['channel'];
      readonly result?: NotificationResult;
      readonly since?: Date;
      readonly limit?: number;
    } = {},
  ): Promise<readonly Notification[]> {
    const sinceMs = filter.since?.getTime() ?? Number.NEGATIVE_INFINITY;
    const limit = filter.limit ?? 50;
    return [...this.items.values()]
      .filter((n) => {
        if (filter.channel !== undefined && n.channel !== filter.channel) return false;
        if (filter.result !== undefined && n.result !== filter.result) return false;
        if (n.sentAt.getTime() < sinceMs) return false;
        return true;
      })
      .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())
      .slice(0, limit);
  }
}
