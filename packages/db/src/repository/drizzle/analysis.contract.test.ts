import { describe, expect, it } from 'bun:test';
import {
  type Advice,
  type AnalysisContext,
  type AnalysisJob,
  STANDARD_DISCLAIMERS,
} from '@luoome/core';
import { createDrizzleRepos, ensureSchema } from '../../client.js';
import { makeStrategy, makeStrategyVersion } from '../contract-tests.js';
import { createInMemoryRepos } from '../memory/index.js';

const now = new Date('2026-10-22T04:00:00Z');
const pending = (id = 'job'): AnalysisJob => ({
  id,
  kind: 'advice_stock',
  source: 'schedule',
  accountId: 'account',
  subject: { kind: 'stock', id: '600519.SH' },
  priority: 50,
  dedupeKey: 'key',
  payload: {},
  dataAsOf: now,
  notBefore: now,
  status: 'pending',
  attempts: 0,
  maxAttempts: 2,
  claimToken: null,
  claimedBy: null,
  leaseUntil: null,
  contextId: null,
  result: null,
  error: null,
  createdAt: now,
  updatedAt: now,
  finishedAt: null,
});
const context = (id = 'context'): AnalysisContext => ({
  id,
  jobId: 'job',
  kind: 'advice_stock',
  accountId: 'account',
  subject: pending().subject,
  dataAsOf: now,
  facts: [{ id: 'quote', label: '行情', value: 100, evidenceIds: [] }],
  factIds: ['quote'],
  limitations: ['无实时盘口'],
  contextHash: 'a'.repeat(64),
  writeUntil: new Date(now.getTime() + 86400000),
  expiresAt: new Date(now.getTime() + 31 * 86400000),
  createdAt: now,
});
const claim = (token = 'token', time = now) => ({
  accountId: 'account',
  jobId: 'job',
  owner: 'worker:test',
  token,
  now: time,
  leaseUntil: new Date(time.getTime() + 1000),
  context: context(token),
});

