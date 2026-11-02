import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type Advice,
  ANALYSIS_CONTEXT_HASH_VERSION,
  type AnalysisContext,
  type AnalysisJob,
  analysisContextHashMatches,
  analysisContextHashPayload,
  analysisContextTiming,
  MARKET_ADVICE_SAME_DAY_ONLY,
  STANDARD_DISCLAIMERS,
} from '@luoome/core';
import { sql } from 'drizzle-orm';
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
  cancelledOutput: null,
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
  missingFacts: [],
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

/**
 * 与 tools 层 `analysisHash` 同构的 contextHash 计算（本包不依赖 tools，contract 里自带一份）。
 * 只需确定性：被测性质是「hash 口径里含 missingFacts」，与具体序列化无关。
 */
const contextHashOf = (
  facts: readonly unknown[],
  dataAsOf: Date,
  missingFacts: readonly unknown[],
): string =>
  createHash('sha256')
    .update(
      JSON.stringify(
        analysisContextHashPayload({
          version: ANALYSIS_CONTEXT_HASH_VERSION,
          facts,
          dataAsOf,
          missingFacts: missingFacts as never,
        }),
      ),
    )
    .digest('hex');

/** 与 record.ts / publication.ts 读回后做的校验完全一致。 */
const hashMatches = (context: AnalysisContext): boolean =>
  analysisContextHashMatches({
    contextHash: context.contextHash,
    facts: context.facts,
    dataAsOf: context.dataAsOf,
    missingFacts: context.missingFacts,
    compute: (payload) => createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
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
    it('applies per-kind data freshness rules when claiming work', async () => {
      const { repo, close } = setup();
      try {
        const minute = 60_000;
        const day = 86_400_000;
        const leaseMs = 5 * minute;
        const agedJob = (
          id: string,
          kind: AnalysisJob['kind'],
          subject: AnalysisJob['subject'],
          ageMs: number,
        ): AnalysisJob => ({
          ...pending(id),
          kind,
          subject,
          dataAsOf: new Date(now.getTime() - ageMs),
          dedupeKey: `dedupe:${id}`,
          createdAt: now,
          updatedAt: now,
          notBefore: now,
        });
        const agedClaim = (job: AnalysisJob) => ({
          accountId: 'account',
          jobId: job.id,
          owner: 'worker:test',
          token: `${job.id}-token`,
          now,
          leaseUntil: new Date(now.getTime() + leaseMs),
          context: {
            ...context(`${job.id}-context`),
            jobId: job.id,
            kind: job.kind,
            subject: job.subject,
            dataAsOf: job.dataAsOf,
            createdAt: now,
            writeUntil: new Date(now.getTime() + leaseMs),
            expiresAt: new Date(now.getTime() + 31 * day),
          } satisfies AnalysisContext,
        });
        const claimAged = async (
          id: string,
          kind: AnalysisJob['kind'],
          subject: AnalysisJob['subject'],
          ageMs: number,
        ) => {
          const job = agedJob(id, kind, subject, ageMs);
          await repo.enqueue(job);
          return repo.claim(agedClaim(job));
        };
        const expectStale = async (
          id: string,
          kind: AnalysisJob['kind'],
          subject: AnalysisJob['subject'],
          ageMs: number,
        ): Promise<void> => {
          expect(await claimAged(id, kind, subject, ageMs)).toBeNull();
          const failed = await repo.findJob('account', id);
          expect(failed?.status).toBe('failed');
          expect(failed?.error).toEqual({
            code: 'stale_context',
            message: 'Analysis facts are stale',
            retryable: false,
          });
        };
        const expectClaimed = async (
          id: string,
          kind: AnalysisJob['kind'],
          subject: AnalysisJob['subject'],
          ageMs: number,
        ): Promise<void> => {
          const claimed = await claimAged(id, kind, subject, ageMs);
          expect(claimed?.id).toBe(id);
          expect(claimed?.status).toBe('claimed');
          expect(claimed?.attempts).toBe(1);
          expect(claimed?.dataAsOf.getTime()).toBe(now.getTime() - ageMs);
        };
        await expectStale(
          'stock-31m',
          'advice_stock',
          { kind: 'stock', id: '600519.SH' },
          31 * minute,
        );
        await expectClaimed(
          'stock-30m',
          'advice_stock',
          { kind: 'stock', id: '600519.SH' },
          30 * minute,
        );
        await expectStale(
          'research-31d',
          'research_directions',
          { kind: 'research', id: 'directions' },
          31 * day,
        );
        await expectClaimed(
          'research-1d',
          'research_directions',
          { kind: 'research', id: 'directions' },
          day,
        );
        await expectClaimed(
          'research-30d',
          'research_directions',
          { kind: 'research', id: 'directions' },
          30 * day,
        );
        await expectStale(
          'proposal-31d',
          'strategy_version_proposal',
          { kind: 'strategy', id: 'strategy' },
          31 * day,
        );
        await expectClaimed(
          'proposal-1d',
          'strategy_version_proposal',
          { kind: 'strategy', id: 'strategy' },
          day,
        );
        // REQ-M3-20：市场级改为 Asia/Shanghai 当日口径——跨日即 stale，不再有 7 天宽限。
        // 旧断言是「1 天前的市场事实仍可认领」，它反映的正是被废弃的伪精确窗口。
        await expectStale('market-8d', 'advice_market', { kind: 'market', id: 'market' }, 8 * day);
        await expectStale('market-1d', 'advice_market', { kind: 'market', id: 'market' }, day);
        // 正例换成当日事实：同一自然日内仍然可认领。
        await expectClaimed('market-1m', 'advice_market', { kind: 'market', id: 'market' }, minute);
      } finally {
        close();
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
    // P0 回归：missingFacts 曾经根本没落库（表无列 + contextRow 展开 → drizzle 静默丢弃），
    // 读回落回 schema 默认 []，带缺口的 context 写回 advice 必然 context_mismatch。
    it('persists blocking missingFacts and the hash version across insert and update', async () => {
      const { repo, close } = setup();
      try {
        const facts = context().facts;
        const blocking: AnalysisContext['missingFacts'] = [
          { kind: 'quote-unavailable', subjectId: '600519.SH', reason: '缺少行情', asOf: now },
          { kind: 'quote-stale', subjectId: '600519.SH', reason: '行情过期', asOf: now },
        ];
        const snapshot: AnalysisContext = {
          ...context('gaps'),
          missingFacts: blocking,
          contextHashVersion: ANALYSIS_CONTEXT_HASH_VERSION,
          timingRuleVersion: analysisContextTiming('advice_stock', now, now).ruleVersion,
          contextHash: contextHashOf(facts, now, blocking),
        };
        await repo.enqueue(pending());
        await repo.claim({ ...claim('gaps'), context: snapshot });

        const inserted = await repo.findContext('account', 'gaps');
        expect(inserted?.missingFacts).toEqual(blocking);
        expect(inserted?.contextHashVersion).toBe(ANALYSIS_CONTEXT_HASH_VERSION);
        expect(inserted?.timingRuleVersion).toBe(snapshot.timingRuleVersion);
        expect(inserted && hashMatches(inserted)).toBe(true);

        const advice: Advice = {
          id: 'analysis:gaps',
          subjectKind: 'stock',
          subjectId: snapshot.subject.id,
          decision: 'watch',
          confidence: 50,
          horizon: 'short',
          reasoning: { premise: '观察', evidence: ['行情'], counterEvidence: ['缺口未补'] },
          risks: ['数据有限'],
          disclaimers: STANDARD_DISCLAIMERS,
          basedOn: { dataAsOf: now },
          validFrom: now,
          validUntil: new Date(now.getTime() + 86400000),
          createdAt: now,
          provenance: {
            generatorKind: 'dsh-worker',
            contextId: 'gaps',
            jobId: 'job',
            evidenceFactIds: ['quote'],
            generatedAt: now,
          },
        };
        expect(
          await repo.recordAdvice({
            accountId: 'account',
            contextId: 'gaps',
            now,
            resultHash: 'hash',
            advice,
            claim: { jobId: 'job', token: 'gaps' },
          }),
        ).toEqual({ ok: true, advice, replayed: false });

        // update 路径（recordedResult 写回）同样不能把缺口冲掉。
        const recorded = await repo.findContext('account', 'gaps');
        expect(recorded?.missingFacts).toEqual(blocking);
        expect(recorded?.contextHashVersion).toBe(ANALYSIS_CONTEXT_HASH_VERSION);
        expect(recorded?.timingRuleVersion).toBe(snapshot.timingRuleVersion);
        expect(recorded?.recordedResult?.ref).toBe(advice.id);
        expect(recorded && hashMatches(recorded)).toBe(true);
      } finally {
        close();
      }
    });
    it('round-trips a market same-day gap and an explicitly gap-free context', async () => {
      const { repo, close } = setup();
      try {
        const facts = context().facts;
        const gap: AnalysisContext['missingFacts'] = [
          {
            kind: MARKET_ADVICE_SAME_DAY_ONLY,
            subjectId: 'market',
            reason: '已排除跨日涨停天梯快照，不得用昨日结构代表今日情绪',
            asOf: now,
          },
        ];
        const market: AnalysisContext = {
          ...context('market'),
          jobId: null,
          kind: 'advice_market',
          subject: { kind: 'market', id: 'market' },
          missingFacts: gap,
          contextHashVersion: ANALYSIS_CONTEXT_HASH_VERSION,
          timingRuleVersion: analysisContextTiming('advice_market', now, now).ruleVersion,
          contextHash: contextHashOf(facts, now, gap),
        };
        await repo.saveContext(market);
        const readMarket = await repo.findContext('account', 'market');
        expect(readMarket?.missingFacts).toEqual(gap);
        // 规则版本必须落在列上（M3-20 之前只能塞 limitations 字符串当 workaround）。
        expect(readMarket?.timingRuleVersion).toBe('market-analysis-same-day-v1');
        expect(readMarket && hashMatches(readMarket)).toBe(true);

        const clean: AnalysisContext = {
          ...context('clean'),
          jobId: null,
          contextHash: contextHashOf(facts, now, []),
        };
        await repo.saveContext(clean);
        const readClean = await repo.findContext('account', 'clean');
        expect(readClean?.missingFacts).toEqual([]);
        expect(readClean?.contextHashVersion).toBeUndefined();
        expect(readClean?.timingRuleVersion).toBeUndefined();
        expect(readClean && hashMatches(readClean)).toBe(true);
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

describe('AnalysisRepository [drizzle] 存量库迁移', () => {
  /** 修复前的 15 列 DDL（无 missing_facts_json / context_hash_version / timing_rule_version）。 */
  const LEGACY_DDL = `CREATE TABLE analysis_contexts (
    recorded_result_json TEXT, id TEXT PRIMARY KEY, job_id TEXT, kind TEXT NOT NULL,
    account_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
    data_as_of INTEGER NOT NULL, facts_json TEXT NOT NULL, fact_ids_json TEXT NOT NULL,
    limitations_json TEXT NOT NULL, context_hash TEXT NOT NULL, write_until INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`;
  const facts = [{ id: 'quote', label: '行情', value: 100, evidenceIds: [] }];
  const gap = [
    {
      kind: MARKET_ADVICE_SAME_DAY_ONLY,
      subjectId: 'market',
      reason: '跨日涨停天梯快照被当日口径排除',
      asOf: now,
    },
  ];

  // fail-closed：旧库行写入时 hash 按 v2 口径算过（含真实缺口），但列不存在 → 缺口在存储里丢了。
  // 迁移后读回 missingFacts 仍是 []（不伪造恢复），hash 两条口径都不等 → 写回继续 context_mismatch。
  it('adds the missing columns idempotently and keeps legacy rows fail-closed', async () => {
    const handle = createDrizzleRepos(':memory:', { migrate: false });
    try {
      handle.db.run(sql.raw(LEGACY_DDL));
      handle.db.run(sql`INSERT INTO analysis_contexts (
          recorded_result_json, id, job_id, kind, account_id, subject_kind, subject_id, data_as_of,
          facts_json, fact_ids_json, limitations_json, context_hash, write_until, expires_at, created_at
        ) VALUES (
          NULL, ${'legacy'}, NULL, ${'advice_market'}, ${'account'}, ${'market'}, ${'market'},
          ${now.getTime()}, ${JSON.stringify(facts)}, ${JSON.stringify(['quote'])},
          ${JSON.stringify(['旧库行：缺口列尚不存在'])},
          ${contextHashOf(facts, now, gap)}, ${now.getTime() + 86_400_000},
          ${now.getTime() + 31 * 86_400_000}, ${now.getTime()}
        )`);

      ensureSchema(handle.db);
      const migratedColumns = handle.db
        .all<{ name: string }>(sql.raw('PRAGMA table_info(analysis_contexts)'))
        .map((row) => row.name);
      expect(migratedColumns).toEqual(
        expect.arrayContaining([
          'missing_facts_json',
          'context_hash_version',
          'timing_rule_version',
        ]),
      );

      // 幂等：第二次 ensureSchema 不报错，且不动已有数据。
      const beforeSecondRun = handle.db.all<Record<string, unknown>>(
        sql.raw('SELECT * FROM analysis_contexts ORDER BY id'),
      );
      ensureSchema(handle.db);
      expect(
        handle.db.all<Record<string, unknown>>(
          sql.raw('SELECT * FROM analysis_contexts ORDER BY id'),
        ),
      ).toEqual(beforeSecondRun);

      const legacy = await handle.repos.analysis.findContext('account', 'legacy');
      expect(legacy?.missingFacts).toEqual([]);
      expect(legacy?.contextHashVersion).toBeUndefined();
      expect(legacy?.timingRuleVersion).toBeUndefined();
      expect(legacy && hashMatches(legacy)).toBe(false);

      // 迁移后新写入必须能带缺口完整往返——否则「加列」只解决了幂等没解决问题本身。
      const fresh: AnalysisContext = {
        ...context('fresh-market'),
        jobId: null,
        kind: 'advice_market',
        subject: { kind: 'market', id: 'market' },
        missingFacts: gap,
        contextHashVersion: ANALYSIS_CONTEXT_HASH_VERSION,
        timingRuleVersion: 'market-analysis-same-day-v1',
        contextHash: contextHashOf(facts, now, gap),
      };
      await handle.repos.analysis.saveContext(fresh);
      const readFresh = await handle.repos.analysis.findContext('account', 'fresh-market');
      expect(readFresh?.missingFacts).toEqual(gap);
      expect(readFresh?.timingRuleVersion).toBe('market-analysis-same-day-v1');
      expect(readFresh && hashMatches(readFresh)).toBe(true);
    } finally {
      handle.close();
    }
  });
});
