import {
  type AnalysisClaim,
  type AnalysisContext,
  type AnalysisJob,
  type AnalysisJobQuery,
  type AnalysisPublicationResult,
  type AnalysisRecordAdvice,
  type AnalysisRecordPublication,
  type AnalysisRecordResult,
  type AnalysisRepository,
  analysisAdviceContextError,
  analysisPublicationRef,
  assertAdviceInvariants,
  assertAnalysisContextInvariants,
  assertAnalysisJobInvariants,
  assertAnalysisPublication,
  hasAnalysisLease,
  InvariantError,
  isAnalysisContextStale,
  releaseAnalysisJob,
} from '@luoome/core';
import type { InMemoryAdviceRepository } from './advice.js';
import type { InMemoryInvestmentWorkspaceRepository } from './investment-workspace.js';
import type { InMemoryStrategyRepository } from './strategy.js';
import type { InMemoryStrategyAutonomyActionRepository } from './strategy-autonomy-action.js';

export class InMemoryAnalysisRepository implements AnalysisRepository {
  constructor(
    private readonly advice: InMemoryAdviceRepository,
    private readonly workspace: InMemoryInvestmentWorkspaceRepository,
    private readonly strategy: InMemoryStrategyRepository,
    private readonly actions: InMemoryStrategyAutonomyActionRepository,
  ) {}

  private readonly jobs = new Map<string, AnalysisJob>();
  private readonly contexts = new Map<string, AnalysisContext>();

  async recordAdvice(input: AnalysisRecordAdvice): Promise<AnalysisRecordResult> {
    const context = this.contexts.get(input.contextId);
    const job = context?.jobId ? this.jobs.get(context.jobId) : null;
    if (!context || context.accountId !== input.accountId)
      return { ok: false, reason: 'not_found' };
    if (analysisAdviceContextError(context, input.advice))
      return { ok: false, reason: 'context_mismatch' };
    if (context.recordedResult) {
      if (
        context.recordedResult.hash !== input.resultHash ||
        (context.jobId &&
          (!input.claim ||
            input.claim.jobId !== context.jobId ||
            job?.result?.completedClaimToken !== input.claim.token))
      ) {
        return { ok: false, reason: 'duplicate_result' };
      }
      const saved = this.advice.findByIdSync(context.recordedResult.ref);
      if (!saved) throw new InvariantError('missing_analysis_receipt_result');
      return { ok: true, advice: saved, replayed: true };
    }
    if (
      context.jobId !== null &&
      (!job ||
        !input.claim ||
        input.claim.jobId !== job.id ||
        job.contextId !== context.id ||
        !hasAnalysisLease(job, input.claim.token, input.now))
    ) {
      return { ok: false, reason: 'lease_lost_before_commit' };
    }
    if (context.jobId === null && input.claim) return { ok: false, reason: 'context_mismatch' };
    if (input.now >= context.writeUntil || input.now >= context.expiresAt)
      return { ok: false, reason: 'context_expired' };
    assertAdviceInvariants(input.advice);
    const completed: AnalysisJob | null =
      job && input.claim
        ? {
            ...job,
            status: 'completed',
            claimToken: null,
            claimedBy: null,
            leaseUntil: null,
            finishedAt: input.now,
            updatedAt: input.now,
            result: {
              resultRef: input.advice.id,
              resultHash: input.resultHash,
              completedClaimToken: input.claim.token,
            },
          }
        : null;
    if (completed) assertAnalysisJobInvariants(completed);
    const recorded = {
      ...context,
      recordedResult: { hash: input.resultHash, ref: input.advice.id },
      ...(job
        ? { writeUntil: input.now, expiresAt: new Date(input.now.getTime() + 30 * 86400000) }
        : {}),
    };
    this.advice.put(structuredClone(input.advice));
    this.contexts.set(context.id, structuredClone(recorded));
    if (completed) this.jobs.set(completed.id, structuredClone(completed));
    return { ok: true, advice: structuredClone(input.advice), replayed: false };
  }

