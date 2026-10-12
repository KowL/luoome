import { describe, expect, it } from 'bun:test';
import {
  dateInShanghai,
  money,
  type PersonalAlertPlan,
  PersonalAlertPlanSchema,
  type PersonalAlertRequest,
  PersonalAlertRequestSchema,
  parseWatchlistImport,
  personalAlertLeaseOwner,
  type Quote,
  ReportSchema,
  type RepositoryRegistry,
  type Stock,
  stockCode,
  type TenantRepository,
  WatchlistImportPreviewSchema,
  WatchlistSchema,
  WatchTriggerSchema,
  watchlistRuleRevisionInput,
} from '@luoome/core';
import { createDrizzleRepos } from '../client.js';
import { createInMemoryRepos } from '../repository/memory/index.js';
import { tenantHash } from './tenant-memory.js';

const now = new Date('2026-10-10T04:00:00Z');
const stock: Stock = {
  id: '600519.SH',
  code: stockCode('600519'),
  exchange: 'SH',
  name: '贵州茅台',
};
const secondStock: Stock = {
  id: '000001.SZ',
  code: stockCode('000001'),
  exchange: 'SZ',
  name: '平安银行',
};
const addList = async (repos: RepositoryRegistry, id: string) =>
  repos.watchlist.save(
    WatchlistSchema.parse({
      id,
      name: id,
      kind: 'personal',
      membershipPolicy: 'mixed',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }),
  );
const fixture = async (mode: 'memory' | 'drizzle') => {
  const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
  const repos = handle?.repos ?? createInMemoryRepos();
  const tenant = repos.hostedTenant as TenantRepository;
  await repos.stock.save(stock);
  await repos.stock.save(secondStock);
  await addList(repos, 'personal');
  return { repos, tenant, close: () => handle?.close() };
};
let nextPreview = 0;
const preview = async (repos: RepositoryRegistry, content: string, watchlistId = 'personal') => {
  const tenant = repos.hostedTenant as TenantRepository;
  const rows = parseWatchlistImport(content, 'text', [stock, secondStock]);
  const item = WatchlistImportPreviewSchema.parse({
    id: `preview-${++nextPreview}`,
    watchlistId,
    ownerUserId: 'user-one',
    inputHash: tenantHash(rows.normalizedInput),
    watchlistRevision: await tenant.getWatchlistRevision(watchlistId),
    mappingVersion: 'a'.repeat(64),
    rows: rows.rows,
    ignoredColumns: [],
    createdAt: now,
  });
  await tenant.putImportPreview(item);
  return item;
};
const importStocks = async (
  repos: RepositoryRegistry,
  content: string,
  requestId: string,
  maxDistinctStocks = 50,
  watchlistId = 'personal',
) => {
  const item = await preview(repos, content, watchlistId);
  const input = {
    previewId: item.id,
    inputHash: item.inputHash,
    requestId,
    ownerUserId: 'user-one',
    selections: item.rows
      .filter((row) => row.status === 'ready')
      .map((row) => ({ row: row.row, stockId: row.stockId as string })),
    excludedRows: item.rows.filter((row) => row.status !== 'ready').map((row) => row.row),
    acknowledgeExtraColumns: false,
    maxDistinctStocks,
    now,
  };
  return {
    input,
    result: await (repos.hostedTenant as TenantRepository).commitWatchlistImport(input),
  };
};
const reportFor = async (repos: RepositoryRegistry, id: string, fingerprint = 'b'.repeat(64)) =>
  ReportSchema.parse({
    id,
    kind: 'watchlist-facts',
    scope: { kind: 'watchlist', watchlistId: 'personal' },
    periodStart: '2026-10-10',
    periodEnd: '2026-10-10',
    title: '自选事实',
    generatedAt: now,
    dataAsOf: now,
    status: 'complete',
    sections: [
      {
        key: 'facts',
        title: '事实',
        required: true,
        status: 'complete',
        blocks: [{ kind: 'text', text: '已保存自选身份' }],
      },
    ],
    evidence: [],
    workflowRunId: 'facts-op',
    createdAt: now,
    updatedAt: now,
    watchlistFactsSnapshot: {
      schemaVersion: 1,
      watchlistRevision: await (repos.hostedTenant as TenantRepository).getWatchlistRevision(
        'personal',
      ),
      ruleFingerprint: tenantHash(watchlistRuleRevisionInput([])),
      inputFingerprint: fingerprint,
      rendererVersion: 'hosted-facts-v1',
      frozenInput: { watchlistId: 'personal', period: '2026-10-10' },
    },
  });

const alertNow = new Date('2026-10-12T02:00:00Z');
const pricePlan = (id = 'price-plan', overrides: Partial<PersonalAlertPlan> = {}) =>
  PersonalAlertPlanSchema.parse({
    id,
    name: id,
    watchlistId: 'personal',
    rules: [{ id: 'above', kind: 'price-level', level: 100, side: 'above' }],
    logic: 'ANY',
    triggerMode: 'on-enter',
    cooldownMinutes: 10,
    dailyNotificationLimit: 10,
    notifyOnRecovery: false,
    enabled: true,
    createdAt: alertNow,
    updatedAt: alertNow,
    ...overrides,
  });
