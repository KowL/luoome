import { createHash } from 'node:crypto';
import {
  assertPersonalAlertPlanLimits,
  assertReportInvariants,
  buildPersonalMemberRemoval,
  buildWatchlistImportMutation,
  dateInShanghai,
  evaluatePersonalPriceAlerts,
  freezePersonalWatchTrigger,
  InvariantError,
  type PersonalAlertEvaluation,
  PersonalAlertEvaluationDraftSchema,
  PersonalAlertEvaluationSchema,
  PersonalAlertPlanConfigSchema,
  type PersonalAlertPlanMutation,
  PersonalAlertPlanMutationSchema,
  type PersonalAlertPlanRemoval,
  PersonalAlertPlanRemovalSchema,
  PersonalAlertPlanSchema,
  PersonalAlertRequestSchema,
  PersonalOperationReceiptSchema,
  type PersonalRepository,
  type PersonalWatchFeedback,
  PersonalWatchFeedbackSchema,
  personalAlertConditionInput,
  personalAlertLeaseOwner,
  preparePersonalDeliveryMutation,
  type Report,
  ReportSchema,
  reportScopeKey,
  type StockRepository,
  selectWatchlistImportStocks,
  syncPersonalDeliveryMutation,
  type WatchlistImportPreview,
  WatchlistImportPreviewSchema,
  type WatchlistImportResult,
  WatchlistImportResultSchema,
  type WatchlistRemovalResult,
  WatchlistRemovalResultSchema,
  watchlistRevisionInput,
  watchlistRuleRevisionInput,
} from '@luoome/core';
import type { InMemoryAlertPlanRepository } from '../repository/memory/alert-plan.js';
import type { InMemoryReportRepository } from '../repository/memory/report.js';
import type { InMemoryWatchRuleStateRepository } from '../repository/memory/watch-rule-state.js';
import type { InMemoryWatchTriggerRepository } from '../repository/memory/watch-trigger.js';
import type {
  InMemoryWatchlistMemberRepository,
  InMemoryWatchlistRepository,
} from '../repository/memory/watchlist.js';
import { MemoryWriteLock } from '../repository/memory/write-lock.js';

export const stableHash = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const importRequestHash = (
  input: Parameters<PersonalRepository['commitWatchlistImport']>[0],
): string =>
  stableHash({
    previewId: input.previewId,
    inputHash: input.inputHash,
    ownerUserId: input.ownerUserId,
    selections: [...input.selections].sort((a, b) => a.row - b.row),
    excludedRows: [...input.excludedRows].sort((a, b) => a - b),
    acknowledgeExtraColumns: input.acknowledgeExtraColumns,
  });
export const factsIdentity = (report: Report): string =>
  JSON.stringify([
    reportScopeKey(report.scope),
    report.periodStart,
    report.periodEnd,
    report.watchlistFactsSnapshot?.inputFingerprint,
    report.watchlistFactsSnapshot?.rendererVersion,
  ]);
export const factsReceipt = (operationId: string, inputHash: string, report: Report) =>
  PersonalOperationReceiptSchema.parse({
    operationId,
    inputHash,
    resultRef: report.id,
    resultHash: stableHash(report),
    status: report.status === 'partial' ? 'partial' : 'succeeded',
    committedAt: report.createdAt,
  });
export const personalAlertReceipt = (
  operationId: string,
  inputHash: string,
  evaluation: PersonalAlertEvaluation,
) =>
  PersonalOperationReceiptSchema.parse({
    operationId,
    inputHash,
    resultRef: evaluation.id,
    resultHash: stableHash(evaluation),
    status: evaluation.status === 'partial' ? 'partial' : 'succeeded',
    committedAt: evaluation.evaluatedAt,
  });
export const alertPlanRequestHash = (
  input: Parameters<PersonalRepository['savePersonalAlertPlan']>[0],
): string =>
  stableHash({
    plan: PersonalAlertPlanConfigSchema.parse(input.plan),
    expectedPlanRevision: input.expectedPlanRevision,
    enableConfirmed: input.enableConfirmed,
  });
export const alertPlanRemovalHash = (
  input: Parameters<PersonalRepository['removePersonalAlertPlan']>[0],
): string =>
  stableHash({ alertPlanId: input.alertPlanId, expectedPlanRevision: input.expectedPlanRevision });

