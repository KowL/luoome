import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RepositoryRegistry, stockCode, WatchTriggerSchema } from '@luoome/core';
import { createDrizzleRepos } from '../client.js';
import { createInMemoryRepos } from '../repository/memory/index.js';

const T0 = new Date('2026-10-15T02:00:00Z');
const until = new Date(T0.getTime() + 120_000);
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
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
    enabled: true,
    logic: 'ANY',
    triggerMode: 'on-enter',
    cooldownMinutes: 15,
    dailyNotificationLimit: 20,
    notifyOnRecovery: false,
    rules: [{ id: 'price', kind: 'price-level', level: 100, side: 'above' }],
    createdAt: T0,
    updatedAt: T0,
  });
  await repos.watchTrigger.save(
    WatchTriggerSchema.parse({
      id: 'trigger',
      poolId: 'plan',
      stockId: '600519.SH',
      ruleId: 'price',
      ruleKind: 'price-level',
      triggerType: 'triggered',
      direction: 'watch',
      priority: 'normal',
      reason: 'fixture',
      evidence: ['fixture'],
      evalSnapshot: {},
      deliveryStatus: 'pending',
      notified: false,
      createdAt: T0,
    }),
  );
  expect(await repos.watchTrigger.acquireExecution('owner-A', T0, until)).toBe(true);
  expect(
    await repos.watchDelivery.prepare({
      owner: 'owner-A',
      tenantId: 'tenant-A',
      generation: 1,
      triggerIds: ['trigger'],
      now: T0,
    }),
  ).toBe(true);
};
const claim = (repos: RepositoryRegistry, now = T0, owner = 'owner-A') =>
  repos.watchDelivery.claim({
    owner,
    attemptId: `attempt-${now.getTime()}`,
    triggerIds: ['trigger'],
    now,
  });