  async recordPublication(input: AnalysisRecordPublication): Promise<AnalysisPublicationResult> {
    const context = this.contexts.get(input.contextId);
    const job = context?.jobId ? this.jobs.get(context.jobId) : null;
    if (!context || context.accountId !== input.accountId)
      return { ok: false, reason: 'not_found' };
    if (context.kind !== input.publication.kind) return { ok: false, reason: 'context_mismatch' };
    if (context.recordedResult) {
      if (
        context.recordedResult.hash !== input.resultHash ||
        (context.jobId &&
          (!input.claim ||
            input.claim.jobId !== context.jobId ||
            job?.result?.completedClaimToken !== input.claim.token))
      ) {
        return { ok: false, reason: 'duplicate_result' };
      }
      return { ok: true, resultRef: context.recordedResult.ref, replayed: true };
    }
    if (
      context.jobId !== null &&
      (!job ||
        !input.claim ||
        input.claim.jobId !== job.id ||
        job.contextId !== context.id ||
        !hasAnalysisLease(job, input.claim.token, input.now))
    ) {
      return { ok: false, reason: 'lease_lost_before_commit' };
    }
    if (context.jobId === null && input.claim) return { ok: false, reason: 'context_mismatch' };
    if (input.now >= context.writeUntil || input.now >= context.expiresAt)
      return { ok: false, reason: 'context_expired' };
    assertAnalysisPublication(context, input.publication);
    const resultRef = analysisPublicationRef(input.publication);
    const completed: AnalysisJob | null =
      job && input.claim
        ? {
            ...job,
            status: 'completed',
            claimToken: null,
            claimedBy: null,
            leaseUntil: null,
            finishedAt: input.now,
            updatedAt: input.now,
            result: {
              resultRef: resultRef,
              resultHash: input.resultHash,
              completedClaimToken: input.claim.token,
            },
          }
        : null;
    if (completed) assertAnalysisJobInvariants(completed);
    const recorded = {
      ...context,
      recordedResult: { hash: input.resultHash, ref: resultRef },
      ...(job
        ? { writeUntil: input.now, expiresAt: new Date(input.now.getTime() + 30 * 86400000) }
        : {}),
    };
    this.savePublication(input, context);
    this.contexts.set(context.id, structuredClone(recorded));
    if (completed) this.jobs.set(completed.id, structuredClone(completed));
    return { ok: true, resultRef, replayed: false };
  }

  async enqueue(job: AnalysisJob): Promise<{ job: AnalysisJob; deduped: boolean }> {
    assertAnalysisJobInvariants(job);
    if (job.status !== 'pending' || job.attempts !== 0) throw new InvariantError('invalid_new_job');
    const existing = [...this.jobs.values()].find(
      (item) =>
        item.dedupeKey === job.dedupeKey &&
        (item.status === 'pending' || item.status === 'claimed'),
    );
    if (existing) {
      if (existing.accountId !== job.accountId) throw new InvariantError('dedupe_account_mismatch');
      return { job: structuredClone(existing), deduped: true };
    }
    if (this.jobs.has(job.id)) throw new InvariantError('duplicate_job_id');
    this.jobs.set(job.id, structuredClone(job));
    return { job: structuredClone(job), deduped: false };
  }

  async findJob(accountId: string, id: string): Promise<AnalysisJob | null> {
    const job = this.jobs.get(id);
    return job?.accountId === accountId ? structuredClone(job) : null;
  }

  async listJobs(query: AnalysisJobQuery): Promise<AnalysisJob[]> {
    return structuredClone(
      [...this.jobs.values()]
        .filter(
          (job) =>
            job.accountId === query.accountId &&
            (!query.statuses || query.statuses.includes(job.status)) &&
            (!query.kinds || query.kinds.includes(job.kind)) &&
            (!query.since || job.createdAt >= query.since),
        )
        .sort(
          (a, b) =>
            b.priority - a.priority ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        )
        .slice(0, query.limit),
    );
  }

