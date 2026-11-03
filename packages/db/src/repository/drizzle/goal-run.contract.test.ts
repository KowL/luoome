import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnalysisContext, type GoalCommand, type GoalRun, GoalRunSchema } from '@luoome/core';
import { createDrizzleRepos, ensureSchema } from '../../client.js';
import { createInMemoryRepos } from '../memory/index.js';

const now = new Date('2026-11-02T04:00:00Z');
const pending = (): GoalRun =>
  GoalRunSchema.parse({
    id: 'goal',
    accountId: 'account',
    requestId: 'request',
    requestHash: 'hash',
    request: {
      goal: '核实研究条件',
      kind: 'advice_stock',
      subject: { kind: 'stock', id: '600519.SH' },
      provider: 'fixture',
      model: 'model',
      maxRounds: 2,
      estimatedTokens: 100,
      estimatedDurationMs: 1000,
    },
    status: 'pending',
    version: 0,
    hostJobId: null,
    attempts: [],
    blockedCondition: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  });
const facts = [{ id: 'fact', label: 'quote', value: 100, evidenceIds: [] }];
const context: AnalysisContext = {
  id: 'context',
  accountId: 'account',
  kind: 'advice_stock',
  jobId: null,
  subject: { kind: 'stock', id: '600519.SH' },
  facts,
  factIds: ['fact'],
  dataAsOf: now,
  createdAt: now,
  writeUntil: now,
  expiresAt: now,
  missingFacts: [],
  limitations: [],
  contextHash: createHash('sha256')
    .update(JSON.stringify({ facts, dataAsOf: now }))
    .digest('hex'),
};
const attempt = (factIds = ['fact']): GoalCommand => ({
  type: 'attempt',
  attempt: {
    round: 1,
    revision: 0,
    contextId: 'context',
    tokenUsed: 12,
    error: null,
    output: {
      summary: '持久化行情支持的研究结论',
      factIds,
      needsRevision: false,
      status: 'completed',
      blockedCondition: null,
    },
  },
});
for (const mode of ['memory', 'drizzle'] as const)
  describe(`GoalRunRepository [${mode}]`, () => {
    const setup = () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      const repos = handle?.repos ?? createInMemoryRepos();
      return { repos, repo: repos.goalRun, close: () => handle?.close() };
    };
    it('isolates accounts, replays requests and rejects conflicting identities', async () => {
      const { repo, close } = setup();
      try {
        const first = await repo.create(pending());
        first.run.request.goal = 'mutated outside repository';
        expect((await repo.find('account', 'goal'))?.request.goal).toBe('核实研究条件');
        expect((await repo.create(pending())).replayed).toBe(true);
        await expect(repo.create({ ...pending(), requestHash: 'different' })).rejects.toThrow();
        expect(await repo.find('other-account', 'goal')).toBeNull();
        expect(await repo.cancel('other-account', 'goal', now)).toBeNull();
        expect(
          await repo.apply({
            accountId: 'other-account',
            id: 'goal',
            expectedVersion: 0,
            command: { type: 'start', hostJobId: 'host' },
            now,
          }),
        ).toBeNull();
      } finally {
        close();
      }
    });
    it('requires persisted evidence, fences stale versions, and keeps successful output immutable', async () => {
      const { repo, repos, close } = setup();
      try {
        await repo.create(pending());
        await repo.apply({
          accountId: 'account',
          id: 'goal',
          expectedVersion: 0,
          command: { type: 'start', hostJobId: 'host' },
          now,
        });
        const record = (command: GoalCommand, expectedVersion = 1) =>
          repo.apply({ accountId: 'account', id: 'goal', expectedVersion, command, now });
        await expect(record(attempt())).rejects.toThrow('goal_persisted_context_required');
        await repos.analysis.saveContext(context);
        await expect(record(attempt(['invented']))).rejects.toThrow('goal_unknown_fact_reference');
        expect((await repo.find('account', 'goal'))?.version).toBe(1);
        expect(await record(attempt(), 0)).toBeNull();
        const completed = await record(attempt());
        expect(completed?.status).toBe('completed');
        expect(completed?.attempts[0]?.output?.factIds).toEqual(['fact']);
        expect(await repo.cancel('account', 'goal', now)).toBeNull();
        expect(await record(attempt(), 2)).toBeNull();
        expect(await repo.find('account', 'goal')).toEqual(completed);
      } finally {
        close();
      }
    });
    it('does not let an in-flight context lookup overwrite committed cancellation', async () => {
      const { repo, repos, close } = setup();
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const observed = new Promise<void>((done) => {
        entered = done;
      });
      const original = repos.analysis.findContext.bind(repos.analysis);
      try {
        await repo.create(pending());
        await repos.analysis.saveContext(context);
        await repo.apply({
          accountId: 'account',
          id: 'goal',
          expectedVersion: 0,
          command: { type: 'start', hostJobId: 'host' },
          now,
        });
        repos.analysis.findContext = async (accountId, id) => {
          entered();
          await gate;
          return original(accountId, id);
        };
        const writing = repo.apply({
          accountId: 'account',
          id: 'goal',
          expectedVersion: 1,
          command: attempt(),
          now,
        });
        await observed;
        const cancelled = await repo.cancel('account', 'goal', now);
        release();
        expect(await writing).toBeNull();
        expect(cancelled?.status).toBe('cancelled');
        expect((await repo.find('account', 'goal'))?.attempts).toEqual([]);
      } finally {
        release();
        close();
      }
    });
  });
it('keeps goal progress across restart and idempotent schema migration', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'luoome-goal-contract-'));
  const path = join(directory, 'facts.db');
  const first = createDrizzleRepos(path);
  try {
    await first.repos.goalRun.create(pending());
    ensureSchema(first.db);
    ensureSchema(first.db);
  } finally {
    first.close();
  }
  const second = createDrizzleRepos(path);
  try {
    expect(await second.repos.goalRun.find('account', 'goal')).toEqual(pending());
  } finally {
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
