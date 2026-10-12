import { afterEach, describe, expect, it } from 'bun:test';
import {
  money,
  PersonalAlertPlanSchema,
  ReportSchema,
  type RepositoryRegistry,
  stockCode,
  WatchlistMemberSchema,
  WatchlistMemberSourceSchema,
  WatchlistSchema,
  WatchTriggerSchema,
} from '@luoome/core';
import { getTableColumns, sql } from 'drizzle-orm';
import { createDrizzleRepos, type DrizzleReposHandle } from '../client.js';
import { createInMemoryRepos } from '../repository/memory/index.js';
import { tenantExportHash } from './tenant-export-record.js';
import { ensureTenantExportSchema, tenantExportSnapshots } from './tenant-export-schema.js';

const NOW = new Date('2026-10-10T04:00:00.000Z');
const request = {
  operationId: 'export-operation',
  inputHash: 'a'.repeat(64),
  generation: 1,
  now: NOW,
};
const seed = async (repos: RepositoryRegistry) => {
  await repos.stock.save({
    id: '600519.SH',
    code: stockCode('600519'),
    exchange: 'SH',
    name: 'RAW-MARKET-EXCLUDED',
  });
  const watchlist = WatchlistSchema.parse({
    id: 'personal',
    name: '本人自选',
    kind: 'personal',
    membershipPolicy: 'mixed',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await repos.watchlist.save({
    ...watchlist,
    ...{ privateUnknownField: 'EXCLUDED-private-field' },
  });
  await repos.watchlist.save({ ...watchlist, id: 'system-list', kind: 'system' });
  const member = WatchlistMemberSchema.parse({
    id: 'member',
    watchlistId: 'personal',
    stockId: '600519.SH',
    stage: 'watching',
    priority: 'normal',
    firstAddedAt: NOW,
    lastActivityAt: NOW,
  });
  await repos.watchlistMember.saveMember(member);
  await repos.watchlistMember.saveSource(
    WatchlistMemberSourceSchema.parse({
      id: 'manual-source',
      memberId: 'member',
      kind: 'manual',
      sourceKey: 'manual:user',
      ownerUserId: 'CONTROL-OWNER-EXCLUDED',
      reason: '本人选择',
      evidence: [],
      status: 'active',
      validFrom: NOW,
    }),
  );
  await repos.watchlistMember.saveSource(
    WatchlistMemberSourceSchema.parse({
      id: 'strategy-source',
      memberId: 'member',
      kind: 'strategy',
      sourceKey: 'strategy:excluded',
      reason: 'STRATEGY-EXCLUDED',
      evidence: [],
      status: 'active',
      validFrom: NOW,
    }),
  );
  await repos.alertPlan.save(
    PersonalAlertPlanSchema.parse({
      id: 'price-plan',
      name: '本人价格观察',
      watchlistId: 'personal',
      rules: [{ id: 'above', kind: 'price-level', level: 100, side: 'above' }],
      logic: 'ANY',
      triggerMode: 'on-enter',
      cooldownMinutes: 5,
      dailyNotificationLimit: 10,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  const trigger = WatchTriggerSchema.parse({
    id: 'personal-trigger',
    poolId: 'price-plan',
    alertPlanId: 'price-plan',
    stockId: '600519.SH',
    ruleKind: 'price-level',
    ruleId: 'above',
    direction: 'watch',
    reason: '本人阈值已到',
    evidence: ['收盘价已到阈值'],
    quote: { close: money(110), ts: NOW },
    priority: 'normal',
    deliveryStatus: 'pending',
    notificationId: 'NOTIFICATION-SECRET-EXCLUDED',
    notified: false,
    evalSnapshot: {
      ruleId: 'above',
      kind: 'price-level',
      threshold: 100,
      secret: 'TRIGGER-SECRET-EXCLUDED',
    },
    createdAt: NOW,
  });
  await repos.watchTrigger.save(trigger);
  await repos.watchTrigger.save({
    ...trigger,
    id: 'cost-trigger',
    ruleKind: 'cost-threshold',
    direction: 'sell',
    reason: 'COST-EXCLUDED',
  });
  await repos.hostedTenant!.recordPersonalFeedback({
    triggerId: trigger.id,
    expectedRevision: 0,
    rating: 'useful',
    note: '本人复盘记录',
    requestId: 'feedback-1',
    inputHash: 'b'.repeat(64),
    now: NOW,
  });
  await repos.report.upsertForPeriod(
    ReportSchema.parse({
      id: 'facts-report',
      kind: 'watchlist-facts',
      scope: { kind: 'watchlist', watchlistId: 'personal' },
      periodStart: '2026-10-10',
      periodEnd: '2026-10-10',
      title: '已保存事实',
      generatedAt: NOW,
      dataAsOf: NOW,
      status: 'complete',
      sections: [
        {
          key: 'facts',
          title: '事实',
          required: true,
          status: 'complete',
          blocks: [{ kind: 'text', text: '自选与本人条件事实' }],
        },
      ],
      evidence: [],
      workflowRunId: 'WORKFLOW-EXCLUDED',
      watchlistFactsSnapshot: {
        schemaVersion: 1,
        watchlistRevision: 'c'.repeat(64),
        ruleFingerprint: 'd'.repeat(64),
        inputFingerprint: 'e'.repeat(64),
        rendererVersion: 'hosted-facts-v1',
        frozenInput: { rawReference: 'FROZEN-INPUT-EXCLUDED' },
      },
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
};

for (const mode of ['memory', 'drizzle'] as const)
  describe(`TenantExportRepository [${mode}]`, () => {
    const handles: DrizzleReposHandle[] = [];
    const setup = () => {
      if (mode === 'memory') return createInMemoryRepos();
      const handle = createDrizzleRepos(':memory:');
      handles.push(handle);
      return handle.repos;
    };
    afterEach(() => {
      for (const handle of handles.splice(0)) handle.close();
    });

    it('freezes only permitted business categories with a verifiable independent receipt', async () => {
      const repos = setup();
      await seed(repos);
      const result = await repos.hostedExports!.createSnapshot(request);
      expect(result.replayed).toBe(false);
      expect(result.snapshot).toMatchObject({
        formatVersion: 1,
        watchlists: [{ id: 'personal' }],
        members: [{ id: 'member' }],
        sources: [{ id: 'manual-source' }],
        alertPlans: [{ id: 'price-plan' }],
        triggers: [{ id: 'personal-trigger' }],
        reports: [{ id: 'facts-report' }],
        feedback: [{ note: '本人复盘记录' }],
      });
      expect(result.receipt.resultHash).toBe(tenantExportHash(result.snapshot));
      expect(result.receipt.resultRef).toBe(request.operationId);
      expect(JSON.stringify(result.snapshot)).not.toContain('EXCLUDED');
      expect(await repos.hostedTenant!.getReceipt(request.operationId)).toBeNull();
      expect(await repos.hostedTenant!.listOutbox()).toHaveLength(0);
      expect(await repos.hostedExports!.findSnapshot(request.operationId)).toEqual({
        operationId: result.operationId,
        inputHash: result.inputHash,
        generation: result.generation,
        snapshot: result.snapshot,
        receipt: result.receipt,
      });
    });

    it('reuses one immutable snapshot after subsequent writes and rejects changed operation identity', async () => {
      const repos = setup();
      await seed(repos);
      const first = await repos.hostedExports!.createSnapshot(request);
      await repos.watchlist.archive('personal', new Date(NOW.getTime() + 60_000));
      await repos.watchTrigger.remove('personal-trigger');
      const replay = await repos.hostedExports!.createSnapshot({
        ...request,
        now: new Date(NOW.getTime() + 120_000),
      });
      expect(replay.replayed).toBe(true);
      expect(replay.snapshot).toEqual(first.snapshot);
      expect(replay.receipt).toEqual(first.receipt);
      await expect(
        repos.hostedExports!.createSnapshot({ ...request, inputHash: 'f'.repeat(64) }),
      ).rejects.toThrow('identity conflict');
      await expect(
        repos.hostedExports!.createSnapshot({ ...request, generation: 2 }),
      ).rejects.toThrow('identity conflict');
      const fresh = await repos.hostedExports!.createSnapshot({
        ...request,
        operationId: 'fresh-export',
        now: new Date(NOW.getTime() + 120_000),
      });
      expect(fresh.snapshot.watchlists[0]?.enabled).toBe(false);
      expect(fresh.snapshot.triggers).toHaveLength(0);
      expect(fresh.snapshot.feedback).toHaveLength(1);
    });

    it('serializes concurrent requests and keeps different tenant repositories isolated', async () => {
      const a = setup();
      const b = setup();
      await seed(a);
      const results = await Promise.all([
        a.hostedExports!.createSnapshot(request),
        a.hostedExports!.createSnapshot(request),
      ]);
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(results[0]?.receipt.resultHash).toBe(results[1]?.receipt.resultHash);
      expect(await b.hostedExports!.findSnapshot(request.operationId)).toBeNull();
      const other = await b.hostedExports!.createSnapshot(request);
      expect(other.snapshot.watchlists).toHaveLength(0);
      expect(other.snapshot.feedback).toHaveLength(0);
      expect(other.receipt.resultHash).not.toBe(results[0]?.receipt.resultHash);
    });

    it('returns detached values that cannot mutate the stored artifact receipt', async () => {
      const repos = setup();
      await seed(repos);
      const result = await repos.hostedExports!.createSnapshot(request);
      result.snapshot.watchlists[0]!.name = 'client-mutated';
      const saved = await repos.hostedExports!.findSnapshot(request.operationId);
      expect(saved?.snapshot.watchlists[0]?.name).toBe('本人自选');
      expect(saved?.receipt.resultHash).toBe(tenantExportHash(saved?.snapshot));
    });
  });

it('keeps tenant export Drizzle columns synchronized with idempotent SQLite DDL', () => {
  const handle = createDrizzleRepos(':memory:');
  try {
    ensureTenantExportSchema(handle.db);
    expect(
      handle.db
        .all<{ name: string }>(sql`PRAGMA table_info(tenant_export_snapshots)`)
        .map((column) => column.name)
        .sort(),
    ).toEqual(
      Object.values(getTableColumns(tenantExportSnapshots))
        .map((column) => column.name)
        .sort(),
    );
  } finally {
    handle.close();
  }
});
