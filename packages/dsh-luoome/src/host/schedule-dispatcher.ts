import type { Context } from '@deepseek-ai/cordis';
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule';
import type { PluginAuthorityRepository } from '@luoome/core';
import type { ConfirmablePluginTool, createPluginOperationService } from '@luoome/tools';
import type { createDshIdentity } from './dsh-identity.js';

const DELIVERY_MAX_AGE_MS = 600_000;

type Delivery = NonNullable<ScheduleCatalogEntry['lastDelivery']>;

export const createScheduleDispatcher = (
  ctx: Context,
  options: {
    readonly service: ReturnType<typeof createPluginOperationService>;
    readonly repository: PluginAuthorityRepository;
    readonly identity: ReturnType<typeof createDshIdentity>;
    readonly policies: readonly ConfirmablePluginTool[];
    readonly principalForSession: (
      sessionId: string,
    ) => { userId: string; accountId: string } | null;
    readonly automationsEnabled: boolean;
    readonly now: () => number;
  },
) => {
  const seen = new Map<string, string>();
  const pending = new Map<string, Promise<void>>();
  let disposed = false;
  let chain = Promise.resolve();

  const execute = async (task: ScheduleCatalogEntry, delivery: Delivery) => {
    const deliveryKey = `${delivery.scheduledAt}:${delivery.messageId}`;
    if (seen.get(task.id) === deliveryKey) return;
    const owner = options.principalForSession(task.sessionId);
    if (!owner) return;
    const deliveredAt = Date.parse(delivery.deliveredAt);
    const scheduledAt = Date.parse(delivery.scheduledAt);
    if (
      !Number.isFinite(deliveredAt) ||
      !Number.isFinite(scheduledAt) ||
      deliveredAt > options.now() ||
      options.now() - deliveredAt > DELIVERY_MAX_AGE_MS
    ) {
      seen.set(task.id, deliveryKey);
      return;
    }
    const grantId = `batch:${task.id}:${owner.accountId}`;
    const grant = await options.repository.findGrant(grantId, owner.userId);
    if (!grant?.enabled || !(await options.identity.validateGrant(grant))) return;
    if (scheduledAt < grant.createdAt || scheduledAt >= grant.expiresAt) {
      seen.set(task.id, deliveryKey);
      return;
    }
    const policies = new Map(
      options.policies
        .filter((policy) => policy.scheduled)
        .map((policy) => [policy.tool.name, policy]),
    );
    let completed = true;
    for (const call of grant.allowedCalls) {
      if (call.accountId !== owner.accountId || !policies.has(call.tool)) {
        completed = false;
        continue;
      }
      const result = await options.service.executeScheduled(
        grant.identity,
        {
          grantId: grant.id,
          grantVersion: grant.version,
          occurrenceId: delivery.scheduledAt,
          tool: call.tool,
          accountId: call.accountId,
          input: JSON.parse(call.inputJson),
        },
        AbortSignal.timeout(60 * 60 * 1000),
      );
      if (!result.ok) completed = false;
    }
    if (completed) seen.set(task.id, deliveryKey);
  };

  const reconcile = (): Promise<void> => {
    chain = chain.then(async () => {
      if (disposed || !options.automationsEnabled) return;
      const tasks = await ctx.schedule.catalog();
      for (const task of tasks) {
        const delivery = task.lastDelivery;
        if (!delivery) continue;
        const previous = pending.get(task.id) ?? Promise.resolve();
        const next = previous.then(() => execute(task, delivery)).catch(() => undefined);
        pending.set(task.id, next);
        await next;
      }
    });
    return chain;
  };

  const remove = ctx.on('schedule/changed', () => {
    void reconcile();
  });
  void reconcile();
  return {
    reconcile,
    dispose() {
      if (disposed) return;
      disposed = true;
      remove();
    },
  };
};