for (const mode of ['memory', 'drizzle'] as const) {
  describe(`AnalysisRepository [${mode}]`, () => {
    it('commits Advice and completion atomically, fences stale completion and replays the same result', async () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      const repos = handle?.repos ?? createInMemoryRepos();
      const repo = repos.analysis;
      try {
        await repo.enqueue(pending());
        await repo.claim(claim());
        const advice: Advice = {
          id: 'analysis:token',
          subjectKind: 'stock',
          subjectId: pending().subject.id,
          decision: 'watch',
          confidence: 50,
          horizon: 'short',
          reasoning: { premise: '观察', evidence: ['行情'], counterEvidence: ['未知量能'] },
          risks: ['数据有限'],
          disclaimers: STANDARD_DISCLAIMERS,
          basedOn: { dataAsOf: now },
          validFrom: now,
          validUntil: new Date(now.getTime() + 86400000),
          createdAt: now,
          provenance: {
            generatorKind: 'dsh-worker',
            contextId: 'token',
            jobId: 'job',
            evidenceFactIds: ['quote'],
            generatedAt: now,
          },
        };
        const input = {
          accountId: 'account',
          contextId: 'token',
          now,
          resultHash: 'hash',
          advice,
          claim: { jobId: 'job', token: 'token' },
        };
        expect(
          await repo.recordAdvice({ ...input, claim: { jobId: 'job', token: 'old' } }),
        ).toEqual({ ok: false, reason: 'lease_lost_before_commit' });
        expect(await repos.advice.findById(advice.id)).toBeNull();
        await expect(
          repo.recordAdvice({ ...input, advice: { ...advice, disclaimers: [] } }),
        ).rejects.toThrow();
        expect((await repo.findJob('account', 'job'))?.status).toBe('claimed');
        expect(await repos.advice.findById(advice.id)).toBeNull();
        expect((await repo.recordAdvice(input)).ok).toBe(true);
        expect((await repo.findJob('account', 'job'))?.status).toBe('completed');
        expect(await repos.advice.findById(advice.id)).toEqual(advice);
        expect(await repo.recordAdvice({ ...input, now: new Date(now.getTime() + 5000) })).toEqual({
          ok: true,
          advice,
          replayed: true,
        });
        expect(await repo.recordAdvice({ ...input, resultHash: 'other' })).toEqual({
          ok: false,
          reason: 'duplicate_result',
        });
        const { claim: _claim, ...direct } = input;
        expect(await repo.recordAdvice(direct)).toEqual({ ok: false, reason: 'duplicate_result' });
      } finally {
        handle?.close();
      }
    });

    const setup = () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      return {
        repo: (handle?.repos ?? createInMemoryRepos()).analysis,
        close: () => handle?.close(),
        handle,
      };
    };
    it('atomically publishes non-Advice research with fencing and idempotency', async () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      const repos = handle?.repos ?? createInMemoryRepos();
      const repo = repos.analysis;
      try {
        const job: AnalysisJob = {
          ...pending(),
          kind: 'research_directions',
          subject: { kind: 'research', id: 'directions' },
        };
        await repo.enqueue(job);
        const snapshot: AnalysisContext = {
          ...context('research-context'),
          kind: job.kind,
          subject: job.subject,
        };
        await repo.claim({ ...claim(), context: snapshot });
        const research = {
          id: 'analysis:research-context',
          ownerUserId: 'user',
          accountId: 'account',
          requestId: 'research-context',
          requestHash: 'result',
          question: '机会是否充分？',
          source: { userText: '机会是否充分？' },
          status: 'unavailable' as const,
          directions: [],
          evidence: [],
          limitations: ['缺少证据'],
          disclaimers: [...STANDARD_DISCLAIMERS],
          createdAt: now,
          provenance: {
            generatorKind: 'dsh-headless' as const,
            contextId: snapshot.id,
            jobId: job.id,
            evidenceFactIds: [],
            generatedAt: now,
          },
        };
        const input = {
          accountId: 'account',
          contextId: snapshot.id,
          now,
          resultHash: 'result',
          publication: { kind: 'research_directions' as const, research },
          claim: { jobId: job.id, token: 'token' },
        };
        expect(
          await repo.recordPublication({ ...input, claim: { ...input.claim, token: 'stale' } }),
        ).toEqual({ ok: false, reason: 'lease_lost_before_commit' });
        await expect(
          repo.recordPublication({
            ...input,
            publication: { ...input.publication, research: { ...research, disclaimers: [] } },
          }),
        ).rejects.toThrow();
        expect(
          await repos.investmentWorkspace.findResearch({
            ownerUserId: 'user',
            accountId: 'account',
            id: research.id,
          }),
        ).toBeNull();
        expect((await repo.findJob('account', job.id))?.status).toBe('claimed');
        expect(await repo.recordPublication(input)).toEqual({
          ok: true,
          resultRef: research.id,
          replayed: false,
        });
        expect((await repo.findJob('account', job.id))?.status).toBe('completed');
        expect(
          await repos.investmentWorkspace.findResearch({
            ownerUserId: 'user',
            accountId: 'account',
            id: research.id,
          }),
        ).toEqual(research);
        expect(await repo.recordPublication(input)).toEqual({
          ok: true,
          resultRef: research.id,
          replayed: true,
        });
        expect(await repo.recordPublication({ ...input, resultHash: 'different' })).toEqual({
          ok: false,
          reason: 'duplicate_result',
        });
      } finally {
        handle?.close();
      }
    });
    it('publishes only a pending draft and rejects stale narrative targets atomically', async () => {
      const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
      const repos = handle?.repos ?? createInMemoryRepos();
      try {
        await repos.strategy.create(makeStrategy('strategy'));
        const { publishedAt: _publishedAt, ...draft } = makeStrategyVersion('strategy', 1, {
          validationStatus: 'pending',
          validationErrors: [],
        });
        const snapshot: AnalysisContext = {
          ...context('proposal'),
          jobId: null,
          kind: 'strategy_version_proposal',
          subject: { kind: 'strategy', id: 'strategy' },
        };
        await repos.analysis.saveContext(snapshot);
        const action = {
          id: 'analysis:proposal',
          kind: 'propose-version' as const,
          status: 'drafted' as const,
          strategyId: 'strategy',
          strategyVersionId: draft.id,
          trigger: 'weekly-review' as const,
          factReferences: [],
          attempts: 0,
          createdAt: now,
          updatedAt: now,
          provenance: {
            generatorKind: 'dsh-chat' as const,
            contextId: snapshot.id,
            evidenceFactIds: [],
            generatedAt: now,
          },
        };
        const publication = { kind: 'strategy_version_proposal' as const, draft, action };
        expect(
          (
            await repos.analysis.recordPublication({
              accountId: 'account',
              contextId: snapshot.id,
              now,
              resultHash: 'proposal',
              publication,
            })
          ).ok,
        ).toBe(true);
        expect(await repos.strategy.findVersionById(draft.id)).toEqual(draft);
        expect((await repos.strategy.findById('strategy'))?.currentVersionId).toBeUndefined();
        const narrativeContext: AnalysisContext = {
          ...snapshot,
          id: 'narrative',
          kind: 'strategy_insight_narrative',
        };
        await repos.analysis.saveContext(narrativeContext);
        const input = {
          accountId: 'account',
          contextId: narrativeContext.id,
          now,
          resultHash: 'narrative',
          publication: {
            kind: 'strategy_insight_narrative' as const,
            actionId: action.id,
            expectedUpdatedAt: new Date(now.getTime() - 1),
            narrative: '有限事实解释',
            provenance: { ...action.provenance, contextId: narrativeContext.id },
          },
        };
        await expect(repos.analysis.recordPublication(input)).rejects.toThrow(
          'analysis_target_conflict',
        );
        expect(
          (await repos.analysis.findContext('account', narrativeContext.id))?.recordedResult,
        ).toBeUndefined();
        expect(
          (await repos.strategyAutonomyAction.findById(action.id))?.aiNarrative,
        ).toBeUndefined();
        expect(
          (
            await repos.analysis.recordPublication({
              ...input,
              publication: { ...input.publication, expectedUpdatedAt: now },
            })
          ).ok,
        ).toBe(true);
        expect((await repos.strategyAutonomyAction.findById(action.id))?.aiNarrative).toBe(
          '有限事实解释',
        );
      } finally {
        handle?.close();
      }
    });
    it('refreshes a leased context once, closes its old write window and rejects stale tokens', async () => {
      const { repo, close } = setup();
      try {
        await repo.enqueue(pending());
        await repo.claim(claim());
        const fresh = { ...context('fresh'), writeUntil: claim().leaseUntil };
        const input = { accountId: 'account', jobId: 'job', token: 'token', now, context: fresh };
        expect(await repo.refreshContext({ ...input, token: 'old' })).toBeNull();
        expect((await repo.refreshContext(input))?.contextId).toBe('fresh');
        expect((await repo.findContext('account', 'token'))?.writeUntil).toEqual(now);
        expect((await repo.findContext('account', 'fresh'))?.facts).toEqual(fresh.facts);
        expect(
          await repo.refreshContext({ ...input, context: { ...fresh, id: 'again' } }),
        ).toBeNull();
        expect(await repo.refreshContext({ ...input, now: claim().leaseUntil })).toBeNull();
        expect((await repo.findJob('account', 'job'))?.attempts).toBe(1);
      } finally {
        close();
      }
    });
    it('deduplicates active work and permits only one competing consumer', async () => {
      const { repo, close } = setup();
      try {
        const enqueued = await Promise.all([
          repo.enqueue(pending()),
          repo.enqueue(pending('other')),
        ]);
        expect(enqueued.map((result) => result.deduped)).toEqual([false, true]);
        const claims = await Promise.all([repo.claim(claim('one')), repo.claim(claim('two'))]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect((await repo.findJob('account', 'job'))?.attempts).toBe(1);
        expect(await repo.findJob('other-account', 'job')).toBeNull();
        expect(await repo.findContext('other-account', 'one')).toBeNull();
        expect(await repo.listJobs({ accountId: 'other-account' })).toEqual([]);
      } finally {
        close();
      }
    });
    it('recycles expired leases, rejects old tokens, dead-letters exhausted work', async () => {
      const { repo, close } = setup();
      try {
        await repo.enqueue(pending());
        await repo.claim(claim('first'));
        const expiry = new Date(now.getTime() + 1000);
        expect((await repo.claim(claim('second', expiry)))?.attempts).toBe(2);
        expect((await repo.findContext('account', 'first'))?.writeUntil).toEqual(expiry);
        const failure = {
          accountId: 'account',
          jobId: 'job',
          token: 'first',
          now: expiry,
          error: { code: 'failure', message: 'failed', retryable: true },
          notBefore: expiry,
        };
        expect(await repo.fail(failure)).toBeNull();
        expect((await repo.fail({ ...failure, token: 'second' }))?.status).toBe('dead_letter');
        expect((await repo.requeue('account', 'job', expiry))?.attempts).toBe(0);
      } finally {
        close();
      }
    });
    it('rolls back lease recycling when the replacement context cannot be saved', async () => {
      const { repo, close } = setup();
      try {
        await repo.enqueue(pending());
        await repo.claim(claim('first'));
        const originalJob = await repo.findJob('account', 'job');
        const originalContext = await repo.findContext('account', 'first');
        const replacement = claim('second', new Date(now.getTime() + 1000));
        await expect(
          repo.claim({
            ...replacement,
            context: { ...replacement.context, id: 'first' },
          }),
        ).rejects.toThrow();
        expect(await repo.findJob('account', 'job')).toEqual(originalJob);
        expect(await repo.findContext('account', 'first')).toEqual(originalContext);
        expect((await repo.claim(replacement))?.claimToken).toBe('second');
      } finally {
        close();
      }
    });
    it('does not reclaim exhausted work and cannot requeue across active deduplication', async () => {
      const { repo, close } = setup();
      try {
        await repo.enqueue({ ...pending(), maxAttempts: 1 });
        await repo.claim(claim());
        const expiry = new Date(now.getTime() + 1000);
        expect(await repo.claim(claim('next', expiry))).toBeNull();
        expect((await repo.findJob('account', 'job'))?.status).toBe('dead_letter');
        expect((await repo.enqueue(pending('new'))).deduped).toBe(false);
        expect(await repo.requeue('account', 'job', expiry)).toBeNull();
      } finally {
        close();
      }
    });
    it('cancels claimed work and keeps a closed context readable for audit', async () => {
      const { repo, close } = setup();
      try {
        await repo.enqueue(pending());
        await repo.claim(claim());
        const cancelled = new Date(now.getTime() + 100);
        expect((await repo.cancel('account', 'job', cancelled))?.status).toBe('cancelled');
        const saved = await repo.findContext('account', 'token');
        expect(saved?.writeUntil).toEqual(cancelled);
        expect(saved?.expiresAt.getTime()).toBe(cancelled.getTime() + 30 * 86400000);
        expect(await repo.claim(claim('again', cancelled))).toBeNull();
      } finally {
        close();
      }
    });
    it('honors retry delays and keeps interactive snapshots immutable', async () => {
      const { repo, close, handle } = setup();
      try {
        await repo.enqueue({ ...pending(), notBefore: new Date(now.getTime() + 5000) });
        expect(await repo.claim(claim())).toBeNull();
        const snapshot = { ...context(), jobId: null };
        await repo.saveContext(snapshot);
        snapshot.factIds.push('mutated');
        expect((await repo.findContext('account', 'context'))?.factIds).toEqual(['quote']);
        await expect(repo.saveContext({ ...context(), jobId: null })).rejects.toThrow();
        if (handle) {
          ensureSchema(handle.db);
          ensureSchema(handle.db);
        }
        expect(await repo.findJob('account', 'job')).not.toBeNull();
      } finally {
        close();
      }
    });
  });
}
