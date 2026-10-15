import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ReportSchema,
  type RepositoryRegistry,
  stockCode,
  WatchRuleStateSchema,
  WatchTriggerSchema,
} from '@luoome/core';
import {
  MarketRequestCoordinator,
  marketRequestConfigFromEnv,
} from '../../../adapters/src/market/request-coordinator.js';
import { createDrizzleRepos } from '../client.js';
import { createInMemoryRepos } from '../repository/memory/index.js';
import { createDrizzlePublicMarketStore } from './public-market-client.js';

const T0 = new Date('2026-10-15T02:00:00Z');
const EXPIRES = new Date(T0.getTime() + 120_000);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'luoome-ds4-store-'));
  cleanup.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
const trigger = () =>
  WatchTriggerSchema.parse({
    id: 'trigger',
    poolId: 'plan',
    stockId: '600519.SH',
    ruleId: 'price',
    ruleKind: 'price-level',
    direction: 'buy',
    priority: 'important',
    reason: 'fixture',
    evidence: ['price=110'],
    evalSnapshot: { ruleId: 'price' },
    quote: { close: 110, ts: T0 },
    deliveryStatus: 'pending',
    notified: false,
    createdAt: T0,
  });
const state = () =>
  WatchRuleStateSchema.parse({
    poolId: 'plan',
    stockId: '600519.SH',
    ruleId: 'price',
    active: true,
    firstTriggeredAt: T0,
    lastEvaluatedAt: T0,
  });
const report = () =>
  ReportSchema.parse({
    id: 'report',
    version: 1,
    kind: 'opening',
    scope: { kind: 'account', accountId: 'account' },
    periodStart: '2026-10-15',
    periodEnd: '2026-10-15',
    title: 'fixture',
    generatedAt: T0,
    dataAsOf: T0,
    status: 'complete',
    sections: [
      {
        key: 'facts',
        title: '事实',
        required: true,
        status: 'complete',
        blocks: [{ kind: 'text', tone: 'factual', text: 'fixture facts' }],
        evidenceIds: [],
        missingDimensions: [],
      },
    ],
    evidence: [],
    missingDimensions: [],
    workflowRunId: 'run',
    createdAt: T0,
    updatedAt: T0,
  });
