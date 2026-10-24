import {
  dateInShanghai,
  defaultWatchNotificationSettings,
  InvariantError,
  type WatchDeliveryIntent,
  WatchDeliveryIntentSchema,
  type WatchDeliveryRepository,
  type WatchNotificationSettings,
  WatchNotificationSettingsSchema,
  type WatchTrigger,
} from '@luoome/core';

export interface WatchDeliveryStorage {
  transaction<T>(run: () => T): T;
  settings(): WatchNotificationSettings | null;
  putSettings(settings: WatchNotificationSettings): void;
  list(): WatchDeliveryIntent[];
  get(id: string): WatchDeliveryIntent | null;
  put(intent: WatchDeliveryIntent): void;
  owns(owner: string, now: Date): boolean;
  trigger(id: string): WatchTrigger | null;
  eligible(trigger: WatchTrigger, now: Date): boolean;
}

export const watchDeliveryId = (triggerId: string): string => `watch:${triggerId}`;

export const createWatchDeliveryRepository = (
  store: WatchDeliveryStorage,
): WatchDeliveryRepository => {
  const settings = () => store.settings() ?? defaultWatchNotificationSettings();
  return {
    settings: async () => structuredClone(settings()),
    saveSettings: async (input) =>
      store.transaction(() => {
        const previous = settings();
        if (previous.revision !== input.expectedRevision)
          throw new InvariantError('notification preferences revision conflict');
        const changed =
          previous.webhookUrl !== input.webhookUrl ||
          previous.enabled !== input.enabled ||
          JSON.stringify(previous.quietHours) !== JSON.stringify(input.quietHours);
        const next = WatchNotificationSettingsSchema.parse({
          ...input,
          revision: previous.revision + 1,
          bindingVersion: previous.bindingVersion + (changed ? 1 : 0),
        });
        store.putSettings(next);
        for (const intent of store.list()) {
          if (changed && ['pending', 'failed'].includes(intent.state))
            store.put({
              ...intent,
              state: 'suppressed',
              errorKind: 'binding-changed',
              updatedAt: input.now,
            });
        }
        return next;
      }),
    prepare: async (input) =>
      store.transaction(() => {
        if (!store.owns(input.owner, input.now)) return false;
        const binding = settings();
        for (const triggerId of input.triggerIds) {
          const id = watchDeliveryId(triggerId);
          const existing = store.get(id);
          if (existing !== null) {
            if (existing.tenantId !== input.tenantId || existing.generation !== input.generation)
              throw new InvariantError('watch delivery tenant identity conflict');
            continue;
          }
          const trigger = store.trigger(triggerId);
          if (trigger === null) throw new InvariantError('watch delivery trigger missing');
          store.put(
            WatchDeliveryIntentSchema.parse({
              id,
              tenantId: input.tenantId,
              generation: input.generation,
              businessKey: id,
              resultRef: trigger.id,
              channel: 'feishu',
              bindingVersion: binding.bindingVersion,
              state: 'pending',
              attempt: 0,
              attemptId: null,
              executionOwner: input.owner,
              notificationId: null,
              providerMessageId: null,
              availableAt: input.now,
              expiresAt: new Date(
                new Date(`${dateInShanghai(trigger.createdAt)}T00:00:00+08:00`).getTime() +
                  86_400_000,
              ),
              deliveredAt: null,
              errorKind: null,
              createdAt: trigger.createdAt,
              updatedAt: input.now,
            }),
          );
        }
        return true;
      }),
    claim: async (input) =>
      store.transaction(() => {
        if (!store.owns(input.owner, input.now)) return null;
        const binding = settings();
        const intents = input.triggerIds.map((id) => store.get(watchDeliveryId(id)));
        for (const intent of intents) {
          if (intent === null) throw new InvariantError('watch delivery was not prepared');
          const trigger = store.trigger(intent.resultRef);
          if (trigger === null) throw new InvariantError('watch delivery trigger missing');
          if (
            !binding.enabled ||
            binding.bindingVersion !== intent.bindingVersion ||
            intent.expiresAt <= input.now ||
            !store.eligible(trigger, input.now)
          ) {
            if (['pending', 'failed'].includes(intent.state))
              store.put({
                ...intent,
                state: 'suppressed',
                errorKind: 'conditions-changed',
                updatedAt: input.now,
              });
            return null;
          }
          if (
            !['pending', 'failed'].includes(intent.state) ||
            intent.availableAt > input.now ||
            intent.attempt >= 3
          )
            return null;
        }
        return intents.map((entry) => {
          const intent = entry as WatchDeliveryIntent;
          const next = {
            ...intent,
            state: 'sending' as const,
            attempt: intent.attempt + 1,
            attemptId: input.attemptId,
            executionOwner: input.owner,
            updatedAt: input.now,
          };
          store.put(next);
          return next;
        });
      }),
    complete: async (input) =>
      store.transaction(() => {
        if (!store.owns(input.owner, input.now)) return false;
        const intents = input.triggerIds.map((id) => store.get(watchDeliveryId(id)));
        if (
          intents.some(
            (intent) =>
              intent === null ||
              intent.state !== 'sending' ||
              intent.attemptId !== input.attemptId ||
              intent.executionOwner !== input.owner,
          )
        )
          return false;
        for (const entry of intents) {
          const intent = entry as WatchDeliveryIntent;
          store.put({
            ...intent,
            state: input.state,
            notificationId: input.notificationId,
            errorKind: input.errorKind,
            availableAt: new Date(input.now.getTime() + (intent.attempt === 1 ? 60_000 : 300_000)),
            updatedAt: input.now,
          });
        }
        return true;
      }),
    recover: async (owner, now) =>
      store.transaction(() => {
        if (!store.owns(owner, now)) return [];
        const binding = settings();
        for (const intent of store.list()) {
          if (intent.state === 'sending' && intent.executionOwner !== owner) {
            // 飞书无法核验一次中断发送是否已经受理；未知结果不能自动重发。
            store.put({
              ...intent,
              state: 'unknown',
              errorKind: 'interrupted-send',
              updatedAt: now,
            });
          } else if (['pending', 'failed'].includes(intent.state)) {
            const trigger = store.trigger(intent.resultRef);
            if (trigger === null) throw new InvariantError('watch delivery trigger missing');
            if (
              !binding.enabled ||
              binding.bindingVersion !== intent.bindingVersion ||
              intent.expiresAt <= now ||
              !store.eligible(trigger, now)
            ) {
              store.put({
                ...intent,
                state: 'suppressed',
                errorKind: 'conditions-changed',
                updatedAt: now,
              });
            }
          }
        }
        return store.list();
      }),
    list: async () => structuredClone(store.list()),
    suppressPending: async (reason, now) =>
      store.transaction(() => {
        let count = 0;
        for (const intent of store.list())
          if (['pending', 'failed'].includes(intent.state)) {
            store.put({ ...intent, state: 'suppressed', errorKind: reason, updatedAt: now });
            count += 1;
          }
        return count;
      }),
  };
};
