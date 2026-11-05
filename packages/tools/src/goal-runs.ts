import { randomUUID } from 'node:crypto';
import {
  type AnalysisContext,
  acceptedGoalRounds,
  BLOCKING_MISSING_FACT_KINDS,
  GoalRequestSchema,
  GoalRoundOutputSchema,
  type GoalRun,
  GoalRunSchema,
  goalEvidenceError,
  type JobRunnerHandle,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errAdapterError, errInvalidInput, errNotFound } from './define-tool.js';
import { analysisHash, getAnalysisContextTool } from './queue/context.js';

export const StartGoalRunInput = z
  .object({
    accountId: z.string().min(1).optional(),
    requestId: z.string().min(1).optional(),
    request: GoalRequestSchema,
    confirmed: z.literal(true),
  })
  .strict();
export const GoalRunReceiptSchema = z.object({
  goalId: z.string(),
  hostJobId: z.string().nullable(),
  status: GoalRunSchema.shape.status,
});
export const goalRunReceipt = (run: GoalRun) => ({
  goalId: run.id,
  hostJobId: run.hostJobId,
  status: run.status,
});
const deferred = () => {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
};

const executeGoalRun = async (
  id: string,
  accountId: string,
  ctx: ToolContext,
  handle: JobRunnerHandle,
  launched: Promise<void>,
) => {
  let cancellation: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
  const abort = () => {
    cancellation = ctx.repos.goalRun.cancel(accountId, id, ctx.clock()).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  };
  handle.signal?.addEventListener('abort', abort, { once: true });
  if (handle.signal?.aborted) abort();
  const execute = async () => {
    await launched;
    let run = await ctx.repos.goalRun.find(accountId, id);
    if (!run) throw new Error('goal_run_missing');
    const timeout = AbortSignal.timeout(run.request.maxDurationMs);
    const signal = AbortSignal.any([timeout, ...(handle.signal ? [handle.signal] : [])]);
    let snapshot: AnalysisContext | null = null;
    const startedAt = Date.now();
    const apply = async (
      command: Parameters<ToolContext['repos']['goalRun']['apply']>[0]['command'],
    ) => {
      if (!run) throw new Error('goal_run_missing');
      const next = await ctx.repos.goalRun.apply({
        accountId,
        id,
        expectedVersion: run.version,
        command,
        now: ctx.clock(),
      });
      run = next ?? (await ctx.repos.goalRun.find(accountId, id));
      if (!run) throw new Error('goal_run_missing');
      if (!next && run.status === 'running') throw new Error('goal_progress_conflict');
    };
    try {
      while (run.status === 'running') {
        if (handle.cancelled || handle.signal?.aborted) {
          await ctx.repos.goalRun.cancel(accountId, id, ctx.clock());
          break;
        }
        if (timeout.aborted || Date.now() - startedAt >= run.request.maxDurationMs) {
          await apply({
            type: 'block',
            condition: 'goal_time_budget_exceeded: maximum execution duration reached',
          });
          break;
        }
        const knownTokens = run.attempts.reduce((sum, item) => sum + (item.tokenUsed ?? 0), 0);
        if (knownTokens >= run.request.maxTokens) {
          await apply({
            type: 'block',
            condition: `goal_token_budget_exceeded: ${knownTokens} reported tokens reached the configured cap`,
          });
          break;
        }
        const last = run.attempts.at(-1);
        const revising = last !== undefined && (!last.output || last.output.needsRevision);
        const round = revising ? last.round : (last?.round ?? 0) + 1;
        const revision = revising ? 1 : 0;
        if (!revising) {
          const result = await getAnalysisContextTool.execute(
            {
              kind: run.request.kind,
              subject: run.request.subject,
              options: {},
              accountId,
            },
            ctx,
          );
          if (!result.ok) {
            await apply({
              type: 'block',
              condition: `round ${round}: context_unavailable for ${run.request.subject.kind}:${run.request.subject.id}; ${'message' in result.error ? result.error.message : result.error.kind}`,
            });
            break;
          }
          snapshot = result.data;
          const blocking = snapshot.missingFacts.filter((fact) =>
            BLOCKING_MISSING_FACT_KINDS.has(fact.kind),
          );
          if (blocking.length || snapshot.factIds.length === 0) {
            await apply({
              type: 'block',
              condition: `round ${round}: missing persisted facts; ${blocking.map((fact) => `${fact.kind}:${fact.subjectId}:${fact.reason}`).join('; ') || 'empty factIds'}`,
            });
            break;
          }
        }
        if (!snapshot) throw new Error('goal_snapshot_missing');
        if (signal.aborted || handle.cancelled) continue;
        const runner = ctx.goalRoundRunner;
        if (!runner) throw new Error('goal_model_service_unavailable');
        const response = await runner({
          run: structuredClone(run),
          round,
          revision,
          context: structuredClone(snapshot),
          feedback: revising
            ? (last.error ??
              'Revise the draft once using the same snapshot; no further revisions are permitted.')
            : null,
          signal,
        });
        if (handle.cancelled || handle.signal?.aborted) {
          await ctx.repos.goalRun.cancel(accountId, id, ctx.clock());
          break;
        }
        if (timeout.aborted) {
          await apply({
            type: 'block',
            condition: 'goal_time_budget_exceeded: model request exceeded the configured duration',
          });
          break;
        }
        const parsed = GoalRoundOutputSchema.safeParse(response.output);
        const overBudget =
          response.tokenUsed !== null && knownTokens + response.tokenUsed > run.request.maxTokens;
        const budgetCondition = `goal_token_budget_exceeded: ${knownTokens + (response.tokenUsed ?? 0)} reported tokens exceed the configured cap`;
        const error = overBudget
          ? budgetCondition
          : parsed.success
            ? goalEvidenceError(run, snapshot, parsed.data)
            : 'goal_invalid_model_output: summary, valid status and at least one snapshot factId are required';
        await apply({
          type: 'attempt',
          attempt: {
            round,
            revision,
            contextId: snapshot.id,
            output: error ? null : parsed.success ? parsed.data : null,
            error,
            tokenUsed: response.tokenUsed,
          },
        });
        if (overBudget && run.status === 'running')
          await apply({ type: 'block', condition: budgetCondition });
        handle.append(
          `round:${round} revision:${revision} status:${run.status} evidence:${parsed.success && !error ? parsed.data.factIds.join(',') : 'invalid'}\n`,
        );
      }
    } catch {
      const current = await ctx.repos.goalRun.find(accountId, id);
      if (current) run = current;
      if (handle.cancelled || handle.signal?.aborted)
        await ctx.repos.goalRun.cancel(accountId, id, ctx.clock());
      else if (run.status === 'running')
        await apply(
          timeout.aborted
            ? { type: 'block', condition: 'goal_time_budget_exceeded: model request timed out' }
            : {
                type: 'fail',
                error:
                  'goal_execution_failed: context, model request or progress persistence failed',
              },
        );
    }
    const saved = await ctx.repos.goalRun.find(accountId, id);
    if (!saved) throw new Error('goal_run_missing');
    handle.append(
      `goal:${saved.status} rounds:${acceptedGoalRounds(saved).length}${saved.blockedCondition ? ` blocked:${saved.blockedCondition}` : ''}\n`,
    );
    if (saved.status === 'failed') throw new Error(saved.error ?? 'goal_execution_failed');
    return { output: JSON.stringify(goalRunReceipt(saved)) };
  };
  try {
    const output = await execute();
    const settled = await cancellation;
    if (settled?.ok === false) throw settled.error;
    return output;
  } finally {
    handle.signal?.removeEventListener('abort', abort);
    await cancellation;
  }
};

