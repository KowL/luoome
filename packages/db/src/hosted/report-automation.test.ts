import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportSchema, type RepositoryRegistry } from '@luoome/core';
import { createDrizzleRepos } from '../client.js';
import { createInMemoryRepos } from '../repository/memory/index.js';

const now = new Date('2026-10-15T01:00:00Z');
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const report = (kind: 'opening' | 'closing' = 'opening') =>
  ReportSchema.parse({
    id: `report-${kind}`,
    version: 1,
    kind,
    scope: { kind: 'account', accountId: 'account' },
    periodStart: '2026-10-15',
    periodEnd: '2026-10-15',
    title: 'fixture',
    generatedAt: now,
    dataAsOf: now,
    status: 'complete',
    sections: [
      {
        key: 'facts',
        title: '事实',
        required: true,
        status: 'complete',
        blocks: [{ kind: 'text', tone: 'factual', text: 'fixture fact' }],
        evidenceIds: [],
        missingDimensions: [],
      },
    ],
    evidence: [],
    missingDimensions: [],
    deliveryStatus: 'not-requested',
    workflowRunId: 'run',
    createdAt: now,
    updatedAt: now,
  });
const seed = async (repos: RepositoryRegistry) => {
  expect(await repos.reportAutomation.execution('acquire', 'A', now)).toBe(true);
  const saved = await repos.reportAutomation.commit(report(), 'A', now);
  expect(saved?.id).toBe('report-opening');
  expect(
    await repos.reportAutomation.prepare({
      reportId: 'report-opening',
      owner: 'A',
      tenantId: 'tenant',
      generation: 1,
      now,
    }),
  ).toBe(true);
};
const claim = (repos: RepositoryRegistry, at = now, owner = 'A') =>
  repos.reportAutomation.claim('report-opening', owner, `attempt-${at.getTime()}`, at);