const savePlan = (
  tenant: TenantRepository,
  plan: PersonalAlertPlan,
  requestId: string,
  expectedPlanRevision: string | null = null,
  at = alertNow,
  maxEnabledRules = 100,
) =>
  tenant.savePersonalAlertPlan({
    plan,
    requestId,
    expectedPlanRevision,
    enableConfirmed: true,
    maxEnabledRules,
    maxDailyNotifications: 100,
    minCooldownMinutes: 0,
    now: at,
  });
const alertRequest = async (
  repos: RepositoryRegistry,
  at = alertNow,
  maxDailyNotifications = 100,
): Promise<PersonalAlertRequest> => {
  const watchlist = await repos.watchlist.findById('personal');
  const members = [...(await repos.watchlistMember.listMembers('personal'))];
  const sources = (
    await Promise.all(members.map((member) => repos.watchlistMember.listSources(member.id)))
  ).flat();
  const alertPlans = await repos.alertPlan.list({ watchlistId: 'personal', enabledOnly: true });
  return PersonalAlertRequestSchema.parse({
    watchlistId: 'personal',
    period: dateInShanghai(at),
    notificationPolicy: 'never',
    watchlistRevision: await (repos.hostedTenant as TenantRepository).getWatchlistRevision(
      'personal',
    ),
    ruleFingerprint: tenantHash(watchlistRuleRevisionInput(alertPlans)),
    watchlist,
    members,
    sources,
    stocks: [stock, secondStock],
    alertPlans,
    maxDailyNotifications,
  });
};
const priceQuote = (close: number, at = alertNow): Quote => ({
  stockId: stock.id,
  close: money(close),
  open: money(100),
  high: money(Math.max(close, 100)),
  low: money(Math.min(close, 100)),
  volume: 1000,
  prevClose: money(100),
  observedAt: new Date(at.getTime() - 1000),
  fetchedAt: at,
  ts: new Date(at.getTime() - 1000),
  timestampSource: 'upstream',
  source: 'fixture',
});
const claimAlert = async (
  repos: RepositoryRegistry,
  operationId: string,
  at = alertNow,
  maxDailyNotifications = 100,
) => {
  const tenant = repos.hostedTenant as TenantRepository;
  const input = await alertRequest(repos, at, maxDailyNotifications);
  const inputHash = tenantHash(input);
  await tenant.putExecutionRequest({
    operationId,
    inputHash,
    generation: 1,
    kind: 'watch-alerts',
    input,
    createdAt: at,
  });
  const claim = await tenant.claimExecution({
    operationId,
    generation: 1,
    attemptId: `${operationId}-attempt`,
    now: at,
    leaseMs: 120_000,
  });
  if (claim.kind !== 'claimed') throw new Error('alert lease missing');
  const owner = personalAlertLeaseOwner(operationId, claim.lease.attemptId, claim.lease.fence);
  expect(
    await repos.watchTrigger.acquireExecution(owner, at, new Date(at.getTime() + 120_000)),
  ).toBe(true);
  return {
    operationId,
    inputHash,
    generation: 1,
    fence: claim.lease.fence,
    attemptId: claim.lease.attemptId,
    now: at,
    owner,
  };
};
const commitAlert = async (
  repos: RepositoryRegistry,
  operationId: string,
  close: number | null,
  at = alertNow,
  maxDailyNotifications = 100,
) => {
  const lease = await claimAlert(repos, operationId, at, maxDailyNotifications);
  try {
    return await (repos.hostedTenant as TenantRepository).commitPersonalAlertEvaluation({
      ...lease,
      draft: {
        domainLeaseOwner: lease.owner,
        evaluatedAt: at,
        quotes: close === null ? [] : [priceQuote(close, at)],
        quoteErrors: close === null ? [{ stockId: stock.id, reason: '行情不可用' }] : [],
      },
    });
  } finally {
    await repos.watchTrigger.releaseExecution(lease.owner);
  }
};

