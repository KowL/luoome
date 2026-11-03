import { z } from 'zod';
import { InvariantError } from '../error/index.js';
import type { AnalysisContext } from './analysis-context.js';
import { AnalysisKindSchema, AnalysisSubjectSchema, analysisSubjectKinds } from './analysis-job.js';

export const GoalRequestSchema = z
  .object({
    goal: z.string().trim().min(1).max(4000),
    kind: AnalysisKindSchema,
    subject: AnalysisSubjectSchema,
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    maxRounds: z.number().int().min(1).max(10),
    maxDurationMs: z.number().int().min(1000).max(900000).default(900000),
    maxTokens: z.number().int().positive().max(200000).default(200000),
    estimatedTokens: z.number().int().positive(),
    estimatedDurationMs: z.number().int().positive(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (analysisSubjectKinds[request.kind] !== request.subject.kind)
      ctx.addIssue({ code: 'custom', message: 'goal_subject_mismatch' });
    if (
      request.estimatedTokens > request.maxTokens ||
      request.estimatedDurationMs > request.maxDurationMs
    )
      ctx.addIssue({ code: 'custom', message: 'goal_estimate_exceeds_budget' });
  });
export type GoalRequest = z.infer<typeof GoalRequestSchema>;
export const GoalRoundOutputSchema = z
  .object({
    summary: z.string().trim().min(1).max(8000),
    factIds: z.array(z.string().min(1)).min(1).max(200),
    status: z.enum(['continue', 'completed', 'blocked']),
    needsRevision: z.boolean(),
    blockedCondition: z.string().trim().min(1).max(2000).nullable(),
  })
  .strict()
  .superRefine((output, ctx) => {
    if ((output.status === 'blocked') !== (output.blockedCondition !== null))
      ctx.addIssue({ code: 'custom', message: 'goal_blocked_condition_required' });
  });
export type GoalRoundOutput = z.infer<typeof GoalRoundOutputSchema>;
export const GoalAttemptSchema = z
  .object({
    round: z.number().int().min(1).max(10),
    revision: z.number().int().min(0).max(1),
    contextId: z.string().min(1),
    dataAsOf: z.coerce.date(),
    createdAt: z.coerce.date(),
    tokenUsed: z.number().int().nonnegative().nullable(),
    output: GoalRoundOutputSchema.nullable(),
    error: z.string().trim().min(1).max(2000).nullable(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if ((attempt.output === null) !== (attempt.error !== null))
      ctx.addIssue({ code: 'custom', message: 'goal_attempt_outcome_mismatch' });
  });
export type GoalAttempt = z.infer<typeof GoalAttemptSchema>;
export const acceptedGoalRounds = (run: { attempts: readonly GoalAttempt[] }): GoalAttempt[] =>
  run.attempts.filter((attempt) => attempt.output !== null && !attempt.output.needsRevision);

const stopAfterAttempt = (attempt: GoalAttempt, maxRounds: number) => {
  if (!attempt.output || attempt.output.needsRevision)
    return attempt.revision === 1
      ? {
          status: 'blocked' as const,
          blockedCondition: `round ${attempt.round}: revision_limit_reached; ${attempt.error ?? 'output still requires revision'}`,
        }
      : null;
  if (attempt.output.status === 'completed')
    return { status: 'completed' as const, blockedCondition: null };
  if (attempt.output.status === 'blocked')
    return { status: 'blocked' as const, blockedCondition: attempt.output.blockedCondition };
  return attempt.round >= maxRounds
    ? {
        status: 'blocked' as const,
        blockedCondition: `round_limit_reached: ${maxRounds} rounds exhausted without a completed conclusion`,
      }
    : null;
};
export const GoalRunSchema = z
  .object({
    id: z.string().min(1),
    accountId: z.string().min(1),
    requestId: z.string().min(1),
    requestHash: z.string().min(1),
    request: GoalRequestSchema,
    status: z.enum(['pending', 'running', 'completed', 'blocked', 'cancelled', 'failed']),
    version: z.number().int().nonnegative(),
    hostJobId: z.string().min(1).nullable(),
    attempts: z.array(GoalAttemptSchema).max(20),
    blockedCondition: z.string().trim().min(1).max(4000).nullable(),
    error: z.string().trim().min(1).max(2000).nullable(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    finishedAt: z.coerce.date().nullable(),
  })
  .strict()
  .superRefine((run, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    if ((run.status === 'blocked') !== (run.blockedCondition !== null))
      invalid('goal_blocked_state_mismatch');
    if ((run.status === 'failed') !== (run.error !== null)) invalid('goal_error_state_mismatch');
    const terminal = run.status !== 'pending' && run.status !== 'running';
    if (terminal !== (run.finishedAt !== null)) invalid('goal_terminal_state_mismatch');
    if (run.status === 'running' && !run.hostJobId) invalid('goal_host_job_required');
    if (run.status === 'pending' && (run.hostJobId || run.attempts.length))
      invalid('goal_pending_state_mismatch');
    let round = 1;
    let revision = 0;
    for (const [index, attempt] of run.attempts.entries()) {
      if (
        attempt.revision === 1 &&
        (run.attempts[index - 1]?.contextId !== attempt.contextId ||
          run.attempts[index - 1]?.dataAsOf.getTime() !== attempt.dataAsOf.getTime())
      )
        invalid('goal_revision_context_changed');
      if (
        attempt.round !== round ||
        attempt.revision !== revision ||
        attempt.round > run.request.maxRounds
      )
        invalid('goal_attempt_sequence_invalid');
      if (
        attempt.createdAt < run.createdAt ||
        attempt.createdAt > run.updatedAt ||
        attempt.dataAsOf > attempt.createdAt
      )
        invalid('goal_attempt_time_invalid');
      const stop = stopAfterAttempt(attempt, run.request.maxRounds);
      if (
        stop &&
        (index !== run.attempts.length - 1 ||
          run.status !== stop.status ||
          run.blockedCondition !== stop.blockedCondition)
      )
        invalid('goal_stop_state_mismatch');
      if (attempt.output && !attempt.output.needsRevision) {
        round += 1;
        revision = 0;
      } else revision = 1;
    }
    if (
      run.status === 'completed' &&
      (run.attempts.at(-1)?.output?.status !== 'completed' ||
        run.attempts.at(-1)?.output?.needsRevision)
    )
      invalid('goal_completion_requires_evidence');
    if (run.updatedAt < run.createdAt || (run.finishedAt && run.finishedAt < run.createdAt))
      invalid('goal_time_order_invalid');
  });
export type GoalRun = z.infer<typeof GoalRunSchema>;
export type GoalCommand =
  | { type: 'start'; hostJobId: string }
  | { type: 'attempt'; attempt: Omit<GoalAttempt, 'createdAt' | 'dataAsOf'> }
  | { type: 'block'; condition: string }
  | { type: 'fail'; error: string };
export const goalEvidenceError = (
  run: GoalRun,
  context: AnalysisContext,
  output: GoalRoundOutput | null,
): string | null => {
  if (
    context.accountId !== run.accountId ||
    context.kind !== run.request.kind ||
    context.subject.kind !== run.request.subject.kind ||
    context.subject.id !== run.request.subject.id
  )
    return 'goal_context_scope_mismatch';
  if (output?.factIds.some((id) => !context.factIds.includes(id)))
    return 'goal_unknown_fact_reference';
  return null;
};
export const applyGoalCommand = (
  run: GoalRun,
  command: GoalCommand,
  now: Date,
  context?: AnalysisContext,
): GoalRun => {
  if (run.status !== 'pending' && run.status !== 'running')
    throw new InvariantError('goal_already_terminal');
  const next = { ...run, version: run.version + 1, updatedAt: now };
  if (command.type === 'start') {
    if (run.status !== 'pending') throw new InvariantError('goal_already_started');
    return GoalRunSchema.parse({ ...next, status: 'running', hostJobId: command.hostJobId });
  }
  if (command.type === 'fail')
    return GoalRunSchema.parse({
      ...next,
      status: 'failed',
      error: command.error,
      finishedAt: now,
    });
  if (command.type === 'block')
    return GoalRunSchema.parse({
      ...next,
      status: 'blocked',
      blockedCondition: command.condition,
      finishedAt: now,
    });
  if (run.status !== 'running' || !context || context.id !== command.attempt.contextId)
    throw new InvariantError('goal_persisted_context_required');
  const evidenceError = goalEvidenceError(run, context, command.attempt.output);
  if (evidenceError) throw new InvariantError(evidenceError);
  const attempt = GoalAttemptSchema.parse({
    ...command.attempt,
    dataAsOf: context.dataAsOf,
    createdAt: now,
  });
  const stop = stopAfterAttempt(attempt, run.request.maxRounds);
  return GoalRunSchema.parse({
    ...next,
    attempts: [...run.attempts, attempt],
    ...(stop ? { ...stop, finishedAt: now } : {}),
  });
};
export const cancelGoalRun = (run: GoalRun, now: Date): GoalRun | null =>
  run.status === 'pending' || run.status === 'running'
    ? GoalRunSchema.parse({
        ...run,
        status: 'cancelled',
        version: run.version + 1,
        updatedAt: now,
        finishedAt: now,
      })
    : null;
