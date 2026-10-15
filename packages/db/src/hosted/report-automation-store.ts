import {
  assertReportInvariants,
  dateInShanghai,
  InvariantError,
  type Report,
  type ReportAutomationRepository,
  type ReportDeliveryIntent,
  ReportDeliveryIntentSchema,
  type ReportExecutionLease,
  type WatchNotificationSettings,
} from '@luoome/core';

export interface ReportAutomationStorage {
  transaction<T>(run: () => T): T;
  lease(): ReportExecutionLease | null;
  putLease(lease: ReportExecutionLease): void;
  settings(): WatchNotificationSettings;
  report(id: string): Report | null;
  period(report: Report): Report | null;
  insert(report: Report): void;
  project(report: Report): void;
  intents(): ReportDeliveryIntent[];
  intent(reportId: string): ReportDeliveryIntent | null;
  put(intent: ReportDeliveryIntent): void;
}

export const createReportAutomationRepository = (
  store: ReportAutomationStorage,
): ReportAutomationRepository => {
  const owns = (owner: string, now: Date) => {
    const lease = store.lease();
    return lease?.owner === owner && lease.until > now;
  };
  const reportFor = (id: string) => {
    const report = store.report(id);
    if (report === null) throw new InvariantError('report delivery target missing');
    return report;
  };
  const valid = (intent: ReportDeliveryIntent, now: Date) => {
    const settings = store.settings();
    return (
      settings.enabled &&
      settings.bindingVersion === intent.bindingVersion &&
      intent.expiresAt > now &&
      reportFor(intent.resultRef).notificationPolicy !== 'never'
    );
  };
  const put = (intent: ReportDeliveryIntent) => {
    store.put(intent);
    const report = reportFor(intent.resultRef);
    const deliveryStatus =
      intent.state === 'accepted'
        ? 'sent'
        : intent.state === 'unknown'
          ? 'unverifiable'
          : intent.state === 'suppressed'
            ? intent.errorKind === 'fallback-log'
              ? 'fallback-log'
              : 'invalidated'
            : intent.state === 'failed'
              ? 'failed'
              : 'pending';
    store.project({ ...report, deliveryStatus, updatedAt: intent.updatedAt });
  };
  return {
    execution: async (action, owner, now) =>
      store.transaction(() => {
        const lease = store.lease();
        if (action === 'release') {
          if (lease?.owner === owner) store.putLease({ ...lease, until: now });
          return false;
        }
        if (action === 'renew') {
          if (!owns(owner, now)) return false;
        } else if (lease !== null && (lease.until > now || lease.nextTickAt > now)) return false;
        store.putLease({
          owner,
          until: new Date(now.getTime() + 120_000),
          nextTickAt:
            action === 'renew' && lease !== null
              ? lease.nextTickAt
              : new Date((Math.floor(now.getTime() / 60_000) + 1) * 60_000),
        });
        return true;
      }),
    commit: async (report, owner, now) =>
      store.transaction(() => {
        if (!owns(owner, now)) return null;
        assertReportInvariants(report);
        if (
          !['opening', 'closing'].includes(report.kind) ||
          (report.version ?? 1) !== 1 ||
          report.periodStart !== report.periodEnd ||
          report.periodEnd !== dateInShanghai(now)
        )
          throw new InvariantError('hosted report must be a current-day main report');
        const previous = store.period(report);
        if (previous !== null) return previous;
        store.insert(report);
        return reportFor(report.id);
      }),
    prepare: async (input) =>
      store.transaction(() => {
        if (!owns(input.owner, input.now)) return false;
        const report = reportFor(input.reportId);
        const previous = store.intent(report.id);
        if (previous !== null) {
          if (previous.tenantId !== input.tenantId || previous.generation !== input.generation)
            throw new InvariantError('report delivery tenant identity conflict');
          return true;
        }
        if (
          report.notificationPolicy === 'never' ||
          ['sent', 'fallback-log', 'unverifiable', 'invalidated'].includes(report.deliveryStatus)
        )
          return false;
        const id = `report:${report.id}`;
        put(
          ReportDeliveryIntentSchema.parse({
            id,
            businessKey: id,
            tenantId: input.tenantId,
            generation: input.generation,
            resultRef: report.id,
            channel: 'feishu',
            bindingVersion: store.settings().bindingVersion,
            state: 'pending',
            attempt: 0,
            attemptId: null,
            executionOwner: input.owner,
            notificationId: null,
            providerMessageId: null,
            availableAt: input.now,
            expiresAt: new Date(
              new Date(`${report.periodEnd}T00:00:00+08:00`).getTime() + 86_400_000,
            ),
            deliveredAt: null,
            errorKind: null,
            createdAt: input.now,
            updatedAt: input.now,
          }),
        );
        return true;
      }),
    claim: async (reportId, owner, attemptId, now) =>
      store.transaction(() => {
        if (!owns(owner, now)) return null;
        const intent = store.intent(reportId);
        if (intent === null) throw new InvariantError('report delivery was not prepared');
        if (!['pending', 'failed'].includes(intent.state)) return null;
        if (!valid(intent, now)) {
          put({ ...intent, state: 'suppressed', errorKind: 'conditions-changed', updatedAt: now });
          return null;
        }
        if (intent.availableAt > now || intent.attempt >= 3) return null;
        const next = {
          ...intent,
          state: 'sending' as const,
          executionOwner: owner,
          attemptId,
          attempt: intent.attempt + 1,
          updatedAt: now,
        };
        put(next);
        return next;
      }),
    complete: async (input) =>
      store.transaction(() => {
        if (!owns(input.owner, input.now)) return false;
        const intent = store.intent(input.reportId);
        if (
          intent === null ||
          intent.state !== 'sending' ||
          intent.executionOwner !== input.owner ||
          intent.attemptId !== input.attemptId
        )
          return false;
        put({
          ...intent,
          state: input.state,
          notificationId: input.notificationId,
          errorKind: input.errorKind,
          availableAt: new Date(input.now.getTime() + (intent.attempt === 1 ? 60_000 : 300_000)),
          updatedAt: input.now,
        });
        return true;
      }),
    recover: async (owner, now) =>
      store.transaction(() => {
        if (!owns(owner, now)) return;
        for (const intent of store.intents()) {
          if (intent.state === 'sending' && intent.executionOwner !== owner)
            put({ ...intent, state: 'unknown', errorKind: 'interrupted-send', updatedAt: now });
          else if (['pending', 'failed'].includes(intent.state) && !valid(intent, now))
            put({
              ...intent,
              state: 'suppressed',
              errorKind: 'conditions-changed',
              updatedAt: now,
            });
        }
      }),
    suppressPending: async (reason, now) =>
      store.transaction(() => {
        let count = 0;
        for (const intent of store.intents())
          if (['pending', 'failed'].includes(intent.state)) {
            put({ ...intent, state: 'suppressed', errorKind: reason, updatedAt: now });
            count += 1;
          }
        return count;
      }),
    list: async () => structuredClone(store.intents()),
  };
};