const contract = (name: string, factory: () => RepositoryRegistry) =>
  describe(name, () => {
    test.each(['opening', 'closing'] as const)(
      '%s is immutable across duplicate generation and ordinary upserts',
      async (kind) => {
        const repos = factory();
        await repos.reportAutomation.execution('acquire', 'A', now);
        const first = report(kind);
        await repos.reportAutomation.commit(first, 'A', now);
        const changed = { ...first, id: 'another-id', title: 'late data' };
        expect(await repos.reportAutomation.commit(changed, 'A', now)).toEqual(first);
        expect(await repos.report.upsertForPeriod(changed)).toEqual(first);
        expect(await repos.report.list({})).toHaveLength(1);
      },
    );
    test('lease takeover fences commits, delivery claims and late completion; interrupted sends become unknown', async () => {
      const repos = factory();
      await seed(repos);
      await claim(repos);
      const later = new Date(now.getTime() + 120_000);
      expect(await repos.reportAutomation.execution('acquire', 'B', later)).toBe(true);
      expect(await repos.reportAutomation.execution('renew', 'A', later)).toBe(false);
      await repos.reportAutomation.execution('release', 'A', later);
      expect(await repos.reportAutomation.commit(report('closing'), 'A', later)).toBeNull();
      expect(await claim(repos, later, 'A')).toBeNull();
      expect(
        await repos.reportAutomation.complete({
          reportId: 'report-opening',
          owner: 'A',
          attemptId: `attempt-${now.getTime()}`,
          state: 'accepted',
          notificationId: 'notification',
          errorKind: null,
          now: later,
        }),
      ).toBe(false);
      await repos.reportAutomation.recover('B', later);
      expect((await repos.reportAutomation.list())[0]?.state).toBe('unknown');
      expect((await repos.report.findById('report-opening'))?.deliveryStatus).toBe('unverifiable');
      expect(await claim(repos, later, 'B')).toBeNull();
    });
    test('heartbeats renew beyond the original lease and released ticks are limited to once per minute', async () => {
      const repos = factory();
      await seed(repos);
      const renewal = new Date(now.getTime() + 90_000);
      expect(await repos.reportAutomation.execution('renew', 'A', renewal)).toBe(true);
      expect(
        await repos.reportAutomation.execution('acquire', 'B', new Date(now.getTime() + 130_000)),
      ).toBe(false);
      await repos.reportAutomation.execution('release', 'A', renewal);
      expect(await repos.reportAutomation.execution('acquire', 'B', renewal)).toBe(true);
      await repos.reportAutomation.execution('release', 'B', renewal);
      expect(await repos.reportAutomation.execution('acquire', 'C', renewal)).toBe(false);
    });
    test('accepted is not a device delivery and terminal outcomes are not claimed again', async () => {
      const repos = factory();
      await seed(repos);
      await claim(repos);
      expect(
        await repos.reportAutomation.complete({
          reportId: 'report-opening',
          owner: 'A',
          attemptId: `attempt-${now.getTime()}`,
          state: 'accepted',
          notificationId: 'notification',
          errorKind: null,
          now,
        }),
      ).toBe(true);
      expect((await repos.reportAutomation.list())[0]).toMatchObject({
        state: 'accepted',
        deliveredAt: null,
        providerMessageId: null,
        attempt: 1,
      });
      expect(await claim(repos)).toBeNull();
    });
    test('same-day retries use one/five minute backoff and stop after three attempts', async () => {
      const repos = factory();
      await seed(repos);
      let at = now;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        expect((await claim(repos, at))?.attempt).toBe(attempt);
        await repos.reportAutomation.complete({
          reportId: 'report-opening',
          owner: 'A',
          attemptId: `attempt-${at.getTime()}`,
          state: 'failed',
          notificationId: 'notification',
          errorKind: 'provider-rejected',
          now: at,
        });
        expect(await claim(repos, new Date(at.getTime() + 1))).toBeNull();
        at = new Date(at.getTime() + (attempt === 1 ? 60_000 : 300_000));
        await repos.reportAutomation.execution('acquire', 'A', at);
        await repos.reportAutomation.execution('renew', 'A', at);
      }
      expect(await claim(repos, at)).toBeNull();
    });
    test.each(['revoked', 'rebound', 'expired', 'tenant-unavailable'] as const)(
      'blocks pending delivery after %s without changing the report body',
      async (condition) => {
        const repos = factory();
        await seed(repos);
        let at = now;
        const body = (await repos.report.findById('report-opening'))?.sections;
        if (condition === 'revoked' || condition === 'rebound') {
          const settings = await repos.watchDelivery.settings();
          await repos.watchDelivery.saveSettings({
            ...settings,
            expectedRevision: settings.revision,
            enabled: condition !== 'revoked',
            webhookUrl:
              condition === 'rebound'
                ? 'https://open.feishu.cn/open-apis/bot/v2/hook/new-binding'
                : null,
            now,
          });
        } else if (condition === 'expired') {
          at = new Date('2026-10-15T16:00:00Z');
          await repos.reportAutomation.execution('acquire', 'A', at);
        } else await repos.reportAutomation.suppressPending(condition, at);
        await repos.reportAutomation.recover('A', at);
        expect(await claim(repos, at)).toBeNull();
        expect((await repos.reportAutomation.list())[0]?.state).toBe('suppressed');
        expect((await repos.report.findById('report-opening'))?.sections).toEqual(body);
      },
    );
  });
contract('memory report automation', createInMemoryRepos);
contract('Drizzle report automation', () => {
  const handle = createDrizzleRepos(':memory:');
  cleanup.push(handle.close);
  return handle.repos;
});

test('SQLite restart and independent tenant files retain one report, unknown send and current fence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-report-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'tenant.sqlite');
  const first = createDrizzleRepos(path);
  await seed(first.repos);
  await claim(first.repos);
  first.close();
  const second = createDrizzleRepos(path);
  cleanup.push(second.close);
  const other = createDrizzleRepos(join(root, 'other.sqlite'));
  cleanup.push(other.close);
  const later = new Date(now.getTime() + 120_000);
  expect(await second.repos.reportAutomation.execution('acquire', 'B', later)).toBe(true);
  await second.repos.reportAutomation.recover('B', later);
  expect((await second.repos.reportAutomation.list())[0]?.state).toBe('unknown');
  expect(await second.repos.report.list({})).toHaveLength(1);
  expect(await other.repos.report.list({})).toEqual([]);
  expect(await other.repos.reportAutomation.list()).toEqual([]);
});