  async claim(input: AnalysisClaim): Promise<AnalysisJob | null> {
    const previousJobs = new Map(this.jobs);
    const previousContexts = new Map(this.contexts);
    try {
      assertAnalysisContextInvariants(input.context);
      if (!input.owner || !input.token || input.leaseUntil <= input.now)
        throw new InvariantError('invalid_claim');
      for (const job of this.jobs.values()) {
        if (
          job.accountId === input.accountId &&
          job.status === 'claimed' &&
          job.leaseUntil &&
          job.leaseUntil <= input.now
        ) {
          this.closeContext(job, input.now);
          this.jobs.set(
            job.id,
            releaseAnalysisJob(job, input.now, {
              code: 'lease_expired',
              message: 'Analysis lease expired',
              retryable: true,
            }),
          );
        }
      }
      const job = this.jobs.get(input.jobId);
      if (
        !job ||
        job.accountId !== input.accountId ||
        job.status !== 'pending' ||
        job.notBefore > input.now ||
        job.attempts >= job.maxAttempts
      )
        return null;
      if (isAnalysisContextStale(job.kind, job.dataAsOf, input.now)) {
        const expired: AnalysisJob = {
          ...job,
          status: 'failed',
          updatedAt: input.now,
          finishedAt: input.now,
          error: { code: 'stale_context', message: 'Analysis facts are stale', retryable: false },
        };
        assertAnalysisJobInvariants(expired);
        this.jobs.set(job.id, expired);
        return null;
      }
      const context = input.context;
      if (
        context.jobId !== job.id ||
        context.accountId !== job.accountId ||
        context.kind !== job.kind ||
        context.subject.kind !== job.subject.kind ||
        context.subject.id !== job.subject.id ||
        context.dataAsOf.getTime() !== job.dataAsOf.getTime() ||
        context.writeUntil <= input.now
      ) {
        throw new InvariantError('context_mismatch');
      }
      if (this.contexts.has(context.id)) throw new InvariantError('duplicate_context_id');
      const next: AnalysisJob = {
        ...job,
        status: 'claimed',
        attempts: job.attempts + 1,
        claimToken: input.token,
        claimedBy: input.owner,
        leaseUntil: input.leaseUntil,
        contextId: context.id,
        updatedAt: input.now,
      };
      assertAnalysisJobInvariants(next);
      this.contexts.set(context.id, structuredClone(context));
      this.jobs.set(job.id, structuredClone(next));
      return structuredClone(next);
    } catch (error) {
      this.jobs.clear();
      this.contexts.clear();
      for (const [id, job] of previousJobs) this.jobs.set(id, job);
      for (const [id, context] of previousContexts) this.contexts.set(id, context);
      throw error;
    }
  }

  async refreshContext(
    input: Parameters<AnalysisRepository['refreshContext']>[0],
  ): Promise<AnalysisJob | null> {
    const job = this.jobs.get(input.jobId);
    if (job?.accountId !== input.accountId) return null;
    assertAnalysisContextInvariants(input.context);
    if (
      !job ||
      !hasAnalysisLease(job, input.token, input.now) ||
      job.payload.refreshedClaimToken === input.token
    )
      return null;
    const context = input.context;
    if (
      context.accountId !== job.accountId ||
      context.jobId !== job.id ||
      context.kind !== job.kind ||
      context.subject.kind !== job.subject.kind ||
      context.subject.id !== job.subject.id ||
      context.recordedResult ||
      context.writeUntil.getTime() !== job.leaseUntil?.getTime() ||
      context.dataAsOf > input.now
    )
      throw new InvariantError('context_mismatch');
    const updated: AnalysisJob = {
      ...job,
      contextId: context.id,
      dataAsOf: context.dataAsOf,
      updatedAt: input.now,
      payload: {
        ...job.payload,
        snapshot: JSON.parse(JSON.stringify(context)),
        refreshedClaimToken: input.token,
      },
    };
    assertAnalysisJobInvariants(updated);
    if (this.contexts.has(context.id)) throw new InvariantError('duplicate_context_id');
    this.closeContext(job, input.now);
    this.contexts.set(context.id, structuredClone(context));
    this.jobs.set(job.id, structuredClone(updated));
    return structuredClone(updated);
  }