const seed = async (repos: RepositoryRegistry) => {
  await repos.stock.save({
    id: '600519.SH',
    code: stockCode('600519'),
    exchange: 'SH',
    name: 'fixture',
  });
  await repos.watchlist.save({
    id: 'list',
    name: 'fixture',
    kind: 'personal',
    membershipPolicy: 'manual',
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });
  await repos.watchlistMember.saveMember({
    id: 'member',
    watchlistId: 'list',
    stockId: '600519.SH',
    stage: 'watching',
    priority: 'normal',
    firstAddedAt: T0,
    lastActivityAt: T0,
  });
  await repos.alertPlan.save({
    id: 'plan',
    name: 'fixture',
    watchlistId: 'list',
    rules: [{ id: 'price', kind: 'price-level', level: 100, side: 'above' }],
    logic: 'ANY',
    triggerMode: 'on-enter',
    cooldownMinutes: 10,
    dailyNotificationLimit: 3,
    notifyOnRecovery: false,
    enabled: true,
    createdAt: T0,
    updatedAt: T0,
  });
};
interface Harness {
  repos: RepositoryRegistry;
  restart(): RepositoryRegistry;
}
const memory = (): Harness => {
  const repos = createInMemoryRepos();
  return { repos, restart: () => repos };
};
const drizzle = (): Harness => {
  const path = join(root(), 'tenant.sqlite');
  let handle = createDrizzleRepos(path);
  cleanup.push(() => handle.close());
  return {
    repos: handle.repos,
    restart: () => {
      handle.close();
      handle = createDrizzleRepos(path);
      return handle.repos;
    },
  };
};
const phases = ['committed', 'pending', 'sending', 'accepted'] as const;
const contract = (name: string, factory: () => Harness) =>
  describe(name, () => {
    test.each([...phases])(
      'watch crash after %s retains one edge/trigger and rejects all writes by the abandoned owner',
      async (phase) => {
        const h = factory();
        await seed(h.repos);
        expect(await h.repos.watchTrigger.acquireExecution('abandoned', T0, EXPIRES)).toBe(true);
        expect(
          await h.repos.watchTrigger.commitEvaluation({
            owner: 'abandoned',
            now: T0,
            triggers: [trigger()],
            states: [state()],
          }),
        ).toBe(true);
        if (phase !== 'committed') {
          await h.repos.watchDelivery.prepare({
            owner: 'abandoned',
            tenantId: 'tenant',
            generation: 1,
            triggerIds: ['trigger'],
            now: T0,
          });
          await h.repos.watchTrigger.beginDelivery(['trigger'], T0, 'abandoned');
        }
        if (phase === 'sending' || phase === 'accepted')
          await h.repos.watchDelivery.claim({
            owner: 'abandoned',
            attemptId: 'attempt',
            triggerIds: ['trigger'],
            now: T0,
          });
        if (phase === 'accepted')
          await h.repos.watchDelivery.complete({
            owner: 'abandoned',
            attemptId: 'attempt',
            triggerIds: ['trigger'],
            state: 'accepted',
            notificationId: 'notification',
            errorKind: null,
            now: T0,
          });
        // 不调用 release：更换执行者；SQLite 实现还会关闭并重开连接。
        const repos = h.restart();
        expect(
          await repos.watchTrigger.acquireExecution(
            'successor',
            new Date(EXPIRES.getTime() - 1),
            new Date(EXPIRES.getTime() + 120_000),
          ),
        ).toBe(false);
        expect(
          await repos.watchTrigger.acquireExecution(
            'successor',
            EXPIRES,
            new Date(EXPIRES.getTime() + 120_000),
          ),
        ).toBe(true);
        expect(
          await repos.watchTrigger.renewExecution(
            'abandoned',
            EXPIRES,
            new Date(EXPIRES.getTime() + 120_000),
          ),
        ).toBe(false);
        expect(
          await repos.watchTrigger.commitEvaluation({
            owner: 'abandoned',
            now: EXPIRES,
            triggers: [{ ...trigger(), id: 'duplicate' }],
            states: [{ ...state(), active: false }],
          }),
        ).toBe(false);
        expect(await repos.watchTrigger.beginDelivery(['trigger'], EXPIRES, 'abandoned')).toBe(
          false,
        );
        expect(
          await repos.watchTrigger.setDeliveryStatus(
            ['trigger'],
            'sent',
            'late',
            EXPIRES,
            'abandoned',
          ),
        ).toBe(false);
        expect(
          await repos.watchDelivery.complete({
            owner: 'abandoned',
            attemptId: 'attempt',
            triggerIds: ['trigger'],
            state: 'accepted',
            notificationId: 'late',
            errorKind: null,
            now: EXPIRES,
          }),
        ).toBe(false);
        await repos.watchTrigger.releaseExecution('abandoned');
        expect(
          await repos.watchTrigger.renewExecution(
            'successor',
            EXPIRES,
            new Date(EXPIRES.getTime() + 120_000),
          ),
        ).toBe(true);
        await repos.watchDelivery.recover('successor', EXPIRES);
        expect(await repos.watchTrigger.listRecent({})).toHaveLength(1);
        expect(await repos.watchRuleState.listByPool('plan')).toMatchObject([
          { active: true, firstTriggeredAt: T0, lastEvaluatedAt: T0 },
        ]);
        const used = phase === 'committed' ? 0 : 1;
        expect(await repos.watchTrigger.countAttemptedSince(T0)).toBe(used);
        expect(await repos.watchTrigger.countAttemptedSince(T0, 'plan')).toBe(used);
        if (phase !== 'committed')
          expect((await repos.watchDelivery.list())[0]).toMatchObject({
            state: phase === 'sending' ? 'unknown' : phase,
            deliveredAt: null,
            attempt: phase === 'pending' ? 0 : 1,
          });
        await repos.watchDelivery.recover('successor', new Date(EXPIRES.getTime() + 1));
        expect(await repos.watchTrigger.countAttemptedSince(T0)).toBe(used);
      },
    );
    test.each([...phases])(
      'report crash after %s reuses the body and fences both late generation and late delivery',
      async (phase) => {
        const h = factory();
        expect(await h.repos.reportAutomation.execution('acquire', 'abandoned', T0)).toBe(true);
        const original = await h.repos.reportAutomation.commit(report(), 'abandoned', T0);
        if (phase !== 'committed')
          await h.repos.reportAutomation.prepare({
            reportId: 'report',
            owner: 'abandoned',
            tenantId: 'tenant',
            generation: 1,
            now: T0,
          });
        if (phase === 'sending' || phase === 'accepted')
          await h.repos.reportAutomation.claim('report', 'abandoned', 'attempt', T0);
        if (phase === 'accepted')
          await h.repos.reportAutomation.complete({
            reportId: 'report',
            owner: 'abandoned',
            attemptId: 'attempt',
            state: 'accepted',
            notificationId: 'notification',
            errorKind: null,
            now: T0,
          });
        const repos = h.restart();
        expect(
          await repos.reportAutomation.execution(
            'acquire',
            'successor',
            new Date(EXPIRES.getTime() - 1),
          ),
        ).toBe(false);
        expect(await repos.reportAutomation.execution('acquire', 'successor', EXPIRES)).toBe(true);
        expect(await repos.reportAutomation.execution('renew', 'abandoned', EXPIRES)).toBe(false);
        expect(
          await repos.reportAutomation.commit(
            { ...report(), id: 'late', title: 'late data' },
            'abandoned',
            EXPIRES,
          ),
        ).toBeNull();
        expect(
          await repos.reportAutomation.claim('report', 'abandoned', 'late', EXPIRES),
        ).toBeNull();
        expect(
          await repos.reportAutomation.complete({
            reportId: 'report',
            owner: 'abandoned',
            attemptId: 'attempt',
            state: 'accepted',
            notificationId: 'late',
            errorKind: null,
            now: EXPIRES,
          }),
        ).toBe(false);
        await repos.reportAutomation.execution('release', 'abandoned', EXPIRES);
        await repos.reportAutomation.recover('successor', EXPIRES);
        const reused = await repos.reportAutomation.commit(
          { ...report(), id: 'duplicate', title: 'new data' },
          'successor',
          EXPIRES,
        );
        expect(reused).toMatchObject({
          id: 'report',
          title: original?.title,
          sections: original?.sections,
          generatedAt: T0,
          dataAsOf: T0,
        });
        expect(await repos.report.list({})).toHaveLength(1);
        if (phase !== 'committed')
          expect((await repos.reportAutomation.list())[0]).toMatchObject({
            state: phase === 'sending' ? 'unknown' : phase,
            deliveredAt: null,
            attempt: phase === 'pending' ? 0 : 1,
          });
        expect(await repos.watchTrigger.countAttemptedSince(T0)).toBe(0);
      },
    );
  });