for (const mode of ['memory', 'drizzle'] as const)
  describe(`TenantRepository [${mode}]`, () => {
    it('atomically imports normalized identities and receipts with explicit exclusions and stable source keys', async () => {
      const f = await fixture(mode);
      try {
        const imported = await importStocks(f.repos, '600519\n贵州茅台\n未知股票', 'request-one');
        expect(imported.result.stockIds).toEqual([stock.id]);
        expect(await f.tenant.commitWatchlistImport(imported.input)).toEqual(imported.result);
        await expect(
          f.tenant.commitWatchlistImport({ ...imported.input, acknowledgeExtraColumns: true }),
        ).rejects.toThrow('identity conflict');
        const repeated = await importStocks(f.repos, '600519', 'request-two');
        expect(repeated.result.unchangedCount).toBe(1);
        const member = await f.repos.watchlistMember.findMember('personal', stock.id);
        const sources = await f.repos.watchlistMember.listSources(member?.id as string, true);
        expect(sources).toHaveLength(1);
        expect(sources[0]?.sourceKey).toBe('import:user-one');
        expect(sources[0]?.importBatchId).toBe(imported.result.importBatchId);
        expect(await f.tenant.getReceipt(imported.result.receipt.operationId)).toEqual(
          imported.result.receipt,
        );
      } finally {
        f.close();
      }
    });
    it('rejects stale previews and rolls back invalid selections or quota excess', async () => {
      const f = await fixture(mode);
      try {
        const stale = await preview(f.repos, '000001');
        await importStocks(f.repos, '600519', 'first', 1);
        await expect(
          f.tenant.commitWatchlistImport({
            previewId: stale.id,
            inputHash: stale.inputHash,
            requestId: 'stale',
            ownerUserId: 'user-one',
            selections: [{ row: 1, stockId: secondStock.id }],
            excludedRows: [],
            acknowledgeExtraColumns: false,
            maxDistinctStocks: 1,
            now,
          }),
        ).rejects.toThrow('重新预览');
        await expect(importStocks(f.repos, '000001', 'excess', 1)).rejects.toThrow('上限');
        expect(await f.repos.watchlistMember.findMember('personal', secondStock.id)).toBeNull();
        expect(await f.tenant.getReceipt('import:personal:excess')).toBeNull();
      } finally {
        f.close();
      }
    });
    it('preserves other sources, archives imports when empty, and reimports as a new lifecycle', async () => {
      const f = await fixture(mode);
      try {
        await importStocks(f.repos, '600519\n000001', 'first');
        const member = await f.repos.watchlistMember.findMember('personal', stock.id);
        await f.repos.watchlistMember.saveSource({
          id: 'strategy-source',
          memberId: member?.id as string,
          kind: 'strategy',
          sourceKey: 'strategy:chosen',
          reason: '已订阅来源',
          status: 'active',
          evidence: [],
          validFrom: now,
        });
        const removalInput = {
          watchlistId: 'personal',
          stockIds: [stock.id, secondStock.id],
          ownerUserId: 'user-one',
          requestId: 'remove-one',
          now: new Date(now.getTime() + 1000),
        };
        const removal = await f.tenant.removePersonalMembers(removalInput);
        expect(await f.tenant.removePersonalMembers(removalInput)).toEqual(removal);
        await expect(
          f.tenant.removePersonalMembers({ ...removalInput, stockIds: [secondStock.id] }),
        ).rejects.toThrow('identity conflict');
        const removed = removal.results;
        expect(
          removed
            .find((item) => item.stockId === stock.id)
            ?.remainingSources.map((source) => source.kind),
        ).toEqual(['strategy']);
        expect(removed.find((item) => item.stockId === stock.id)?.archived).toBe(false);
        expect(removed.find((item) => item.stockId === secondStock.id)?.archived).toBe(true);
        await importStocks(f.repos, '000001', 'reimport');
        const revived = await f.repos.watchlistMember.findMember('personal', secondStock.id);
        expect(revived?.stage).toBe('watching');
        expect(revived?.archivedAt).toBeUndefined();
        const history = await f.repos.watchlistMember.listSources(revived?.id as string, true);
        expect(history).toHaveLength(2);
        expect(history.filter((source) => source.status === 'ended')).toHaveLength(1);
        expect(history.filter((source) => source.status === 'active')).toHaveLength(1);
      } finally {
        f.close();
      }
    });
    it('checks distinct tenant stocks atomically across lists, including simultaneous imports', async () => {
      const f = await fixture(mode);
      try {
        await addList(f.repos, 'second-list');
        await addList(f.repos, 'third-list');
        const a = await preview(f.repos, '600519', 'personal');
        const b = await preview(f.repos, '000001', 'second-list');
        const inputs = [a, b].map((item) => ({
          previewId: item.id,
          inputHash: item.inputHash,
          requestId: 'concurrent',
          ownerUserId: 'user-one',
          selections: [{ row: 1, stockId: item.rows[0]?.stockId as string }],
          excludedRows: [],
          acknowledgeExtraColumns: false,
          maxDistinctStocks: 1,
          now,
        }));
        const attempts = await Promise.allSettled(
          inputs.map((input) => f.tenant.commitWatchlistImport(input)),
        );
        expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
        const winner = attempts.find((attempt) => attempt.status === 'fulfilled');
        if (winner?.status !== 'fulfilled') throw new Error('winner missing');
        const same = await importStocks(
          f.repos,
          winner.value.stockIds[0] as string,
          'same-stock',
          1,
          'third-list',
        );
        expect(same.result.distinctStockCount).toBe(1);
      } finally {
        f.close();
      }
    });
    it('fences expired workers and commits report, receipt, and outbox together', async () => {
      const f = await fixture(mode);
      try {
        const report = await reportFor(f.repos, 'report-one');
        const first = await claim(f.tenant, 'op-one');
        const later = new Date(now.getTime() + 121_000);
        const second = await f.tenant.claimExecution({
          operationId: first.operationId,
          generation: 1,
          attemptId: 'new-attempt',
          now: later,
          leaseMs: 120_000,
        });
        expect(second.kind).toBe('claimed');
        await expect(f.tenant.commitFactsReport({ ...first, now: later, report })).rejects.toThrow(
          'fence',
        );
        expect(await f.repos.report.findById(report.id)).toBeNull();
        expect(await f.tenant.getReceipt(first.operationId)).toBeNull();
        expect(await f.tenant.listOutbox()).toHaveLength(0);
        if (second.kind !== 'claimed') throw new Error('claim missing');
        const committed = await f.tenant.commitFactsReport({
          ...first,
          fence: second.lease.fence,
          attemptId: second.lease.attemptId,
          now: later,
          report,
        });
        expect((await f.tenant.listOutbox())[0]?.resultRef).toBe(report.id);
        expect(
          (
            await f.tenant.claimExecution({
              operationId: first.operationId,
              generation: 1,
              attemptId: 'recovery',
              now: later,
              leaseMs: 120_000,
            })
          ).kind,
        ).toBe('completed');
        expect((await f.tenant.commitFactsReport({ ...first, report })).receipt).toEqual(
          committed.receipt,
        );
        expect(await f.tenant.listOutbox()).toHaveLength(1);
        await f.tenant.ackOutbox(`result:${first.operationId}`, later);
        expect(await f.tenant.listOutbox()).toHaveLength(0);
      } finally {
        f.close();
      }
    });
    it('reuses the fingerprint identity and makes later facts versions never notify', async () => {
      const f = await fixture(mode);
      try {
        const first = await f.tenant.commitFactsReport({
          ...(await claim(f.tenant, 'one')),
          report: await reportFor(f.repos, 'report-one'),
        });
        const reused = await f.tenant.commitFactsReport({
          ...(await claim(f.tenant, 'two')),
          report: await reportFor(f.repos, 'report-unused'),
        });
        expect(reused.report.id).toBe(first.report.id);
        expect(reused.replayed).toBe(true);
        const updated = await f.tenant.commitFactsReport({
          ...(await claim(f.tenant, 'three')),
          report: await reportFor(f.repos, 'report-three', 'e'.repeat(64)),
        });
        expect(updated.report.version).toBe(2);
        expect(updated.report.supersedesReportId).toBe(first.report.id);
        expect(updated.report.notificationPolicy).toBe('never');
        expect(
          (await f.tenant.listOutbox()).find((event) => event.operationId === 'three')
            ?.notificationPolicy,
        ).toBe('never');
        expect(
          await f.repos.report.claimDelivery({
            id: updated.report.id,
            attemptId: 'notification',
            now,
            stalePendingBefore: now,
            failedRetryBefore: now,
          }),
        ).toBe(false);
        expect(await f.repos.report.list({ kind: 'watchlist-facts' })).toHaveLength(2);
      } finally {
        f.close();
      }
    });
    it('rejects a changed frozen membership without leaving a report or result receipt', async () => {
      const f = await fixture(mode);
      try {
        const report = await reportFor(f.repos, 'report-one');
        const execution = await claim(f.tenant, 'one');
        await importStocks(f.repos, '600519', 'change');
        await expect(f.tenant.commitFactsReport({ ...execution, report })).rejects.toThrow(
          'input changed',
        );
        expect(await f.tenant.getReceipt('one')).toBeNull();
        expect(await f.repos.report.findById(report.id)).toBeNull();
        expect(await f.tenant.listOutbox()).toHaveLength(0);
      } finally {
        f.close();
      }
    });
    it('appends account-free feedback with frozen facts and idempotent revision receipts', async () => {
      const f = await fixture(mode);
      try {
        const trigger = WatchTriggerSchema.parse({
          id: 'trigger-one',
          poolId: 'personal',
          alertPlanId: 'user-price',
          stockId: stock.id,
          ruleKind: 'price-level',
          ruleId: 'price-rule',
          direction: 'watch',
          reason: '价格达到用户条件',
          evidence: ['用户设置价格 100 元'],
          priority: 'normal',
          deliveryStatus: 'not-requested',
          evalSnapshot: { threshold: 100 },
          quote: { close: money(100), ts: now },
          notified: false,
          createdAt: now,
        });
        await f.repos.watchTrigger.save(trigger);
        const input = {
          triggerId: trigger.id,
          expectedRevision: 0,
          rating: 'useful' as const,
          note: '已核对',
          requestId: 'one',
          inputHash: 'f'.repeat(64),
          now,
        };
        const first = await f.tenant.recordPersonalFeedback(input);
        expect(await f.tenant.recordPersonalFeedback(input)).toEqual(first);
        await expect(
          f.tenant.recordPersonalFeedback({ ...input, inputHash: 'a'.repeat(64) }),
        ).rejects.toThrow('identity conflict');
        await expect(
          f.tenant.recordPersonalFeedback({ ...input, requestId: 'stale' }),
        ).rejects.toThrow('revision changed');
        const second = await f.tenant.recordPersonalFeedback({
          ...input,
          expectedRevision: 1,
          rating: 'handled',
          requestId: 'two',
          inputHash: 'a'.repeat(64),
        });
        expect(second.revision).toBe(2);
        expect(second.triggerSnapshot).toEqual(first.triggerSnapshot);
        expect(first.triggerSnapshot.quote).toEqual({ close: money(100), ts: now });
        expect(await f.tenant.listAllPersonalFeedback()).toHaveLength(2);
        expect(await f.tenant.listPersonalFeedback(trigger.id)).toHaveLength(2);
        expect((await f.repos.watchTrigger.findById(trigger.id))?.feedback).toBeUndefined();
        expect(await f.repos.account.list()).toHaveLength(0);
      } finally {
        f.close();
      }
    });
  });