export class InMemoryPersonalRepository implements PersonalRepository {
  private readonly previews = new Map<string, WatchlistImportPreview>();
  private readonly imports = new Map<string, WatchlistImportResult>();
  private readonly removals = new Map<string, WatchlistRemovalResult>();
  private readonly facts = new Map<string, string>();
  private readonly feedback = new Map<string, PersonalWatchFeedback[]>();
  private readonly planMutations = new Map<
    string,
    PersonalAlertPlanMutation | PersonalAlertPlanRemoval
  >();
  private readonly alertEvaluations = new Map<string, PersonalAlertEvaluation>();
  private readonly lock = new MemoryWriteLock();

  constructor(
    private readonly repos: {
      watchlist: InMemoryWatchlistRepository;
      watchlistMember: InMemoryWatchlistMemberRepository;
      report: InMemoryReportRepository;
      stock: StockRepository;
      watchTrigger: InMemoryWatchTriggerRepository;
      alertPlan: InMemoryAlertPlanRepository;
      watchRuleState: InMemoryWatchRuleStateRepository;
    },
  ) {}

  async preparePersonalDelivery(
    input: Parameters<PersonalRepository['preparePersonalDelivery']>[0],
  ) {
    return this.lock.run(async () => {
      const trigger = await this.repos.watchTrigger.findById(input.triggerId);
      const plan = trigger === null ? null : await this.repos.alertPlan.findById(trigger.poolId);
      const list = plan === null ? null : await this.repos.watchlist.findById(plan.watchlistId);
      const member =
        list === null || trigger === null
          ? null
          : await this.repos.watchlistMember.findMember(list.id, trigger.stockId);
      const sources =
        member === null ? [] : await this.repos.watchlistMember.listSources(member.id);
      const result = preparePersonalDeliveryMutation({
        ...input,
        trigger,
        plan,
        memberActive:
          list?.kind === 'personal' &&
          list.enabled &&
          member !== null &&
          member.stage !== 'archived' &&
          sources.some((source) => source.status !== 'ended'),
        priorTriggers: this.repos.watchTrigger.snapshotForExport(),
      });
      if (result.eligible && result.trigger !== null) this.repos.watchTrigger.put(result.trigger);
      return result;
    });
  }
  async syncPersonalDelivery(input: Parameters<PersonalRepository['syncPersonalDelivery']>[0]) {
    return this.lock.run(async () => {
      const trigger = syncPersonalDeliveryMutation(
        await this.repos.watchTrigger.findById(input.triggerId),
        input,
      );
      if (trigger !== null) this.repos.watchTrigger.put(trigger);
      return trigger;
    });
  }

  private watchlistState(watchlistId: string) {
    const watchlist = this.repos.watchlist
      .snapshotForExport()
      .find((item) => item.id === watchlistId);
    if (watchlist === undefined) throw new InvariantError('个人自选不存在');
    const snapshot = this.repos.watchlistMember.snapshotForExport();
    const members = snapshot.members.filter((member) => member.watchlistId === watchlistId);
    const memberIds = new Set(members.map((member) => member.id));
    const sources = snapshot.sources.filter((source) => memberIds.has(source.memberId));
    return {
      watchlist,
      members,
      sources,
      revision: stableHash(watchlistRevisionInput(watchlist, members, sources)),
    };
  }