  async fail(input: Parameters<AnalysisRepository['fail']>[0]): Promise<AnalysisJob | null> {
    const job = this.jobs.get(input.jobId);
    if (!job || job.accountId !== input.accountId || !hasAnalysisLease(job, input.token, input.now))
      return null;
    const next = releaseAnalysisJob(job, input.now, input.error, input.notBefore);
    this.closeContext(job, input.now);
    this.jobs.set(job.id, structuredClone(next));
    return structuredClone(next);
  }

  async cancel(accountId: string, id: string, now: Date): Promise<AnalysisJob | null> {
    const job = this.jobs.get(id);
    if (!job || job.accountId !== accountId || !['pending', 'claimed'].includes(job.status))
      return null;
    const next: AnalysisJob = {
      ...job,
      status: 'cancelled',
      claimToken: null,
      claimedBy: null,
      leaseUntil: null,
      finishedAt: now,
      updatedAt: now,
    };
    assertAnalysisJobInvariants(next);
    this.closeContext(job, now);
    this.jobs.set(id, structuredClone(next));
    return structuredClone(next);
  }

  async requeue(accountId: string, id: string, now: Date): Promise<AnalysisJob | null> {
    const job = this.jobs.get(id);
    if (!job || job.accountId !== accountId || job.status !== 'dead_letter') return null;
    if (
      [...this.jobs.values()].some(
        (item) => item.dedupeKey === job.dedupeKey && ['pending', 'claimed'].includes(item.status),
      )
    )
      return null;
    const next: AnalysisJob = {
      ...job,
      status: 'pending',
      attempts: 0,
      contextId: null,
      error: null,
      finishedAt: null,
      updatedAt: now,
      notBefore: now,
    };
    assertAnalysisJobInvariants(next);
    this.jobs.set(id, structuredClone(next));
    return structuredClone(next);
  }

  async saveContext(context: AnalysisContext): Promise<void> {
    assertAnalysisContextInvariants(context);
    if (context.jobId !== null) throw new InvariantError('batch_context_requires_claim');
    if (this.contexts.has(context.id)) throw new InvariantError('duplicate_context_id');
    this.contexts.set(context.id, structuredClone(context));
  }

  async findContext(accountId: string, id: string): Promise<AnalysisContext | null> {
    const context = this.contexts.get(id);
    return context?.accountId === accountId ? structuredClone(context) : null;
  }

  private closeContext(job: AnalysisJob, now: Date): void {
    if (!job.contextId) return;
    const context = this.contexts.get(job.contextId);
    if (context)
      this.contexts.set(context.id, {
        ...context,
        writeUntil: now,
        expiresAt: new Date(now.getTime() + 30 * 86400000),
      });
  }
  private savePublication(input: AnalysisRecordPublication, context: AnalysisContext): void {
    const workspace = this.workspace;
    const strategy = this.strategy;
    const actions = this.actions;
    const value = input.publication;
    if (value.kind === 'research_directions') {
      workspace.createResearchSync(value.research);
    } else if (value.kind === 'strategy_version_proposal') {
      if (actions.findByIdSync(value.action.id)) throw new InvariantError('duplicate_action');
      strategy.createVersionSync(value.draft);
      actions.saveSync(value.action);
    } else {
      const action = actions.findByIdSync(value.actionId);
      if (
        !action ||
        action.strategyId !== context.subject.id ||
        action.updatedAt.getTime() !== value.expectedUpdatedAt.getTime()
      )
        throw new InvariantError('analysis_target_conflict');
      actions.saveSync({
        ...action,
        aiNarrative: value.narrative,
        provenance: value.provenance,
        updatedAt: input.now,
      });
    }
  }
}