const contract = (name: string, factory: () => RepositoryRegistry) =>
  describe(name, () => {
    test('recognizes persisted trading-plan sources without requiring a synthetic AlertPlan, and rejects malformed sources', async () => {
      const repos = factory();
      await seed(repos);
      const original = await repos.watchTrigger.findById('trigger');
      if (original === null) throw new Error('fixture trigger missing');
      for (const valid of [true, false]) {
        const id = valid ? 'plan-trigger' : 'malformed-plan-trigger';
        await repos.watchTrigger.save({
          ...original,
          id,
          poolId: 'trading-plan-watch:account-A',
          ruleId: 'version-1:stop',
          evalSnapshot: valid
            ? {
                planVersionId: 'version-1',
                conditionId: 'stop',
                accountFactsDigest: 'fixture-digest',
                validUntil: new Date('2026-10-16T07:00:00Z'),
              }
            : {},
        });
        await repos.watchDelivery.prepare({
          owner: 'owner-A',
          tenantId: 'tenant-A',
          generation: 1,
          triggerIds: [id],
          now: T0,
        });
        const claimed = await repos.watchDelivery.claim({
          owner: 'owner-A',
          attemptId: 'plan-attempt',
          triggerIds: [id],
          now: T0,
        });
        if (valid) expect(claimed).toHaveLength(1);
        else expect(claimed).toBeNull();
      }
    });
    test('acceptance is persisted without fabricating a delivered receipt', async () => {
      const repos = factory();
      await seed(repos);
      const claimed = await claim(repos);
      expect(claimed).toHaveLength(1);
      expect(await claim(repos)).toBeNull();
      expect(
        await repos.watchDelivery.complete({
          owner: 'owner-A',
          attemptId: `attempt-${T0.getTime()}`,
          triggerIds: ['trigger'],
          state: 'accepted',
          notificationId: 'notification',
          errorKind: null,
          now: T0,
        }),
      ).toBe(true);
      expect((await repos.watchDelivery.list())[0]).toMatchObject({
        state: 'accepted',
        deliveredAt: null,
        providerMessageId: null,
        attempt: 1,
      });
    });
    test('expired owners cannot start, finish, or overwrite delivery state after takeover', async () => {
      const repos = factory();
      await seed(repos);
      await claim(repos);
      expect(
        await repos.watchTrigger.acquireExecution(
          'owner-B',
          until,
          new Date(until.getTime() + 120_000),
        ),
      ).toBe(true);
      expect(await repos.watchTrigger.beginDelivery(['trigger'], until, 'owner-A')).toBe(false);
      expect(
        await repos.watchTrigger.setDeliveryStatus(['trigger'], 'sent', 'old', until, 'owner-A'),
      ).toBe(false);
      expect(
        await repos.watchDelivery.complete({
          owner: 'owner-A',
          attemptId: `attempt-${T0.getTime()}`,
          triggerIds: ['trigger'],
          state: 'accepted',
          notificationId: 'old',
          errorKind: null,
          now: until,
        }),
      ).toBe(false);
      expect((await repos.watchDelivery.recover('owner-B', until))[0]?.state).toBe('unknown');
      expect(await claim(repos, until, 'owner-B')).toBeNull();
    });
    test.each(['paused', 'removed', 'revoked', 'expired'] as const)(
      'revalidates %s before claiming an unsent intent',
      async (condition) => {
        const repos = factory();
        await seed(repos);
        let now = T0;
        if (condition === 'paused') {
          const plan = await repos.alertPlan.findById('plan');
          if (!plan) throw new Error('fixture plan missing');
          await repos.alertPlan.save({ ...plan, enabled: false });
        } else if (condition === 'removed') {
          const member = (await repos.watchlistMember.listMembers('list'))[0];
          if (!member) throw new Error('fixture member missing');
          await repos.watchlistMember.saveMember({ ...member, stage: 'archived', archivedAt: now });
        } else if (condition === 'revoked') {
          const settings = await repos.watchDelivery.settings();
          await repos.watchDelivery.saveSettings({
            ...settings,
            expectedRevision: settings.revision,
            enabled: false,
            now,
          });
        } else {
          now = new Date('2026-10-15T16:00:00Z');
          await repos.watchTrigger.acquireExecution(
            'owner-A',
            now,
            new Date(now.getTime() + 120_000),
          );
        }
        expect((await repos.watchDelivery.recover('owner-A', now))[0]?.state).toBe('suppressed');
        expect(await claim(repos, now)).toBeNull();
        expect((await repos.watchDelivery.list())[0]?.state).toBe('suppressed');
      },
    );
    test('preserves retry backoff, caps attempts, and rejects stale preference revisions', async () => {
      const repos = factory();
      await seed(repos);
      let now = T0;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const claimed = await claim(repos, now);
        expect(claimed?.[0]?.attempt).toBe(attempt);
        expect(
          await repos.watchDelivery.complete({
            owner: 'owner-A',
            attemptId: `attempt-${now.getTime()}`,
            triggerIds: ['trigger'],
            state: 'failed',
            notificationId: `notification-${attempt}`,
            errorKind: 'provider-rejected',
            now,
          }),
        ).toBe(true);
        expect(await claim(repos, new Date(now.getTime() + 1))).toBeNull();
        now = new Date(now.getTime() + (attempt === 1 ? 60_000 : 300_000));
        await repos.watchTrigger.acquireExecution(
          'owner-A',
          now,
          new Date(now.getTime() + 600_000),
        );
        await repos.watchTrigger.renewExecution('owner-A', now, new Date(now.getTime() + 600_000));
      }
      expect(await claim(repos, now)).toBeNull();
      const settings = await repos.watchDelivery.settings();
      await repos.watchDelivery.saveSettings({
        ...settings,
        expectedRevision: 0,
        enabled: false,
        now,
      });
      await expect(
        repos.watchDelivery.saveSettings({ ...settings, expectedRevision: 0, now }),
      ).rejects.toThrow('revision conflict');
    });
  });
contract('memory watch delivery', createInMemoryRepos);
contract('Drizzle watch delivery', () => {
  const handle = createDrizzleRepos(':memory:');
  cleanup.push(handle.close);
  return handle.repos;
});

test('independent SQLite connections preserve crash state, isolation and fencing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'luoome-watch-delivery-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'tenant.sqlite');
  const first = createDrizzleRepos(path);
  await seed(first.repos);
  await claim(first.repos);
  first.close();
  const restarted = createDrizzleRepos(path);
  cleanup.push(restarted.close);
  expect(
    await restarted.repos.watchTrigger.acquireExecution(
      'owner-B',
      until,
      new Date(until.getTime() + 120_000),
    ),
  ).toBe(true);
  expect((await restarted.repos.watchDelivery.recover('owner-B', until))[0]?.state).toBe('unknown');
  const other = createDrizzleRepos(join(directory, 'other-tenant.sqlite'));
  cleanup.push(other.close);
  expect(await other.repos.watchDelivery.list()).toEqual([]);
  expect(await claim(restarted.repos, until, 'owner-B')).toBeNull();
});