contract('memory abandoned worker contract', memory);
contract('Drizzle abandoned worker contract', drizzle);

test.each(['429', 'network'] as const)(
  'persisted provider cooldown survives a reopened store after %s without suppressed requests extending it',
  async (failure) => {
    const path = join(root(), 'public.sqlite');
    let now = T0.getTime();
    let calls = 0;
    const config = marketRequestConfigFromEnv({});
    const transport: typeof fetch = (async () => {
      calls += 1;
      if (calls > 1) return Response.json({ ok: true });
      if (failure === 'network') throw new TypeError('injected offline');
      return new Response(null, { status: 429, headers: { 'retry-after': '120' } });
    }) as unknown as typeof fetch;
    const request = () =>
      new MarketRequestCoordinator(
        createDrizzlePublicMarketStore(path),
        config,
        () => now,
      ).fetchFor(
        'eastmoney',
        transport,
      )('https://push2.eastmoney.com/quote');
    await expect(request()).rejects.toMatchObject({
      kind: failure === '429' ? 'rate_limited' : 'network',
    });
    const deadline = now + (failure === '429' ? 120_000 : 60_000);
    for (const time of [now + 1, now + 30_000, deadline - 1]) {
      now = time;
      const results = await Promise.allSettled(Array.from({ length: 10 }, request));
      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      expect(calls).toBe(1);
      expect(
        JSON.parse(createDrizzlePublicMarketStore(path).read('provider:eastmoney', now) ?? '{}')
          .blockedUntil,
      ).toBe(deadline);
    }
    now = deadline;
    expect((await request()).ok).toBe(true);
    expect(calls).toBe(2);
  },
);
