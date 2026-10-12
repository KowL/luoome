import {
  AlertPlanSchema,
  assertPersonalAlertPlanLimits,
  assertReportInvariants,
  assertWatchlistMemberInvariants,
  assertWatchlistMemberSourceInvariants,
  buildPersonalMemberRemoval,
  buildWatchlistImportMutation,
  dateInShanghai,
  evaluatePersonalPriceAlerts,
  freezePersonalWatchTrigger,
  InvariantError,
  PersonalAlertEvaluationDraftSchema,
  PersonalAlertEvaluationSchema,
  PersonalAlertPlanMutationSchema,
  PersonalAlertPlanRemovalSchema,
  PersonalAlertPlanSchema,
  PersonalAlertRequestSchema,
  PersonalWatchFeedbackSchema,
  personalAlertConditionInput,
  personalAlertLeaseOwner,
  preparePersonalDeliveryMutation,
  type Report,
  ReportSchema,
  reportScopeKey,
  selectWatchlistImportStocks,
  syncPersonalDeliveryMutation,
  TenantExecutionLeaseSchema,
  type TenantExecutionRequest,
  TenantExecutionRequestSchema,
  TenantOperationReceiptSchema,
  TenantOutboxSchema,
  type TenantRepository,
  type WatchlistImportPreview,
  WatchlistImportPreviewSchema,
  WatchlistImportResultSchema,
  type WatchlistMember,
  WatchlistMemberSchema,
  type WatchlistMemberSource,
  WatchlistMemberSourceSchema,
  WatchlistRemovalResultSchema,
  WatchlistSchema,
  WatchRuleStateSchema,
  watchlistRevisionInput,
  watchlistRuleRevisionInput,
} from '@luoome/core';
import { and, desc, eq, gt, gte, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '../client.js';
import { DrizzleAlertPlanRepository } from '../repository/drizzle/alert-plan.js';
import { DrizzleWatchRuleStateRepository } from '../repository/drizzle/watch-rule-state.js';
import {
  DrizzleWatchTriggerRepository,
  toWatchTrigger,
} from '../repository/drizzle/watch-trigger.js';
import {
  alertPlans,
  reports,
  stocks,
  watchExecutionLease,
  watchlistMemberSources,
  watchlistMembers,
  watchlists,
  watchRuleStates,
  watchTriggers,
} from '../schema/index.js';
import {
  alertPlanRemovalHash,
  alertPlanRequestHash,
  factsIdentity,
  importRequestHash,
  tenantHash,
} from './tenant-memory.js';
import {
  personalAlertEvaluations,
  personalAlertPlanMutations,
  personalWatchFeedback,
  tenantExecutionLeases,
  tenantExecutionRequests,
  tenantOperationReceipts,
  tenantOutbox,
  watchlistFactsReportKeys,
  watchlistImportBatches,
  watchlistImportPreviews,
  watchlistRemovalReceipts,
} from './tenant-schema.js';

type TenantDb = Pick<DrizzleDb, 'select' | 'insert' | 'update' | 'run' | 'all'>;
const withoutNull = (row: object): object =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null));
const memberFromRow = (row: typeof watchlistMembers.$inferSelect) =>
  WatchlistMemberSchema.parse(withoutNull(row));
const sourceFromRow = (row: typeof watchlistMemberSources.$inferSelect) =>
  WatchlistMemberSourceSchema.parse(withoutNull(row));
const reportFromRow = (row: typeof reports.$inferSelect) => ReportSchema.parse(withoutNull(row));
const state = (db: TenantDb, watchlistId: string) => {
  const row = db.select().from(watchlists).where(eq(watchlists.id, watchlistId)).get();
  if (row === undefined) throw new InvariantError('个人自选不存在');
  const watchlist = WatchlistSchema.parse(withoutNull(row));
  const members = db
    .select()
    .from(watchlistMembers)
    .where(eq(watchlistMembers.watchlistId, watchlistId))
    .all()
    .map(memberFromRow);
  const memberIds = new Set(members.map((member) => member.id));
  const sources = db
    .select()
    .from(watchlistMemberSources)
    .all()
    .filter((source) => memberIds.has(source.memberId))
    .map(sourceFromRow);
  return {
    watchlist,
    members,
    sources,
    revision: tenantHash(watchlistRevisionInput(watchlist, members, sources)),
  };
};
const applyMutation = (
  db: TenantDb,
  members: readonly WatchlistMember[],
  sources: readonly WatchlistMemberSource[],
) => {
  for (const member of members) {
    assertWatchlistMemberInvariants(member);
    const row = { ...member, archivedAt: member.archivedAt ?? null };
    db.insert(watchlistMembers)
      .values(row)
      .onConflictDoUpdate({ target: watchlistMembers.id, set: row })
      .run();
  }
  for (const source of sources) {
    assertWatchlistMemberSourceInvariants(source);
    const row = {
      ...source,
      evidence: [...source.evidence],
      validUntil: source.validUntil ?? null,
    };
    db.insert(watchlistMemberSources)
      .values(row)
      .onConflictDoUpdate({ target: watchlistMemberSources.id, set: row })
      .run();
  }
};
const reportRow = (report: Report): typeof reports.$inferInsert => ({
  ...report,
  scopeKey: reportScopeKey(report.scope),
  version: report.version ?? 1,
  supersedesReportId: report.supersedesReportId ?? null,
  notificationPolicy: report.notificationPolicy ?? null,
  watchlistFactsSnapshot: report.watchlistFactsSnapshot ?? null,
  decisionReviewSnapshot: report.decisionReviewSnapshot ?? null,
});

