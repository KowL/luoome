import { z } from 'zod';
import { InvariantError } from '../error/index.js';

export const AnalysisKindSchema = z.enum([
  'advice_stock',
  'advice_position',
  'advice_market',
  'advice_strategy_candidate',
  'research_directions',
  'strategy_version_proposal',
  'strategy_insight_narrative',
]);
export type AnalysisKind = z.infer<typeof AnalysisKindSchema>;
export const AnalysisSubjectSchema = z.object({
  kind: z.enum(['stock', 'position', 'market', 'strategy', 'research']),
  id: z.string().min(1),
});
export type AnalysisSubject = z.infer<typeof AnalysisSubjectSchema>;
export const analysisSubjectKinds: Record<AnalysisKind, AnalysisSubject['kind']> = {
  advice_stock: 'stock',
  advice_position: 'position',
  advice_market: 'market',
  advice_strategy_candidate: 'stock',
  research_directions: 'research',
  strategy_version_proposal: 'strategy',
  strategy_insight_narrative: 'strategy',
};
export const AnalysisJobStatusSchema = z.enum([
  'pending',
  'claimed',
  'completed',
  'failed',
  'dead_letter',
  'cancelled',
]);
export type AnalysisJobStatus = z.infer<typeof AnalysisJobStatusSchema>;
export const AnalysisFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});
export const AnalysisJobSchema = z
  .object({
    id: z.string().min(1),
    kind: AnalysisKindSchema,
    source: z.enum(['workflow', 'tool', 'schedule', 'chat']),
    accountId: z.string().min(1),
    subject: AnalysisSubjectSchema,
    priority: z.number().int().min(0).max(100),
    dedupeKey: z.string().min(1),
    payload: z.record(z.string(), z.json()),
    dataAsOf: z.coerce.date(),
    notBefore: z.coerce.date(),
    status: AnalysisJobStatusSchema,
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    claimToken: z.string().min(1).nullable(),
    claimedBy: z.string().min(1).nullable(),
    leaseUntil: z.coerce.date().nullable(),
    contextId: z.string().min(1).nullable(),
    result: z
      .object({
        resultRef: z.string().min(1),
        resultHash: z.string().min(1),
        completedClaimToken: z.string().min(1),
      })
      .nullable(),
    error: AnalysisFailureSchema.nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    finishedAt: z.coerce.date().nullable(),
  })
  .superRefine((job, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (analysisSubjectKinds[job.kind] !== job.subject.kind) invalid('analysis_subject_mismatch');
    const claimed = job.status === 'claimed';
    if (
      claimed
        ? !job.claimToken || !job.claimedBy || !job.leaseUntil || !job.contextId
        : job.claimToken !== null || job.claimedBy !== null || job.leaseUntil !== null
    ) {
      invalid('analysis_claim_state_mismatch');
    }
    if ((job.status === 'completed') !== (job.result !== null))
      invalid('analysis_result_state_mismatch');
    const terminal = job.status !== 'pending' && !claimed;
    if (terminal !== (job.finishedAt !== null)) invalid('analysis_finished_state_mismatch');
    if (job.attempts > job.maxAttempts || (claimed && job.attempts === 0))
      invalid('analysis_attempts_invalid');
    if (job.updatedAt < job.createdAt || (job.finishedAt && job.finishedAt < job.createdAt)) {
      invalid('analysis_time_order_invalid');
    }
  });
export type AnalysisJob = z.infer<typeof AnalysisJobSchema>;
export const assertAnalysisJobInvariants = (job: AnalysisJob): void => {
  const result = AnalysisJobSchema.safeParse(job);
  if (!result.success) throw new InvariantError(result.error.message);
};

export const hasAnalysisLease = (job: AnalysisJob, token: string, now: Date): boolean =>
  job.status === 'claimed' &&
  job.claimToken === token &&
  job.leaseUntil !== null &&
  job.leaseUntil > now;

export const releaseAnalysisJob = (
  job: AnalysisJob,
  now: Date,
  error: z.infer<typeof AnalysisFailureSchema>,
  notBefore = now,
): AnalysisJob => {
  if (job.status !== 'claimed') throw new InvariantError('job_not_claimed');
  const retry = error.retryable && job.attempts < job.maxAttempts;
  const next: AnalysisJob = {
    ...job,
    status: retry ? 'pending' : 'dead_letter',
    claimToken: null,
    claimedBy: null,
    leaseUntil: null,
    contextId: null,
    result: null,
    error,
    notBefore,
    updatedAt: now,
    finishedAt: retry ? null : now,
  };
  assertAnalysisJobInvariants(next);
  return next;
};