  async putImportPreview(preview: WatchlistImportPreview) {
    this.previews.set(preview.id, WatchlistImportPreviewSchema.parse(structuredClone(preview)));
  }
  async getImportPreview(id: string) {
    return this.previews.get(id) ?? null;
  }
  async getWatchlistRevision(watchlistId: string): Promise<string> {
    return this.watchlistState(watchlistId).revision;
  }
  async commitWatchlistImport(
    input: Parameters<PersonalRepository['commitWatchlistImport']>[0],
  ): Promise<WatchlistImportResult> {
    return this.lock.run(async () => {
      const preview = this.previews.get(input.previewId);
      if (
        preview === undefined ||
        preview.ownerUserId !== input.ownerUserId ||
        preview.inputHash !== input.inputHash
      )
        throw new InvariantError('导入预览身份不匹配');
      const operationId = `import:${preview.watchlistId}:${input.requestId}`;
      const inputHash = importRequestHash(input);
      const old = this.imports.get(operationId);
      if (old !== undefined) {
        if (old.receipt.inputHash !== inputHash)
          throw new InvariantError('import request identity conflict');
        return old;
      }
      const stockIds = selectWatchlistImportStocks(
        preview,
        input.selections,
        input.excludedRows,
        input.acknowledgeExtraColumns,
      );
      for (const stockId of stockIds)
        if ((await this.repos.stock.findById(stockId)) === null)
          throw new InvariantError('股票目录已经变化，请重新预览');
      const { watchlist, revision } = this.watchlistState(preview.watchlistId);
      if (revision !== preview.watchlistRevision)
        throw new InvariantError('自选已经变化，请重新预览');
      const { members, sources } = this.repos.watchlistMember.snapshotForExport();
      const importBatchId = `import-${stableHash(operationId).slice(0, 24)}`;
      const mutation = buildWatchlistImportMutation({
        watchlist,
        members,
        sources,
        stockIds,
        ownerUserId: input.ownerUserId,
        importBatchId,
        maxDistinctStocks: input.maxDistinctStocks,
        now: input.now,
      });
      const resultBody = {
        importBatchId,
        watchlistId: watchlist.id,
        stockIds,
        enteredCount: mutation.enteredCount,
        unchangedCount: mutation.unchangedCount,
        distinctStockCount: mutation.distinctStockCount,
      };
      const receipt = PersonalOperationReceiptSchema.parse({
        operationId,
        inputHash,
        resultRef: importBatchId,
        resultHash: stableHash(resultBody),
        status: 'succeeded',
        committedAt: input.now,
      });
      const result = WatchlistImportResultSchema.parse({ ...resultBody, receipt });
      this.repos.watchlistMember.applyMutation(mutation.members, mutation.sources);
      this.imports.set(operationId, result);
      return result;
    });
  }
  async removePersonalMembers(input: Parameters<PersonalRepository['removePersonalMembers']>[0]) {
    return this.lock.run(async () => {
      const operationId = `remove:${input.watchlistId}:${input.requestId}`;
      const inputHash = stableHash({
        watchlistId: input.watchlistId,
        stockIds: [...new Set(input.stockIds)].sort(),
        ownerUserId: input.ownerUserId,
      });
      const old = this.removals.get(operationId);
      if (old !== undefined) {
        if (old.receipt.inputHash !== inputHash)
          throw new InvariantError('member removal request identity conflict');
        return old;
      }
      const current = this.watchlistState(input.watchlistId);
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
      const receipt = PersonalOperationReceiptSchema.parse({
        operationId,
        inputHash,
        resultRef: `remove-${stableHash(operationId).slice(0, 24)}`,
        resultHash: stableHash(mutation.results),
        status: 'succeeded',
        committedAt: input.now,
      });
      const result = WatchlistRemovalResultSchema.parse({ results: mutation.results, receipt });
      this.repos.watchlistMember.applyMutation(mutation.members, mutation.sources);
      this.removals.set(operationId, result);
      return result;
    });
  }
  async commitFactsReport(input: Parameters<PersonalRepository['commitFactsReport']>[0]) {
    return this.lock.run(async () => {
      const parsed = ReportSchema.parse(input.report);
      if (parsed.kind !== 'watchlist-facts' || parsed.scope.kind !== 'watchlist')
        throw new InvariantError('facts request scope mismatch');
      const frozen = parsed.watchlistFactsSnapshot?.frozenInput;
      if (frozen?.watchlistId !== parsed.scope.watchlistId || frozen.period !== parsed.periodStart)
        throw new InvariantError('facts request scope mismatch');
      const watchlistId = parsed.scope.watchlistId;
      const currentPlans = this.repos.alertPlan
        .snapshotForExport()
        .filter((plan) => plan.watchlistId === watchlistId);
      if (
        parsed.watchlistFactsSnapshot?.watchlistRevision !==
          this.watchlistState(watchlistId).revision ||
        parsed.watchlistFactsSnapshot.ruleFingerprint !==
          stableHash(watchlistRuleRevisionInput(currentPlans))
      )
        throw new InvariantError('facts input changed before commit');
      const identity = factsIdentity(parsed);
      const reusedId = this.facts.get(identity);
      const reports = this.repos.report.snapshotForExport();
      let report =
        reusedId === undefined ? null : (reports.find((report) => report.id === reusedId) ?? null);
      if (report === null) {
        const latest =
          reports
            .filter(
              (report) =>
                report.kind === 'watchlist-facts' &&
                reportScopeKey(report.scope) === reportScopeKey(parsed.scope) &&
                report.periodStart === parsed.periodStart &&
                report.periodEnd === parsed.periodEnd,
            )
            .sort((a, b) => (b.version ?? 1) - (a.version ?? 1))[0] ?? null;
        report = ReportSchema.parse({
          ...parsed,
          version: (latest?.version ?? 0) + 1,
          supersedesReportId: latest?.id,
          notificationPolicy: latest === null ? input.notificationPolicy : 'never',
          deliveryStatus: 'not-requested',
        });
        assertReportInvariants(report);
      }
      this.repos.report.put(report);
      this.facts.set(identity, report.id);
      return {
        report,
        receipt: factsReceipt(input.operationId, input.inputHash, report),
        replayed: reusedId !== undefined,
      };
    });
  }
  async savePersonalAlertPlan(input: Parameters<PersonalRepository['savePersonalAlertPlan']>[0]) {
    return this.lock.run(async () => {
      const operationId = `alert-plan:${input.plan.id}:${input.requestId}`;
      const inputHash = alertPlanRequestHash(input);
      const replay = this.planMutations.get(operationId);
      if (replay !== undefined) {
        if (replay.receipt.inputHash !== inputHash || !('plan' in replay))
          throw new InvariantError('alert plan request identity conflict');
        return replay;
      }
      const { watchlist } = this.watchlistState(input.plan.watchlistId);
      if (watchlist.kind !== 'personal' || !watchlist.enabled)
        throw new InvariantError('启用的个人自选不存在');
      const plans = this.repos.alertPlan.snapshotForExport();
      const old = plans.find((plan) => plan.id === input.plan.id) ?? null;
      if ((old === null ? null : stableHash(old)) !== input.expectedPlanRevision)
        throw new InvariantError('个人提醒修订已经变化');
      const plan = PersonalAlertPlanSchema.parse({
        ...input.plan,
        createdAt: old?.createdAt ?? input.now,
        updatedAt: input.now,
      });
      if (plan.enabled && !input.enableConfirmed)
        throw new InvariantError('启用用户价格条件需要显式确认');
      assertPersonalAlertPlanLimits({ ...input, plan, plans });
      const planRevision = stableHash(plan);
      const receipt = PersonalOperationReceiptSchema.parse({
        operationId,
        inputHash,
        resultRef: `personal-plan:${stableHash(operationId).slice(0, 24)}`,
        resultHash: stableHash({ plan, planRevision }),
        status: 'succeeded',
        committedAt: input.now,
      });
      const result = PersonalAlertPlanMutationSchema.parse({ plan, planRevision, receipt });
      if (old !== null && personalAlertConditionInput(old) !== personalAlertConditionInput(plan)) {
        this.repos.watchRuleState.deleteByPool(plan.id);
        this.repos.watchTrigger.invalidatePending(plan.id, input.now);
      }
      this.repos.alertPlan.put(plan);
      this.planMutations.set(operationId, result);
      return result;
    });
  }
  async removePersonalAlertPlan(
    input: Parameters<PersonalRepository['removePersonalAlertPlan']>[0],
  ) {
    return this.lock.run(async () => {
      const operationId = `alert-plan-remove:${input.alertPlanId}:${input.requestId}`;
      const inputHash = alertPlanRemovalHash(input);
      const replay = this.planMutations.get(operationId);
      if (replay !== undefined) {
        if (replay.receipt.inputHash !== inputHash || !('alertPlanId' in replay))
          throw new InvariantError('alert plan request identity conflict');
        return replay;
      }
      const old =
        this.repos.alertPlan.snapshotForExport().find((plan) => plan.id === input.alertPlanId) ??
        null;
      if (old === null || this.watchlistState(old.watchlistId).watchlist.kind !== 'personal')
        throw new InvariantError('个人提醒不存在');
      if (stableHash(old) !== input.expectedPlanRevision)
        throw new InvariantError('个人提醒修订已经变化');
      const receipt = PersonalOperationReceiptSchema.parse({
        operationId,
        inputHash,
        resultRef: `personal-plan:${stableHash(operationId).slice(0, 24)}`,
        resultHash: stableHash({ alertPlanId: input.alertPlanId }),
        status: 'succeeded',
        committedAt: input.now,
      });
      const result = PersonalAlertPlanRemovalSchema.parse({
        alertPlanId: input.alertPlanId,
        receipt,
      });
      this.repos.watchRuleState.deleteByPool(input.alertPlanId);
      this.repos.watchTrigger.invalidatePending(input.alertPlanId, input.now);
      this.repos.alertPlan.delete(input.alertPlanId);
      this.planMutations.set(operationId, result);
      return result;
    });
  }
  async getPersonalAlertEvaluation(resultRef: string) {
    return this.alertEvaluations.get(resultRef) ?? null;
  }
  async commitPersonalAlertEvaluation(
    input: Parameters<PersonalRepository['commitPersonalAlertEvaluation']>[0],
  ) {
    return this.lock.run(async () => {
      const replay = this.alertEvaluations.get(`personal-alerts:${input.operationId}`);
      if (replay !== undefined)
        return {
          evaluation: replay,
          receipt: personalAlertReceipt(input.operationId, input.inputHash, replay),
          replayed: true,
        };
      const frozen = PersonalAlertRequestSchema.parse(input.request);
      if (stableHash(frozen) !== input.inputHash)
        throw new InvariantError('operation input identity conflict');
      if (frozen.period !== dateInShanghai(input.now))
        throw new InvariantError('personal alert period expired');
      const draft = PersonalAlertEvaluationDraftSchema.parse(input.draft);
      if (
        draft.domainLeaseOwner !==
          personalAlertLeaseOwner(input.operationId, input.attemptId, input.fence) ||
        draft.evaluatedAt > input.now
      )
        throw new InvariantError('personal alert domain lease identity mismatch');
      const currentPlans = this.repos.alertPlan
        .snapshotForExport()
        .filter((plan) => plan.watchlistId === frozen.watchlistId && plan.enabled);
      if (
        this.watchlistState(frozen.watchlistId).revision !== frozen.watchlistRevision ||
        stableHash(watchlistRuleRevisionInput(currentPlans)) !== frozen.ruleFingerprint
      )
        throw new InvariantError('personal alert input changed before commit');
      const planIds = new Set(currentPlans.map((plan) => plan.id));
      const previousStates = this.repos.watchRuleState
        .snapshotForEvaluation()
        .filter((state) => planIds.has(state.poolId));
      const priorTriggers = this.repos.watchTrigger
        .snapshotForExport()
        .filter((trigger) => trigger.createdAt.getTime() >= input.now.getTime() - 172_800_000)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, 100_000);
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
      if (
        !this.repos.watchTrigger.commitEvaluationWithLease({
          owner: draft.domainLeaseOwner,
          now: input.now,
          triggers: evaluation.triggers,
          states: mutation.states,
        })
      )
        throw new InvariantError('personal alert domain lease expired');
      this.alertEvaluations.set(evaluation.id, evaluation);
      return {
        evaluation,
        receipt: personalAlertReceipt(input.operationId, input.inputHash, evaluation),
        replayed: false,
      };
    });
  }
  async recordPersonalFeedback(input: Parameters<PersonalRepository['recordPersonalFeedback']>[0]) {
    return this.lock.run(async () => {
      const revisions = this.feedback.get(input.triggerId) ?? [];
      const old = revisions.find((revision) => revision.requestId === input.requestId);
      if (old !== undefined) {
        if (old.inputHash !== input.inputHash)
          throw new InvariantError('personal feedback request identity conflict');
        return old;
      }
      const latest = revisions.at(-1);
      if ((latest?.revision ?? 0) !== input.expectedRevision)
        throw new InvariantError('personal feedback revision changed');
      const trigger =
        latest?.triggerSnapshot ?? (await this.repos.watchTrigger.findById(input.triggerId));
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
      this.feedback.set(input.triggerId, [...revisions, revision]);
      return revision;
    });
  }
  async listPersonalFeedback(triggerId: string) {
    return this.feedback.get(triggerId) ?? [];
  }
  async listAllPersonalFeedback() {
    return [...this.feedback.values()].flat();
  }
}