export class DrizzleTenantRepository implements TenantRepository {
  constructor(private readonly db: DrizzleDb) {}
  async preparePersonalDelivery(input: Parameters<TenantRepository['preparePersonalDelivery']>[0]) {
    return this.db.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(watchTriggers)
          .where(eq(watchTriggers.id, input.triggerId))
          .get();
        const trigger = row === undefined ? null : toWatchTrigger(row);
        const planRow =
          trigger === null
            ? undefined
            : tx.select().from(alertPlans).where(eq(alertPlans.id, trigger.poolId)).get();
        const plan = planRow === undefined ? null : AlertPlanSchema.parse(withoutNull(planRow));
        const listRow =
          plan === null
            ? undefined
            : tx.select().from(watchlists).where(eq(watchlists.id, plan.watchlistId)).get();
        const list = listRow === undefined ? null : WatchlistSchema.parse(withoutNull(listRow));
        const member =
          list === null || trigger === null
            ? undefined
            : tx
                .select()
                .from(watchlistMembers)
                .where(
                  and(
                    eq(watchlistMembers.watchlistId, list.id),
                    eq(watchlistMembers.stockId, trigger.stockId),
                  ),
                )
                .get();
        const sources =
          member === undefined
            ? []
            : tx
                .select()
                .from(watchlistMemberSources)
                .where(eq(watchlistMemberSources.memberId, member.id))
                .all();
        const result = preparePersonalDeliveryMutation({
          ...input,
          trigger,
          plan,
          memberActive:
            list?.kind === 'personal' &&
            list.enabled &&
            member !== undefined &&
            member.stage !== 'archived' &&
            sources.some((source) => source.status !== 'ended'),
          priorTriggers: tx
            .select()
            .from(watchTriggers)
            .where(
              gte(watchTriggers.createdAt, new Date(`${dateInShanghai(input.now)}T00:00:00+08:00`)),
            )
            .all()
            .map(toWatchTrigger),
        });
        if (result.eligible && result.trigger !== null)
          new DrizzleWatchTriggerRepository(tx).put(result.trigger);
        return result;
      },
      { behavior: 'immediate' },
    );
  }
  async syncPersonalDelivery(input: Parameters<TenantRepository['syncPersonalDelivery']>[0]) {
    return this.db.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(watchTriggers)
          .where(eq(watchTriggers.id, input.triggerId))
          .get();
        const trigger = syncPersonalDeliveryMutation(
          row === undefined ? null : toWatchTrigger(row),
          input,
        );
        if (trigger !== null) new DrizzleWatchTriggerRepository(tx).put(trigger);
        return trigger;
      },
      { behavior: 'immediate' },
    );
  }
  async putExecutionRequest(request: TenantExecutionRequest) {
    const parsed = TenantExecutionRequestSchema.parse(request);
    return this.db.transaction(
      (tx) => {
        const oldRow = tx
          .select()
          .from(tenantExecutionRequests)
          .where(eq(tenantExecutionRequests.operationId, parsed.operationId))
          .get();
        if (oldRow !== undefined) {
          const old = TenantExecutionRequestSchema.parse(oldRow.request);
          if (
            old.inputHash !== parsed.inputHash ||
            old.generation !== parsed.generation ||
            old.kind !== parsed.kind ||
            tenantHash(old.input) !== tenantHash(parsed.input)
          )
            throw new InvariantError('operation input identity conflict');
          return old;
        }
        tx.insert(tenantExecutionRequests)
          .values({
            operationId: parsed.operationId,
            inputHash: parsed.inputHash,
            generation: parsed.generation,
            request: parsed,
          })
          .run();
        return parsed;
      },
      { behavior: 'immediate' },
    );
  }
  async getExecutionRequest(operationId: string) {
    const row = this.db
      .select()
      .from(tenantExecutionRequests)
      .where(eq(tenantExecutionRequests.operationId, operationId))
      .get();
    return row === undefined ? null : TenantExecutionRequestSchema.parse(row.request);
  }
  async getReceipt(operationId: string) {
    const row = this.db
      .select()
      .from(tenantOperationReceipts)
      .where(eq(tenantOperationReceipts.operationId, operationId))
      .get();
    return row === undefined ? null : TenantOperationReceiptSchema.parse(row.receipt);
  }
  async claimExecution(input: Parameters<TenantRepository['claimExecution']>[0]) {
    return this.db.transaction(
      (tx) => {
        const requestRow = tx
          .select()
          .from(tenantExecutionRequests)
          .where(eq(tenantExecutionRequests.operationId, input.operationId))
          .get();
        if (requestRow === undefined || requestRow.generation !== input.generation)
          throw new InvariantError('tenant execution generation mismatch');
        const receiptRow = tx
          .select()
          .from(tenantOperationReceipts)
          .where(eq(tenantOperationReceipts.operationId, input.operationId))
          .get();
        if (receiptRow !== undefined)
          return {
            kind: 'completed' as const,
            receipt: TenantOperationReceiptSchema.parse(receiptRow.receipt),
          };
        const oldRow = tx
          .select()
          .from(tenantExecutionLeases)
          .where(eq(tenantExecutionLeases.operationId, input.operationId))
          .get();
        const old = oldRow === undefined ? null : TenantExecutionLeaseSchema.parse(oldRow.lease);
        if (old !== null && old.expiresAt > input.now) return { kind: 'busy' as const };
        const lease = TenantExecutionLeaseSchema.parse({
          operationId: input.operationId,
          generation: input.generation,
          fence: (old?.fence ?? 0) + 1,
          attemptId: input.attemptId,
          expiresAt: new Date(input.now.getTime() + input.leaseMs),
        });
        tx.insert(tenantExecutionLeases)
          .values({ operationId: input.operationId, lease })
          .onConflictDoUpdate({ target: tenantExecutionLeases.operationId, set: { lease } })
          .run();
        return { kind: 'claimed' as const, lease };
      },
      { behavior: 'immediate' },
    );
  }
  async renewExecution(input: Parameters<TenantRepository['renewExecution']>[0]) {
    return this.db.transaction(
      (tx) => {
        const row = tx
          .select()
          .from(tenantExecutionLeases)
          .where(eq(tenantExecutionLeases.operationId, input.operationId))
          .get();
        const lease = row === undefined ? null : TenantExecutionLeaseSchema.parse(row.lease);
        if (
          lease === null ||
          lease.fence !== input.fence ||
          lease.attemptId !== input.attemptId ||
          lease.generation !== input.generation ||
          lease.expiresAt <= input.now
        )
          return false;
        tx.update(tenantExecutionLeases)
          .set({ lease: { ...lease, expiresAt: new Date(input.now.getTime() + input.leaseMs) } })
          .where(eq(tenantExecutionLeases.operationId, input.operationId))
          .run();
        return true;
      },
      { behavior: 'immediate' },
    );
  }
  async putImportPreview(preview: WatchlistImportPreview) {
    const parsed = WatchlistImportPreviewSchema.parse(preview);
    this.db.insert(watchlistImportPreviews).values({ id: parsed.id, preview: parsed }).run();
  }
  async getImportPreview(id: string) {
    const row = this.db
      .select()
      .from(watchlistImportPreviews)
      .where(eq(watchlistImportPreviews.id, id))
      .get();
    return row === undefined ? null : WatchlistImportPreviewSchema.parse(row.preview);
  }
  async getWatchlistRevision(watchlistId: string) {
    return state(this.db, watchlistId).revision;
  }
  async commitWatchlistImport(input: Parameters<TenantRepository['commitWatchlistImport']>[0]) {
    return this.db.transaction(
      (tx) => {
        const previewRow = tx
          .select()
          .from(watchlistImportPreviews)
          .where(eq(watchlistImportPreviews.id, input.previewId))
          .get();
        if (previewRow === undefined) throw new InvariantError('导入预览不存在');
        const preview = WatchlistImportPreviewSchema.parse(previewRow.preview);
        if (preview.ownerUserId !== input.ownerUserId || preview.inputHash !== input.inputHash)
          throw new InvariantError('导入预览身份不匹配');
        const operationId = `import:${preview.watchlistId}:${input.requestId}`;
        const inputHash = importRequestHash(input);
        const oldRow = tx
          .select()
          .from(watchlistImportBatches)
          .where(eq(watchlistImportBatches.operationId, operationId))
          .get();
        if (oldRow !== undefined) {
          const old = WatchlistImportResultSchema.parse(oldRow.result);
          if (old.receipt.inputHash !== inputHash)
            throw new InvariantError('import request identity conflict');
          return old;
        }
        const current = state(tx, preview.watchlistId);
        if (current.revision !== preview.watchlistRevision)
          throw new InvariantError('自选已经变化，请重新预览');
        const stockIds = selectWatchlistImportStocks(
          preview,
          input.selections,
          input.excludedRows,
          input.acknowledgeExtraColumns,
        );
        for (const stockId of stockIds)
          if (
            tx.select({ id: stocks.id }).from(stocks).where(eq(stocks.id, stockId)).get() ===
            undefined
          )
            throw new InvariantError('股票目录已经变化，请重新预览');
        const members = tx.select().from(watchlistMembers).all().map(memberFromRow);
        const sources = tx.select().from(watchlistMemberSources).all().map(sourceFromRow);
        const importBatchId = `import-${tenantHash(operationId).slice(0, 24)}`;
        const mutation = buildWatchlistImportMutation({
          watchlist: current.watchlist,
          members,
          sources,
          stockIds,
          ownerUserId: input.ownerUserId,
          importBatchId,
          maxDistinctStocks: input.maxDistinctStocks,
          now: input.now,
        });
        const body = {
          importBatchId,
          watchlistId: preview.watchlistId,
          stockIds,
          enteredCount: mutation.enteredCount,
          unchangedCount: mutation.unchangedCount,
          distinctStockCount: mutation.distinctStockCount,
        };
        const receipt = TenantOperationReceiptSchema.parse({
          operationId,
          inputHash,
          resultRef: importBatchId,
          resultHash: tenantHash(body),
          status: 'succeeded',
          committedAt: input.now,
        });
        const result = WatchlistImportResultSchema.parse({ ...body, receipt });
        applyMutation(tx, mutation.members, mutation.sources);
        tx.insert(tenantOperationReceipts).values({ operationId, receipt }).run();
        tx.insert(watchlistImportBatches)
          .values({ operationId, previewId: input.previewId, result })
          .run();
        return result;
      },
      { behavior: 'immediate' },
    );
  }
  async removePersonalMembers(input: Parameters<TenantRepository['removePersonalMembers']>[0]) {
    return this.db.transaction(
      (tx) => {
        const operationId = `remove:${input.watchlistId}:${input.requestId}`;
        const inputHash = tenantHash({
          watchlistId: input.watchlistId,
          stockIds: [...new Set(input.stockIds)].sort(),
          ownerUserId: input.ownerUserId,
        });
        const oldRow = tx
          .select()
          .from(watchlistRemovalReceipts)
          .where(eq(watchlistRemovalReceipts.operationId, operationId))
          .get();
        if (oldRow !== undefined) {
          const old = WatchlistRemovalResultSchema.parse(oldRow.result);
          if (old.receipt.inputHash !== inputHash)
            throw new InvariantError('member removal request identity conflict');
          return old;
        }
        const current = state(tx, input.watchlistId);
        if (current.watchlist.kind !== 'personal') throw new InvariantError('个人自选不存在');
        const members = current.members.filter((member) => input.stockIds.includes(member.stockId));
        if (members.length !== new Set(input.stockIds).size)
          throw new InvariantError('自选成员不存在');
        const mutation = buildPersonalMemberRemoval({
          members,
          sources: current.sources,
          ownerUserId: input.ownerUserId,
          now: input.now,
        });
        const receipt = TenantOperationReceiptSchema.parse({
          operationId,
          inputHash,
          resultRef: `remove-${tenantHash(operationId).slice(0, 24)}`,
          resultHash: tenantHash(mutation.results),
          status: 'succeeded',
          committedAt: input.now,
        });
        const result = WatchlistRemovalResultSchema.parse({ results: mutation.results, receipt });
        applyMutation(tx, mutation.members, mutation.sources);
        tx.insert(tenantOperationReceipts).values({ operationId, receipt }).run();
        tx.insert(watchlistRemovalReceipts).values({ operationId, result }).run();
        return result;
      },
      { behavior: 'immediate' },
    );
  }
  async commitFactsReport(input: Parameters<TenantRepository['commitFactsReport']>[0]) {
    return this.db.transaction(
      (tx) => {
        const requestRow = tx
          .select()
          .from(tenantExecutionRequests)
          .where(eq(tenantExecutionRequests.operationId, input.operationId))
          .get();
        if (
          requestRow === undefined ||
          requestRow.inputHash !== input.inputHash ||
          requestRow.generation !== input.generation
        )
          throw new InvariantError('operation input identity conflict');
        const request = TenantExecutionRequestSchema.parse(requestRow.request);
        if (request.kind !== 'watchlist-facts')
          throw new InvariantError('operation input identity conflict');
        const oldRow = tx
          .select()
          .from(tenantOperationReceipts)
          .where(eq(tenantOperationReceipts.operationId, input.operationId))
          .get();
        if (oldRow !== undefined) {
          const receipt = TenantOperationReceiptSchema.parse(oldRow.receipt);
          const row = tx.select().from(reports).where(eq(reports.id, receipt.resultRef)).get();
          if (row === undefined) throw new InvariantError('operation receipt target missing');
          return { report: reportFromRow(row), receipt, replayed: true };
        }
        const leaseRow = tx
          .select()
          .from(tenantExecutionLeases)
          .where(eq(tenantExecutionLeases.operationId, input.operationId))
          .get();
        const lease =
          leaseRow === undefined ? null : TenantExecutionLeaseSchema.parse(leaseRow.lease);
        if (
          lease === null ||
          lease.fence !== input.fence ||
          lease.attemptId !== input.attemptId ||
          lease.generation !== input.generation ||
          lease.expiresAt <= input.now
        )
          throw new InvariantError('tenant execution fence expired');
        const parsed = ReportSchema.parse(input.report);
        if (
          parsed.kind !== 'watchlist-facts' ||
          parsed.scope.kind !== 'watchlist' ||
          request.input.watchlistId !== parsed.scope.watchlistId ||
          request.input.period !== parsed.periodStart
        )
          throw new InvariantError('facts request scope mismatch');
        const current = state(tx, parsed.scope.watchlistId);
        const currentPlans = tx
          .select()
          .from(alertPlans)
          .where(eq(alertPlans.watchlistId, parsed.scope.watchlistId))
          .all()
          .map((row) => AlertPlanSchema.parse(withoutNull(row)));
        if (
          parsed.watchlistFactsSnapshot?.watchlistRevision !== current.revision ||
          parsed.watchlistFactsSnapshot.ruleFingerprint !==
            tenantHash(watchlistRuleRevisionInput(currentPlans))
        )
          throw new InvariantError('facts input changed before commit');
        const identity = factsIdentity(parsed);
        const oldKey = tx
          .select()
          .from(watchlistFactsReportKeys)
          .where(eq(watchlistFactsReportKeys.identity, identity))
          .get();
        const reused =
          oldKey === undefined
            ? undefined
            : tx.select().from(reports).where(eq(reports.id, oldKey.reportId)).get();
        let report: Report;
        if (reused !== undefined) report = reportFromRow(reused);
        else {
          const latest = tx
            .select()
            .from(reports)
            .where(
              and(
                eq(reports.kind, 'watchlist-facts'),
                eq(reports.scopeKey, reportScopeKey(parsed.scope)),
                eq(reports.periodStart, parsed.periodStart),
                eq(reports.periodEnd, parsed.periodEnd),
              ),
            )
            .orderBy(desc(reports.version))
            .limit(1)
            .get();
          report = ReportSchema.parse({
            ...parsed,
            version: (latest?.version ?? 0) + 1,
            supersedesReportId: latest?.id,
            notificationPolicy: latest === undefined ? input.notificationPolicy : 'never',
            deliveryStatus: 'not-requested',
          });
          assertReportInvariants(report);
        }
        const receipt = TenantOperationReceiptSchema.parse({
          operationId: input.operationId,
          inputHash: input.inputHash,
          resultRef: report.id,
          resultHash: tenantHash(report),
          status: report.status === 'partial' ? 'partial' : 'succeeded',
          committedAt: input.now,
        });
        const event = TenantOutboxSchema.parse({
          ...receipt,
          eventId: `result:${input.operationId}`,
          notificationPolicy:
            report.notificationPolicy === 'never' ? 'never' : input.notificationPolicy,
          notificationPolicyVersion: 1,
          businessKey: input.businessKey,
        });
        if (reused === undefined) {
          tx.insert(reports).values(reportRow(report)).run();
          tx.insert(watchlistFactsReportKeys).values({ identity, reportId: report.id }).run();
        }
        tx.insert(tenantOperationReceipts)
          .values({ operationId: input.operationId, receipt })
          .run();
        tx.insert(tenantOutbox)
          .values({ eventId: event.eventId, operationId: input.operationId, event })
          .run();
        return { report, receipt, replayed: reused !== undefined };
      },
      { behavior: 'immediate' },
    );
  }
  async savePersonalAlertPlan(input: Parameters<TenantRepository['savePersonalAlertPlan']>[0]) {
    return this.db.transaction(
      (tx) => {
        const operationId = `alert-plan:${input.plan.id}:${input.requestId}`;
        const inputHash = alertPlanRequestHash(input);
        const replayRow = tx
          .select()
          .from(personalAlertPlanMutations)
          .where(eq(personalAlertPlanMutations.operationId, operationId))
          .get();
        if (replayRow !== undefined) {
          const replay = PersonalAlertPlanMutationSchema.parse(replayRow.result);
          if (replay.receipt.inputHash !== inputHash)
            throw new InvariantError('alert plan request identity conflict');
          return replay;
        }
        const watchlist = state(tx, input.plan.watchlistId).watchlist;
        if (watchlist.kind !== 'personal' || !watchlist.enabled)
          throw new InvariantError('启用的个人自选不存在');
        const oldRow = tx.select().from(alertPlans).where(eq(alertPlans.id, input.plan.id)).get();
        const old = oldRow === undefined ? null : AlertPlanSchema.parse(withoutNull(oldRow));
        if ((old === null ? null : tenantHash(old)) !== input.expectedPlanRevision)
          throw new InvariantError('个人提醒修订已经变化');
        const plan = PersonalAlertPlanSchema.parse({
          ...input.plan,
          createdAt: old?.createdAt ?? input.now,
          updatedAt: input.now,
        });
        if (plan.enabled && !input.enableConfirmed)
          throw new InvariantError('启用用户价格条件需要显式确认');
        assertPersonalAlertPlanLimits({
          ...input,
          plan,
          plans: tx
            .select()
            .from(alertPlans)
            .all()
            .map((row) => AlertPlanSchema.parse(withoutNull(row))),
        });
        const planRevision = tenantHash(plan);
        const receipt = TenantOperationReceiptSchema.parse({
          operationId,
          inputHash,
          resultRef: `personal-plan:${tenantHash(operationId).slice(0, 24)}`,
          resultHash: tenantHash({ plan, planRevision }),
          status: 'succeeded',
          committedAt: input.now,
        });
        const result = PersonalAlertPlanMutationSchema.parse({ plan, planRevision, receipt });
        if (
          old !== null &&
          personalAlertConditionInput(old) !== personalAlertConditionInput(plan)
        ) {
          tx.delete(watchRuleStates).where(eq(watchRuleStates.poolId, plan.id)).run();
          tx.update(watchTriggers)
            .set({ deliveryStatus: 'invalidated', deliveryCompletedAt: input.now, notified: false })
            .where(
              and(eq(watchTriggers.poolId, plan.id), eq(watchTriggers.deliveryStatus, 'pending')),
            )
            .run();
        }
        new DrizzleAlertPlanRepository(tx).put(plan);
        tx.insert(personalAlertPlanMutations).values({ operationId, result }).run();
        tx.insert(tenantOperationReceipts).values({ operationId, receipt }).run();
        return result;
      },
      { behavior: 'immediate' },
    );
  }
  async removePersonalAlertPlan(input: Parameters<TenantRepository['removePersonalAlertPlan']>[0]) {
    return this.db.transaction(
      (tx) => {
        const operationId = `alert-plan-remove:${input.alertPlanId}:${input.requestId}`;
        const inputHash = alertPlanRemovalHash(input);
        const replayRow = tx
          .select()
          .from(personalAlertPlanMutations)
          .where(eq(personalAlertPlanMutations.operationId, operationId))
          .get();
        if (replayRow !== undefined) {
          const replay = PersonalAlertPlanRemovalSchema.parse(replayRow.result);
          if (replay.receipt.inputHash !== inputHash)
            throw new InvariantError('alert plan request identity conflict');
          return replay;
        }
        const oldRow = tx
          .select()
          .from(alertPlans)
          .where(eq(alertPlans.id, input.alertPlanId))
          .get();
        if (oldRow === undefined) throw new InvariantError('个人提醒不存在');
        const old = AlertPlanSchema.parse(withoutNull(oldRow));
        if (state(tx, old.watchlistId).watchlist.kind !== 'personal')
          throw new InvariantError('个人提醒不存在');
        if (tenantHash(old) !== input.expectedPlanRevision)
          throw new InvariantError('个人提醒修订已经变化');
        const receipt = TenantOperationReceiptSchema.parse({
          operationId,
          inputHash,
          resultRef: `personal-plan:${tenantHash(operationId).slice(0, 24)}`,
          resultHash: tenantHash({ alertPlanId: input.alertPlanId }),
          status: 'succeeded',
          committedAt: input.now,
        });
        const result = PersonalAlertPlanRemovalSchema.parse({
          alertPlanId: input.alertPlanId,
          receipt,
        });
        tx.delete(watchRuleStates).where(eq(watchRuleStates.poolId, input.alertPlanId)).run();
        tx.update(watchTriggers)
          .set({ deliveryStatus: 'invalidated', deliveryCompletedAt: input.now, notified: false })
          .where(
            and(
              eq(watchTriggers.poolId, input.alertPlanId),
              eq(watchTriggers.deliveryStatus, 'pending'),
            ),
          )
          .run();
        tx.delete(alertPlans).where(eq(alertPlans.id, input.alertPlanId)).run();
        tx.insert(personalAlertPlanMutations).values({ operationId, result }).run();
        tx.insert(tenantOperationReceipts).values({ operationId, receipt }).run();
        return result;
      },
      { behavior: 'immediate' },
    );
  }
  async getPersonalAlertEvaluation(resultRef: string) {
    const row = this.db
      .select()
      .from(personalAlertEvaluations)
      .where(eq(personalAlertEvaluations.id, resultRef))
      .get();
    return row === undefined ? null : PersonalAlertEvaluationSchema.parse(row.evaluation);
  }
  async commitPersonalAlertEvaluation(
    input: Parameters<TenantRepository['commitPersonalAlertEvaluation']>[0],
  ) {
    return this.db.transaction(
      (tx) => {
        const requestRow = tx
          .select()
          .from(tenantExecutionRequests)
          .where(eq(tenantExecutionRequests.operationId, input.operationId))
          .get();
        if (
          requestRow === undefined ||
          requestRow.inputHash !== input.inputHash ||
          requestRow.generation !== input.generation
        )
          throw new InvariantError('operation input identity conflict');
        const request = TenantExecutionRequestSchema.parse(requestRow.request);
        if (request.kind !== 'watch-alerts')
          throw new InvariantError('operation input identity conflict');
        const receiptRow = tx
          .select()
          .from(tenantOperationReceipts)
          .where(eq(tenantOperationReceipts.operationId, input.operationId))
          .get();
        if (receiptRow !== undefined) {
          const receipt = TenantOperationReceiptSchema.parse(receiptRow.receipt);
          const row = tx
            .select()
            .from(personalAlertEvaluations)
            .where(eq(personalAlertEvaluations.id, receipt.resultRef))
            .get();
          if (row === undefined) throw new InvariantError('operation receipt target missing');
          return {
            evaluation: PersonalAlertEvaluationSchema.parse(row.evaluation),
            receipt,
            replayed: true,
          };
        }
        const leaseRow = tx
          .select()
          .from(tenantExecutionLeases)
          .where(eq(tenantExecutionLeases.operationId, input.operationId))
          .get();
        const lease =
          leaseRow === undefined ? null : TenantExecutionLeaseSchema.parse(leaseRow.lease);
        if (
          lease === null ||
          lease.fence !== input.fence ||
          lease.attemptId !== input.attemptId ||
          lease.generation !== input.generation ||
          lease.expiresAt <= input.now
        )
          throw new InvariantError('tenant execution fence expired');
        const frozen = PersonalAlertRequestSchema.parse(request.input);
        if (frozen.period !== dateInShanghai(input.now))
          throw new InvariantError('personal alert period expired');
        const draft = PersonalAlertEvaluationDraftSchema.parse(input.draft);
        if (
          draft.domainLeaseOwner !==
            personalAlertLeaseOwner(input.operationId, input.attemptId, input.fence) ||
          draft.evaluatedAt > input.now
        )
          throw new InvariantError('personal alert domain lease identity mismatch');
        const domainLease = tx
          .select()
          .from(watchExecutionLease)
          .where(
            and(
              eq(watchExecutionLease.owner, draft.domainLeaseOwner),
              gt(watchExecutionLease.until, input.now),
            ),
          )
          .get();
        if (domainLease === undefined)
          throw new InvariantError('personal alert domain lease expired');
        const current = state(tx, frozen.watchlistId);
        const currentPlans = tx
          .select()
          .from(alertPlans)
          .where(and(eq(alertPlans.watchlistId, frozen.watchlistId), eq(alertPlans.enabled, true)))
          .all()
          .map((row) => AlertPlanSchema.parse(withoutNull(row)));
        if (
          current.revision !== frozen.watchlistRevision ||
          tenantHash(watchlistRuleRevisionInput(currentPlans)) !== frozen.ruleFingerprint
        )
          throw new InvariantError('personal alert input changed before commit');
        const planIds = new Set(currentPlans.map((plan) => plan.id));
        const previousStates = tx
          .select()
          .from(watchRuleStates)
          .all()
          .filter((row) => planIds.has(row.poolId))
          .map((row) => WatchRuleStateSchema.parse(withoutNull(row)));
        const priorTriggers = tx
          .select()
          .from(watchTriggers)
          .where(gte(watchTriggers.createdAt, new Date(input.now.getTime() - 172_800_000)))
          .orderBy(desc(watchTriggers.createdAt))
          .limit(100_000)
          .all()
          .map(toWatchTrigger);
        const mutation = evaluatePersonalPriceAlerts({
          operationId: input.operationId,
          mode: 'formal',
          request: frozen,
          ...draft,
          states: previousStates,
          priorTriggers,
          now: input.now,
        });
        const evaluation = PersonalAlertEvaluationSchema.parse(mutation.evaluation);
        const receipt = TenantOperationReceiptSchema.parse({
          operationId: input.operationId,
          inputHash: input.inputHash,
          resultRef: evaluation.id,
          resultHash: tenantHash(evaluation),
          status: evaluation.status === 'partial' ? 'partial' : 'succeeded',
          committedAt: input.now,
        });
        const event = TenantOutboxSchema.parse({
          ...receipt,
          eventId: `result:${input.operationId}`,
          notificationPolicy: 'never',
          notificationPolicyVersion: 1,
          businessKey: `watch-alerts:${input.operationId}`,
          deliveries: evaluation.triggers
            .filter((trigger) => trigger.deliveryStatus === 'pending')
            .map((trigger) => ({
              businessKey: `watch-trigger:${trigger.id}`,
              resultRef: trigger.id,
              notificationPolicy: 'eligible',
            })),
        });
        const triggerRepository = new DrizzleWatchTriggerRepository(tx);
        const stateRepository = new DrizzleWatchRuleStateRepository(tx);
        for (const trigger of evaluation.triggers) triggerRepository.put(trigger);
        for (const row of mutation.states) stateRepository.put(row);
        tx.insert(personalAlertEvaluations)
          .values({ id: evaluation.id, operationId: input.operationId, evaluation })
          .run();
        tx.insert(tenantOperationReceipts)
          .values({ operationId: input.operationId, receipt })
          .run();
        tx.insert(tenantOutbox)
          .values({ eventId: event.eventId, operationId: input.operationId, event })
          .run();
        return { evaluation, receipt, replayed: false };
      },
      { behavior: 'immediate' },
    );
  }
  async listOutbox(limit = 100) {
    return this.db
      .select()
      .from(tenantOutbox)
      .where(isNull(tenantOutbox.acknowledgedAt))
      .limit(limit)
      .all()
      .map((row) => TenantOutboxSchema.parse(row.event));
  }
  async ackOutbox(eventId: string, now: Date) {
    this.db
      .update(tenantOutbox)
      .set({ acknowledgedAt: now })
      .where(eq(tenantOutbox.eventId, eventId))
      .run();
  }
  async recordPersonalFeedback(input: Parameters<TenantRepository['recordPersonalFeedback']>[0]) {
    return this.db.transaction(
      (tx) => {
        const oldRow = tx
          .select()
          .from(personalWatchFeedback)
          .where(
            and(
              eq(personalWatchFeedback.triggerId, input.triggerId),
              eq(personalWatchFeedback.requestId, input.requestId),
            ),
          )
          .get();
        if (oldRow !== undefined) {
          const old = PersonalWatchFeedbackSchema.parse(oldRow.feedback);
          if (old.inputHash !== input.inputHash)
            throw new InvariantError('personal feedback request identity conflict');
          return old;
        }
        const latestRow = tx
          .select()
          .from(personalWatchFeedback)
          .where(eq(personalWatchFeedback.triggerId, input.triggerId))
          .orderBy(desc(personalWatchFeedback.revision))
          .limit(1)
          .get();
        const latest =
          latestRow === undefined ? null : PersonalWatchFeedbackSchema.parse(latestRow.feedback);
        if ((latest?.revision ?? 0) !== input.expectedRevision)
          throw new InvariantError('personal feedback revision changed');
        const triggerRow =
          latest === null
            ? tx.select().from(watchTriggers).where(eq(watchTriggers.id, input.triggerId)).get()
            : null;
        const trigger =
          latest?.triggerSnapshot ??
          (triggerRow === undefined || triggerRow === null ? null : toWatchTrigger(triggerRow));
        if (
          trigger === null ||
          trigger.direction !== 'watch' ||
          (trigger.ruleKind !== 'price-level' && trigger.ruleKind !== 'price-change')
        )
          throw new InvariantError('个人提醒不存在');
        const revision = PersonalWatchFeedbackSchema.parse({
          triggerId: input.triggerId,
          triggerSnapshot: freezePersonalWatchTrigger(trigger),
          revision: input.expectedRevision + 1,
          rating: input.rating,
          note: input.note,
          recordedAt: input.now,
          requestId: input.requestId,
          inputHash: input.inputHash,
        });
        tx.insert(personalWatchFeedback)
          .values({
            triggerId: input.triggerId,
            revision: revision.revision,
            requestId: input.requestId,
            feedback: revision,
          })
          .run();
        return revision;
      },
      { behavior: 'immediate' },
    );
  }
  async listPersonalFeedback(triggerId: string) {
    return this.db
      .select()
      .from(personalWatchFeedback)
      .where(eq(personalWatchFeedback.triggerId, triggerId))
      .orderBy(personalWatchFeedback.revision)
      .all()
      .map((row) => PersonalWatchFeedbackSchema.parse(row.feedback));
  }
  async listAllPersonalFeedback() {
    return this.db
      .select()
      .from(personalWatchFeedback)
      .orderBy(personalWatchFeedback.triggerId, personalWatchFeedback.revision)
      .all()
      .map((row) => PersonalWatchFeedbackSchema.parse(row.feedback));
  }
}
