import {
  type AnalysisClaim,
  type AnalysisContext,
  AnalysisContextSchema,
  type AnalysisJob,
  type AnalysisJobQuery,
  AnalysisJobSchema,
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
  releaseAnalysisJob,
} from '@luoome/core';
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { analysisContexts, analysisJobs, type Schema } from '../../schema/index.js';
import { DrizzleAdviceRepository } from './advice.js';
import { DrizzleInvestmentWorkspaceRepository } from './investment-workspace.js';
import { DrizzleStrategyRepository } from './strategy.js';
import { DrizzleStrategyAutonomyActionRepository } from './strategy-autonomy-action.js';

const decodeJob = (row: typeof analysisJobs.$inferSelect): AnalysisJob =>
  AnalysisJobSchema.parse({ ...row, subject: { kind: row.subjectKind, id: row.subjectId } });
const jobRow = (job: AnalysisJob): typeof analysisJobs.$inferInsert => {
  const { subject, ...rest } = job;
  return { ...rest, subjectKind: subject.kind, subjectId: subject.id };
};
const contextRow = (context: AnalysisContext): typeof analysisContexts.$inferInsert => {
  const { subject, ...rest } = context;
  return { ...rest, subjectKind: subject.kind, subjectId: subject.id };
};

export class DrizzleAnalysisRepository implements AnalysisRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async recordAdvice(input: AnalysisRecordAdvice): Promise<AnalysisRecordResult> {
    return this.db.transaction(
      () => {
        const row = this.db
          .select()
          .from(analysisContexts)
          .where(eq(analysisContexts.id, input.contextId))
          .get();
        const context = row
          ? AnalysisContextSchema.parse({
              ...row,
              recordedResult: row.recordedResult ?? undefined,
              subject: { kind: row.subjectKind, id: row.subjectId },
            })
          : null;
        const job = context?.jobId ? this.readJob(input.accountId, context.jobId) : null;
        const adviceRepository = new DrizzleAdviceRepository(this.db);
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
          const saved = adviceRepository.findByIdSync(context.recordedResult.ref);
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
        adviceRepository.saveSync(input.advice);
        this.db
          .update(analysisContexts)
          .set(contextRow(recorded))
          .where(eq(analysisContexts.id, context.id))
          .run();
        if (completed) this.update(completed);
        return { ok: true, advice: input.advice, replayed: false };
      },
      { behavior: 'immediate' },
    );
  }

  async recordPublication(input: AnalysisRecordPublication): Promise<AnalysisPublicationResult> {
    return this.db.transaction(
      () => {
        const row = this.db
          .select()
          .from(analysisContexts)
          .where(eq(analysisContexts.id, input.contextId))
          .get();
        const context = row
          ? AnalysisContextSchema.parse({
              ...row,
              recordedResult: row.recordedResult ?? undefined,
              subject: { kind: row.subjectKind, id: row.subjectId },
            })
          : null;
        const job = context?.jobId ? this.readJob(input.accountId, context.jobId) : null;
        if (!context || context.accountId !== input.accountId)
          return { ok: false, reason: 'not_found' };
        if (context.kind !== input.publication.kind)
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
        this.db
          .update(analysisContexts)
          .set(contextRow(recorded))
          .where(eq(analysisContexts.id, context.id))
          .run();
        if (completed) this.update(completed);
        return { ok: true, resultRef, replayed: false };
      },
      { behavior: 'immediate' },
    );
  }

  async enqueue(job: AnalysisJob): Promise<{ job: AnalysisJob; deduped: boolean }> {
    assertAnalysisJobInvariants(job);
    if (job.status !== 'pending' || job.attempts !== 0) throw new InvariantError('invalid_new_job');
    return this.db.transaction(
      (tx) => {
        const existing = tx
          .select()
          .from(analysisJobs)
          .where(
            and(
              eq(analysisJobs.dedupeKey, job.dedupeKey),
              inArray(analysisJobs.status, ['pending', 'claimed']),
            ),
          )
          .get();
        if (existing) {
          if (existing.accountId !== job.accountId)
            throw new InvariantError('dedupe_account_mismatch');
          return { job: decodeJob(existing), deduped: true };
        }
        tx.insert(analysisJobs).values(jobRow(job)).run();
        return { job, deduped: false };
      },
      { behavior: 'immediate' },
    );
  }

  async findJob(accountId: string, id: string): Promise<AnalysisJob | null> {
    return this.readJob(accountId, id);
  }
  private readJob(accountId: string, id: string): AnalysisJob | null {
    const row = this.db
      .select()
      .from(analysisJobs)
      .where(and(eq(analysisJobs.id, id), eq(analysisJobs.accountId, accountId)))
      .get();
    return row ? decodeJob(row) : null;
  }

  async listJobs(query: AnalysisJobQuery): Promise<AnalysisJob[]> {
    const statement = this.db
      .select()
      .from(analysisJobs)
      .where(
        and(
          eq(analysisJobs.accountId, query.accountId),
          query.statuses ? inArray(analysisJobs.status, [...query.statuses]) : undefined,
          query.kinds ? inArray(analysisJobs.kind, [...query.kinds]) : undefined,
          query.since ? gte(analysisJobs.createdAt, query.since) : undefined,
        ),
      )
      .orderBy(desc(analysisJobs.priority), asc(analysisJobs.createdAt), asc(analysisJobs.id));
    return (query.limit === undefined ? statement.all() : statement.limit(query.limit).all()).map(
      decodeJob,
    );
  }

  async claim(input: AnalysisClaim): Promise<AnalysisJob | null> {
    assertAnalysisContextInvariants(input.context);
    if (!input.owner || !input.token || input.leaseUntil <= input.now)
      throw new InvariantError('invalid_claim');
    return this.db.transaction(
      () => {
        const expired = this.db
          .select()
          .from(analysisJobs)
          .where(
            and(
              eq(analysisJobs.accountId, input.accountId),
              eq(analysisJobs.status, 'claimed'),
              lte(analysisJobs.leaseUntil, input.now),
            ),
          )
          .all();
        for (const row of expired) {
          const job = decodeJob(row);
          this.closeContext(job, input.now);
          this.update(
            releaseAnalysisJob(job, input.now, {
              code: 'lease_expired',
              message: 'Analysis lease expired',
              retryable: true,
            }),
          );
        }
        const job = this.readJob(input.accountId, input.jobId);
        if (
          job?.status !== 'pending' ||
          job.notBefore > input.now ||
          job.attempts >= job.maxAttempts
        )
          return null;
        if (input.now.getTime() - job.dataAsOf.getTime() > 30 * 60000) {
          const expired: AnalysisJob = {
            ...job,
            status: 'failed',
            updatedAt: input.now,
            finishedAt: input.now,
            error: { code: 'stale_context', message: 'Analysis facts are stale', retryable: false },
          };
          this.update(expired);
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
        this.db.insert(analysisContexts).values(contextRow(context)).run();
        this.update(next);
        return next;
      },
      { behavior: 'immediate' },
    );
  }

  async refreshContext(
    input: Parameters<AnalysisRepository['refreshContext']>[0],
  ): Promise<AnalysisJob | null> {
    return this.db.transaction(
      () => {
        const job = this.readJob(input.accountId, input.jobId);
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
        this.db.insert(analysisContexts).values(contextRow(context)).run();
        this.closeContext(job, input.now);
        this.update(updated);
        return updated;
      },
      { behavior: 'immediate' },
    );
  }

  async fail(input: Parameters<AnalysisRepository['fail']>[0]): Promise<AnalysisJob | null> {
    return this.db.transaction(
      () => {
        const job = this.readJob(input.accountId, input.jobId);
        if (!job || !hasAnalysisLease(job, input.token, input.now)) return null;
        const next = releaseAnalysisJob(job, input.now, input.error, input.notBefore);
        this.closeContext(job, input.now);
        this.update(next);
        return next;
      },
      { behavior: 'immediate' },
    );
  }

  async cancel(accountId: string, id: string, now: Date): Promise<AnalysisJob | null> {
    return this.db.transaction(
      () => {
        const job = this.readJob(accountId, id);
        if (!job || !['pending', 'claimed'].includes(job.status)) return null;
        const next: AnalysisJob = {
          ...job,
          status: 'cancelled',
          claimToken: null,
          claimedBy: null,
          leaseUntil: null,
          finishedAt: now,
          updatedAt: now,
        };
        this.closeContext(job, now);
        this.update(next);
        return next;
      },
      { behavior: 'immediate' },
    );
  }

  async requeue(accountId: string, id: string, now: Date): Promise<AnalysisJob | null> {
    return this.db.transaction(
      () => {
        const job = this.readJob(accountId, id);
        if (job?.status !== 'dead_letter') return null;
        if (
          this.db
            .select({ id: analysisJobs.id })
            .from(analysisJobs)
            .where(
              and(
                eq(analysisJobs.dedupeKey, job.dedupeKey),
                inArray(analysisJobs.status, ['pending', 'claimed']),
              ),
            )
            .get()
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
        this.update(next);
        return next;
      },
      { behavior: 'immediate' },
    );
  }

  async saveContext(context: AnalysisContext): Promise<void> {
    assertAnalysisContextInvariants(context);
    if (context.jobId !== null) throw new InvariantError('batch_context_requires_claim');
    this.db.insert(analysisContexts).values(contextRow(context)).run();
  }

  async findContext(accountId: string, id: string): Promise<AnalysisContext | null> {
    const row = this.db
      .select()
      .from(analysisContexts)
      .where(and(eq(analysisContexts.accountId, accountId), eq(analysisContexts.id, id)))
      .get();
    return row
      ? AnalysisContextSchema.parse({
          ...row,
          recordedResult: row.recordedResult ?? undefined,
          subject: { kind: row.subjectKind, id: row.subjectId },
        })
      : null;
  }

  private update(job: AnalysisJob): void {
    assertAnalysisJobInvariants(job);
    this.db.update(analysisJobs).set(jobRow(job)).where(eq(analysisJobs.id, job.id)).run();
  }
  private closeContext(job: AnalysisJob, now: Date): void {
    if (!job.contextId) return;
    this.db
      .update(analysisContexts)
      .set({ writeUntil: now, expiresAt: new Date(now.getTime() + 30 * 86400000) })
      .where(eq(analysisContexts.id, job.contextId))
      .run();
  }
  private savePublication(input: AnalysisRecordPublication, context: AnalysisContext): void {
    const workspace = new DrizzleInvestmentWorkspaceRepository(this.db);
    const strategy = new DrizzleStrategyRepository(this.db);
    const actions = new DrizzleStrategyAutonomyActionRepository(this.db);
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