for (const mode of ['memory', 'drizzle'] as const)
  describe(`Personal price alerts [${mode}]`, () => {
    it('checks enabled-rule quota atomically and gives plan writes replay and revision protection', async () => {
      const f = await fixture(mode);
      try {
        const plan = pricePlan();
        await expect(
          f.tenant.savePersonalAlertPlan({
            plan,
            expectedPlanRevision: null,
            requestId: 'unconfirmed',
            enableConfirmed: false,
            maxEnabledRules: 1,
            maxDailyNotifications: 100,
            minCooldownMinutes: 0,
            now: alertNow,
          }),
        ).rejects.toThrow('显式确认');
        expect(await f.repos.alertPlan.list()).toHaveLength(0);
        const attempts = await Promise.allSettled([
          savePlan(f.tenant, plan, 'one', null, alertNow, 1),
          savePlan(f.tenant, pricePlan('second-plan'), 'two', null, alertNow, 1),
        ]);
        expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
        expect(await f.repos.alertPlan.list()).toHaveLength(1);
        const winner = attempts.find((attempt) => attempt.status === 'fulfilled');
        if (winner?.status !== 'fulfilled') throw new Error('plan winner missing');
        const result = winner.value;
        const originalRequest = result.plan.id === plan.id ? 'one' : 'two';
        expect(await savePlan(f.tenant, result.plan, originalRequest, null, alertNow, 1)).toEqual(
          result,
        );
        await expect(
          savePlan(
            f.tenant,
            { ...result.plan, name: 'changed' },
            originalRequest,
            null,
            alertNow,
            1,
          ),
        ).rejects.toThrow('identity conflict');
        await expect(savePlan(f.tenant, result.plan, 'stale', null, alertNow, 1)).rejects.toThrow(
          '修订',
        );
        const paused = await savePlan(
          f.tenant,
          { ...result.plan, enabled: false },
          'pause',
          result.planRevision,
          alertNow,
          1,
        );
        expect(paused.plan.enabled).toBe(false);
        expect(await f.tenant.getReceipt(paused.receipt.operationId)).toEqual(paused.receipt);
        expect(await f.tenant.listOutbox()).toHaveLength(0);
      } finally {
        f.close();
      }
    });
    it('atomically commits formal rising edges, durable evaluation, receipt and opaque notification targets', async () => {
      const f = await fixture(mode);
      try {
        await importStocks(f.repos, '600519', 'members');
        await savePlan(f.tenant, pricePlan(), 'plan');
        const bootstrap = await commitAlert(f.repos, 'baseline', 90);
        expect(bootstrap.evaluation.triggers).toHaveLength(0);
        expect(bootstrap.evaluation.initializedCount).toBe(1);
        const at = new Date(alertNow.getTime() + 5000);
        const entered = await commitAlert(f.repos, 'entered', 110, at);
        expect(entered.evaluation.mode).toBe('formal');
        expect(entered.evaluation.triggers).toHaveLength(1);
        const trigger = entered.evaluation.triggers[0];
        if (trigger === undefined) throw new Error('entered trigger missing');
        expect(trigger).toMatchObject({
          poolId: 'price-plan',
          alertPlanId: 'price-plan',
          direction: 'watch',
          deliveryStatus: 'pending',
          triggerType: 'triggered',
        });
        expect(await f.tenant.getPersonalAlertEvaluation(entered.receipt.resultRef)).toEqual(
          entered.evaluation,
        );
        expect(entered.receipt.resultHash).toBe(tenantHash(entered.evaluation));
        expect(await f.repos.watchTrigger.findById(trigger?.id as string)).toEqual(trigger);
        expect(await f.repos.watchRuleState.listByPool('price-plan')).toMatchObject([
          { ruleId: 'above', active: true },
        ]);
        const event = (await f.tenant.listOutbox()).find(
          (event) => event.operationId === 'entered',
        );
        expect(event).toMatchObject({
          notificationPolicy: 'never',
          resultRef: entered.evaluation.id,
          deliveries: [
            {
              businessKey: `watch-trigger:${trigger?.id}`,
              resultRef: trigger?.id,
              notificationPolicy: 'eligible',
            },
          ],
        });
        expect(event).not.toHaveProperty('quote');
        expect(event).not.toHaveProperty('reason');
        const replay = await f.tenant.commitPersonalAlertEvaluation({
          operationId: 'entered',
          inputHash: entered.receipt.inputHash,
          generation: 1,
          fence: 999,
          attemptId: 'expired',
          now: new Date(at.getTime() + 3600_000),
        });
        expect(replay.evaluation).toEqual(entered.evaluation);
        expect(replay.replayed).toBe(true);
        expect(await f.repos.watchTrigger.listByPool('price-plan')).toHaveLength(1);
        expect(await f.repos.account.list()).toHaveLength(0);
      } finally {
        f.close();
      }
    });
    it('rejects expired tenant fences and foreign domain owners without partial business writes', async () => {
      const f = await fixture(mode);
      try {
        await importStocks(f.repos, '600519', 'members');
        await savePlan(f.tenant, pricePlan(), 'plan');
        const lease = await claimAlert(f.repos, 'fenced');
        const draft = {
          domainLeaseOwner: lease.owner,
          evaluatedAt: alertNow,
          quotes: [priceQuote(90)],
          quoteErrors: [],
        };
        await expect(
          f.tenant.commitPersonalAlertEvaluation({ ...lease, fence: lease.fence + 1, draft }),
        ).rejects.toThrow('fence');
        await expect(
          f.tenant.commitPersonalAlertEvaluation({
            ...lease,
            draft: { ...draft, domainLeaseOwner: 'foreign' },
          }),
        ).rejects.toThrow('domain lease identity');
        await expect(
          f.tenant.commitPersonalAlertEvaluation({
            ...lease,
            now: new Date(alertNow.getTime() + 121_000),
            draft,
          }),
        ).rejects.toThrow('fence');
        await f.repos.watchTrigger.releaseExecution(lease.owner);
        await expect(f.tenant.commitPersonalAlertEvaluation({ ...lease, draft })).rejects.toThrow(
          'domain lease expired',
        );
        expect(await f.tenant.getReceipt('fenced')).toBeNull();
        expect(await f.tenant.getPersonalAlertEvaluation('personal-alerts:fenced')).toBeNull();
        expect(await f.repos.watchRuleState.listByPool('price-plan')).toHaveLength(0);
        expect(await f.repos.watchTrigger.listByPool('price-plan')).toHaveLength(0);
        expect(await f.tenant.listOutbox()).toHaveLength(0);
      } finally {
        f.close();
      }
    });
    it('rejects changed member and rule snapshots before committing formal facts', async () => {
      const f = await fixture(mode);
      try {
        await importStocks(f.repos, '600519', 'members');
        const saved = await savePlan(f.tenant, pricePlan(), 'plan');
        const lease = await claimAlert(f.repos, 'stale-rules');
        await savePlan(
          f.tenant,
          {
            ...saved.plan,
            rules: [{ id: 'above', kind: 'price-level', level: 200, side: 'above' }],
          },
          'rule-edit',
          saved.planRevision,
        );
        await expect(
          f.tenant.commitPersonalAlertEvaluation({
            ...lease,
            draft: {
              domainLeaseOwner: lease.owner,
              evaluatedAt: alertNow,
              quotes: [priceQuote(90)],
              quoteErrors: [],
            },
          }),
        ).rejects.toThrow('input changed');
        await f.repos.watchTrigger.releaseExecution(lease.owner);
        const memberLease = await claimAlert(f.repos, 'stale-members');
        await f.tenant.removePersonalMembers({
          watchlistId: 'personal',
          stockIds: [stock.id],
          ownerUserId: 'user-one',
          requestId: 'remove',
          now: alertNow,
        });
        await expect(
          f.tenant.commitPersonalAlertEvaluation({
            ...memberLease,
            draft: {
              domainLeaseOwner: memberLease.owner,
              evaluatedAt: alertNow,
              quotes: [priceQuote(90)],
              quoteErrors: [],
            },
          }),
        ).rejects.toThrow('input changed');
        await f.repos.watchTrigger.releaseExecution(memberLease.owner);
        expect(await f.tenant.getReceipt('stale-rules')).toBeNull();
        expect(await f.tenant.getReceipt('stale-members')).toBeNull();
        expect(await f.repos.watchRuleState.listByPool('price-plan')).toHaveLength(0);
        expect(await f.tenant.listOutbox()).toHaveLength(0);
      } finally {
        f.close();
      }
    });
    it('holds known edges on unavailable, stale or retrieval-only quotes and never fabricates recovery', async () => {
      const f = await fixture(mode);
      try {
        await importStocks(f.repos, '600519', 'members');
        await savePlan(f.tenant, pricePlan('price-plan', { notifyOnRecovery: true }), 'plan');
        await commitAlert(f.repos, 'baseline', 110);
        const previous = await f.repos.watchRuleState.listByPool('price-plan');
        const missing = await commitAlert(
          f.repos,
          'missing',
          null,
          new Date(alertNow.getTime() + 5000),
        );
        expect(missing.receipt.status).toBe('partial');
        expect(missing.evaluation.triggers).toHaveLength(0);
        expect(await f.repos.watchRuleState.listByPool('price-plan')).toEqual(previous);
        const at = new Date(alertNow.getTime() + 10000);
        const lease = await claimAlert(f.repos, 'retrieval', at);
        const quote = {
          ...priceQuote(90, at),
          observedAt: at,
          ts: at,
          timestampSource: 'retrieval' as const,
        };
        const result = await f.tenant.commitPersonalAlertEvaluation({
          ...lease,
          draft: {
            domainLeaseOwner: lease.owner,
            evaluatedAt: at,
            quotes: [quote],
            quoteErrors: [],
          },
        });
        await f.repos.watchTrigger.releaseExecution(lease.owner);
        expect(result.evaluation.conditions[0]?.known).toBe(false);
        expect(result.evaluation.triggers).toHaveLength(0);
        expect(await f.repos.watchRuleState.listByPool('price-plan')).toEqual(previous);
        const staleLease = await claimAlert(f.repos, 'stale-quote', at);
        const stale = await f.tenant.commitPersonalAlertEvaluation({
          ...staleLease,
          draft: {
            domainLeaseOwner: staleLease.owner,
            evaluatedAt: at,
            quotes: [
              {
                ...priceQuote(90, at),
                observedAt: new Date(at.getTime() - 121_000),
                ts: new Date(at.getTime() - 121_000),
              },
            ],
            quoteErrors: [],
          },
        });
        await f.repos.watchTrigger.releaseExecution(staleLease.owner);
        expect(stale.receipt.status).toBe('partial');
        expect(await f.repos.watchRuleState.listByPool('price-plan')).toEqual(previous);
      } finally {
        f.close();
      }
    });
    it('honors daily-first across all entered edges and allows a new trading day', async () => {
      const f = await fixture(mode);
      try {
        await importStocks(f.repos, '600519', 'members');
        await savePlan(
          f.tenant,
          pricePlan('price-plan', {
            rules: [{ id: 'change', kind: 'price-change', pct: 0.03, direction: 'up' }],
            triggerMode: 'daily-first',
          }),
          'plan',
        );
        await commitAlert(f.repos, 'baseline', 100);
        const first = await commitAlert(f.repos, 'first', 105, new Date(alertNow.getTime() + 5000));
        expect(first.evaluation.triggers).toHaveLength(1);
        await commitAlert(f.repos, 'leave', 100, new Date(alertNow.getTime() + 10000));
        const reenter = await commitAlert(
          f.repos,
          'reenter',
          105,
          new Date(alertNow.getTime() + 15000),
        );
        expect(reenter.evaluation.triggers).toHaveLength(0);
        const tomorrow = new Date('2026-10-13T02:00:00Z');
        const next = await commitAlert(f.repos, 'tomorrow', 105, tomorrow);
        expect(next.evaluation.triggers).toHaveLength(1);
        expect(next.evaluation.triggers[0]?.deliveryStatus).toBe('pending');
      } finally {
        f.close();
      }
    });
    it('counts queued targets toward tenant-wide daily cap and cooldown before external sends', async () => {
      const f = await fixture(mode);
      try {
        await importStocks(f.repos, '600519', 'members');
        await savePlan(
          f.tenant,
          pricePlan('price-plan', {
            rules: [
              { id: 'one', kind: 'price-level', level: 100, side: 'above' },
              { id: 'two', kind: 'price-level', level: 105, side: 'above' },
            ],
          }),
          'plan',
        );
        await commitAlert(f.repos, 'baseline', 90, alertNow, 1);
        const entered = await commitAlert(
          f.repos,
          'entered',
          110,
          new Date(alertNow.getTime() + 5000),
          1,
        );
        expect(entered.evaluation.triggers.map((trigger) => trigger.deliveryStatus)).toEqual([
          'pending',
          'suppressed-daily-limit',
        ]);
        expect(
          (await f.tenant.listOutbox()).find((event) => event.operationId === 'entered')
            ?.deliveries,
        ).toHaveLength(1);
        await commitAlert(f.repos, 'leave', 90, new Date(alertNow.getTime() + 10000), 1);
        const reentered = await commitAlert(
          f.repos,
          'again',
          110,
          new Date(alertNow.getTime() + 15000),
          1,
        );
        expect(reentered.evaluation.triggers.map((trigger) => trigger.deliveryStatus)).toEqual([
          'suppressed-cooldown',
          'suppressed-daily-limit',
        ]);
        expect(
          (await f.tenant.listOutbox()).find((event) => event.operationId === 'again')?.deliveries,
        ).toHaveLength(0);
      } finally {
        f.close();
      }
    });
    it('uses one ALL edge and recovery while unknown price-change input preserves its state', async () => {
      const f = await fixture(mode);
      try {
        await importStocks(f.repos, '600519', 'members');
        await savePlan(
          f.tenant,
          pricePlan('price-plan', {
            logic: 'ALL',
            cooldownMinutes: 0,
            notifyOnRecovery: true,
            rules: [
              { id: 'level', kind: 'price-level', level: 100, side: 'above' },
              { id: 'change', kind: 'price-change', pct: 0.03, direction: 'up' },
            ],
          }),
          'plan',
        );
        await commitAlert(f.repos, 'baseline', 90);
        const entered = await commitAlert(
          f.repos,
          'all-entered',
          110,
          new Date(alertNow.getTime() + 5000),
        );
        expect(entered.evaluation.triggers).toHaveLength(1);
        expect(entered.evaluation.triggers[0]?.ruleId).toBe('composite');
        const previous = await f.repos.watchRuleState.listByPool('price-plan');
        const at = new Date(alertNow.getTime() + 10000);
        const lease = await claimAlert(f.repos, 'no-prev-close', at);
        const { prevClose: _prevClose, ...quote } = priceQuote(90, at);
        const unknown = await f.tenant.commitPersonalAlertEvaluation({
          ...lease,
          draft: {
            domainLeaseOwner: lease.owner,
            evaluatedAt: at,
            quotes: [quote],
            quoteErrors: [],
          },
        });
        await f.repos.watchTrigger.releaseExecution(lease.owner);
        expect(unknown.evaluation.status).toBe('partial');
        expect(unknown.evaluation.triggers).toHaveLength(0);
        expect(await f.repos.watchRuleState.listByPool('price-plan')).toEqual(previous);
        const recovered = await commitAlert(
          f.repos,
          'recovered',
          90,
          new Date(alertNow.getTime() + 15000),
        );
        expect(recovered.evaluation.triggers).toHaveLength(1);
        expect(recovered.evaluation.triggers[0]).toMatchObject({
          ruleId: 'composite',
          triggerType: 'recovered',
          direction: 'watch',
        });
      } finally {
        f.close();
      }
    });
    it('reserves mail retries idempotently against the daily cap and rejects paused plans', async () => {
      const f = await fixture(mode);
      try {
        await importStocks(f.repos, '600519', 'members');
        const saved = await savePlan(
          f.tenant,
          pricePlan('mail-plan', { dailyNotificationLimit: 2 }),
          'plan',
        );
        await commitAlert(f.repos, 'mail-baseline', 90);
        const at = new Date(alertNow.getTime() + 5000);
        const entered = await commitAlert(f.repos, 'mail-entered', 110, at);
        const triggerId = entered.evaluation.triggers[0]?.id;
        if (triggerId === undefined) throw new Error('trigger missing');
        const input = {
          triggerId,
          channel: 'email' as const,
          emailAttempt: 1,
          maxDailyNotifications: 20,
          now: at,
        };
        expect((await f.tenant.preparePersonalDelivery(input)).eligible).toBe(true);
        expect((await f.tenant.preparePersonalDelivery(input)).trigger?.deliveryAttempts).toBe(1);
        await f.tenant.syncPersonalDelivery({
          triggerId,
          channel: 'email',
          attempts: 1,
          state: 'failed',
          notificationId: 'mail-intent',
          now: at,
        });
        expect(
          (await f.tenant.preparePersonalDelivery({ ...input, emailAttempt: 2 })).eligible,
        ).toBe(true);
        expect(
          (await f.tenant.preparePersonalDelivery({ ...input, emailAttempt: 3 })).eligible,
        ).toBe(false);
        expect((await f.repos.watchTrigger.findById(triggerId))?.deliveryAttempts).toBe(2);
        await f.tenant.syncPersonalDelivery({
          triggerId,
          channel: 'email',
          attempts: 1,
          state: 'unknown',
          notificationId: 'mail-intent',
          now: at,
        });
        expect((await f.repos.watchTrigger.findById(triggerId))?.deliveryAttempts).toBe(2);
        await savePlan(
          f.tenant,
          { ...saved.plan, enabled: false },
          'mail-pause',
          saved.planRevision,
          new Date(at.getTime() + 1000),
        );
        expect((await f.tenant.preparePersonalDelivery(input)).eligible).toBe(false);
        expect(
          (await f.tenant.getPersonalAlertEvaluation(entered.evaluation.id))?.triggers[0]
            ?.deliveryStatus,
        ).toBe('pending');
      } finally {
        f.close();
      }
    });
    it('invalidates pending deliveries on edit or deletion but preserves immutable trigger history', async () => {
      const f = await fixture(mode);
      try {
        await importStocks(f.repos, '600519', 'members');
        const saved = await savePlan(f.tenant, pricePlan(), 'plan');
        await commitAlert(f.repos, 'baseline', 90);
        const entered = await commitAlert(
          f.repos,
          'entered',
          110,
          new Date(alertNow.getTime() + 5000),
        );
        const paused = await savePlan(
          f.tenant,
          { ...saved.plan, enabled: false },
          'pause',
          saved.planRevision,
          new Date(alertNow.getTime() + 10000),
        );
        expect(await f.repos.watchRuleState.listByPool(saved.plan.id)).toHaveLength(0);
        expect(
          (await f.repos.watchTrigger.findById(entered.evaluation.triggers[0]?.id as string))
            ?.deliveryStatus,
        ).toBe('invalidated');
        expect(
          (await f.tenant.getPersonalAlertEvaluation(entered.evaluation.id))?.triggers[0]
            ?.deliveryStatus,
        ).toBe('pending');
        const removal = {
          alertPlanId: paused.plan.id,
          expectedPlanRevision: paused.planRevision,
          requestId: 'delete',
          now: new Date(alertNow.getTime() + 15000),
        };
        const deleted = await f.tenant.removePersonalAlertPlan(removal);
        expect(await f.tenant.removePersonalAlertPlan(removal)).toEqual(deleted);
        await expect(
          f.tenant.removePersonalAlertPlan({ ...removal, expectedPlanRevision: 'a'.repeat(64) }),
        ).rejects.toThrow('identity conflict');
        expect(await f.repos.alertPlan.findById(paused.plan.id)).toBeNull();
        expect(await f.repos.watchTrigger.listByPool(paused.plan.id)).toHaveLength(1);
      } finally {
        f.close();
      }
    });
  });
const claim = async (
  tenant: TenantRepository,
  operationId: string,
  inputHash = 'c'.repeat(64),
  at = now,
) => {
  await tenant.putExecutionRequest({
    operationId,
    inputHash,
    generation: 1,
    kind: 'watchlist-facts',
    input: { watchlistId: 'personal', period: '2026-10-10' },
    createdAt: now,
  });
  const claimed = await tenant.claimExecution({
    operationId,
    generation: 1,
    attemptId: `${operationId}-attempt`,
    now: at,
    leaseMs: 120_000,
  });
  if (claimed.kind !== 'claimed') throw new Error('expected execution lease');
  return {
    operationId,
    inputHash,
    generation: 1,
    fence: claimed.lease.fence,
    attemptId: claimed.lease.attemptId,
    now: at,
    notificationPolicy: 'eligible' as const,
    businessKey: 'watchlist-facts:personal:2026-10-10',
  };
};