export const startGoalRunTool = defineTool({
  name: 'start_goal_run',
  description:
    '明确目标、轮次和成本后启动有界研究长跑；每轮引用持久化事实，最多修订一次，不生成 Advice 或交易。',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  input: StartGoalRunInput,
  output: GoalRunReceiptSchema,
  handler: async (input, ctx) => {
    const jobRunner = ctx.jobRunner;
    if (!jobRunner || !ctx.goalRoundRunner)
      return errAdapterError('goal-run', '宿主尚未接入目标长跑执行服务。', false);
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!(await ctx.repos.account.findById(accountId))) return errNotFound('Account', accountId);
    const requestId = input.requestId ?? randomUUID();
    const now = ctx.clock();
    const created = await ctx.repos.goalRun.create(
      GoalRunSchema.parse({
        id: `goal:${requestId}`,
        accountId,
        requestId,
        requestHash: analysisHash({ accountId, request: input.request }),
        request: input.request,
        status: 'pending',
        version: 0,
        hostJobId: null,
        attempts: [],
        blockedCondition: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      }),
    );
    if (created.replayed) return goalRunReceipt(created.run);
    const launched = deferred();
    let hostJobId: string | undefined;
    try {
      hostJobId = jobRunner.start({
        label: `目标研究 · ${input.request.subject.id}`,
        run: (handle) => executeGoalRun(created.run.id, accountId, ctx, handle, launched.promise),
      });
      const started = await ctx.repos.goalRun.apply({
        accountId,
        id: created.run.id,
        expectedVersion: 0,
        command: { type: 'start', hostJobId },
        now: ctx.clock(),
      });
      if (!started) {
        jobRunner.kill(hostJobId);
        return errInvalidInput('goal_start_cancelled_or_conflicted');
      }
      return goalRunReceipt(started);
    } catch {
      const current = await ctx.repos.goalRun.find(accountId, created.run.id);
      if (current && ['pending', 'running'].includes(current.status))
        await ctx.repos.goalRun.apply({
          accountId,
          id: current.id,
          expectedVersion: current.version,
          command: {
            type: 'fail',
            error: 'goal_start_failed: host execution could not be started',
          },
          now: ctx.clock(),
        });
      if (hostJobId) jobRunner.kill(hostJobId);
      return errAdapterError('goal-run', 'goal_start_failed', false);
    } finally {
      launched.release();
    }
  },
});
const GoalIdInput = z
  .object({ goalId: z.string().min(1), accountId: z.string().min(1).optional() })
  .strict();
export const getGoalRunTool = defineTool({
  name: 'get_goal_run',
  description: '读取当前账户目标长跑的持久化轮次、修订、事实引用与具体阻塞条件。',
  sideEffect: 'read',
  input: GoalIdInput,
  output: GoalRunSchema,
  handler: async (input, ctx) =>
    (await ctx.repos.goalRun.find(input.accountId ?? ctx.user.defaultAccountId, input.goalId)) ??
    errNotFound('GoalRun', input.goalId),
});
export const cancelGoalRunTool = defineTool({
  name: 'cancel_goal_run',
  description: '取消当前账户目标长跑并保留已产出的研究证据；已结束任务保持原终态。',
  sideEffect: 'write',
  input: GoalIdInput,
  output: GoalRunReceiptSchema,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const run = await ctx.repos.goalRun.find(accountId, input.goalId);
    if (!run) return errNotFound('GoalRun', input.goalId);
    const cancelled = await ctx.repos.goalRun.cancel(accountId, run.id, ctx.clock());
    if (cancelled?.hostJobId && ctx.jobRunner) ctx.jobRunner.kill(cancelled.hostJobId);
    return goalRunReceipt(cancelled ?? run);
  },
});
