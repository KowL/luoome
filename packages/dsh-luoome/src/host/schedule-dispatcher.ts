import type { Context } from '@deepseek-ai/cordis';
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule';
import type { PluginAuthorityRepository } from '@luoome/core';
import type { createPluginOperationService } from '@luoome/tools';
import { dispatchOutcome } from './dispatch-outcome.js';
import type { createDshIdentity } from './dsh-identity.js';
import { type AutomationTier, tierAllowsDispatch } from './production-config.js';

const DELIVERY_MAX_AGE_MS = 600_000;

type Delivery = NonNullable<ScheduleCatalogEntry['lastDelivery']>;

export const createScheduleDispatcher = (
  ctx: Context,
  options: {
    readonly service: ReturnType<typeof createPluginOperationService>;
    readonly repository: PluginAuthorityRepository;
    readonly identity: ReturnType<typeof createDshIdentity>;
    readonly principalForSession: (
      sessionId: string,
    ) => { userId: string; accountId: string } | null;
    readonly automationTier: AutomationTier;
    readonly resolveAutomationTier?: () => Promise<{ readonly tier: AutomationTier }>;
    readonly now: () => number;
    /**
     * 今天是否交易日（REQ-M4-06 ⑤）。
     *
     * 非交易日**不派发**——这是 PRD 明文要求「非交易日返回 skipped 且事实表零写入」。
     * 缺省 `true`（既有装配行为不变）；装配方注入真实的交易日判断。
     */
    readonly isTradingDay?: () => boolean;
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
    let completed = true;
    for (const call of grant.allowedCalls) {
      if (call.accountId !== owner.accountId) {
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
    chain = chain
      .then(async () => {
        if (disposed) return;
        // 派发前先分类：档位关闭 / 非交易日 都不执行，但**原因不同**（见 `dispatch-outcome`）。
        const outcome = dispatchOutcome({
          tierAllowsDispatch: tierAllowsDispatch(
            (await options.resolveAutomationTier?.())?.tier ?? options.automationTier,
          ),
          isTradingDay: options.isTradingDay?.() ?? true,
        });
        if (outcome.status === 'skipped') return;
        const tasks = await ctx.schedule.catalog();
        for (const task of tasks) {
          const delivery = task.lastDelivery;
          if (!delivery) continue;
          const previous = pending.get(task.id) ?? Promise.resolve();
          const next = previous.then(() => execute(task, delivery)).catch(() => undefined);
          pending.set(task.id, next);
          await next;
        }
      })
      .catch(() => undefined);
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
