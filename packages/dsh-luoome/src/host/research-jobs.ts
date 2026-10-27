import type { StrategyEvaluationSession, ToolContext, ToolResult } from '@luoome/core';
import {
  executeStrictStrategyBacktestTool,
  finishStrategyEvaluationSessionTool,
  getStrategyEvaluationSessionTool,
} from '@luoome/tools';
import { replayStrategyRangeWorkflow } from '@luoome/workflows';

export interface ResearchJobs {
  canStart(id?: string): boolean;
  startEvaluation(session: StrategyEvaluationSession, ctx: ToolContext): void;
  startStrict(backtestRunId: string, ctx: ToolContext): void;
  cancel(sessionId: string): void;
  status(sessionId: string): 'running' | 'idle';
  settled(): Promise<void>;
  dispose(): void;
}

export const createResearchJobs = (
  options: {
    readonly maxConcurrent?: number;
    readonly replay?: typeof replayStrategyRangeWorkflow.run;
  } = {},
): ResearchJobs => {
  const jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  let disposed = false;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const launch = (
    id: string,
    ctx: ToolContext,
    execute: (context: ToolContext) => Promise<ToolResult<unknown>>,
    fail?: (kind: string) => Promise<void>,
  ) => {
    if (disposed || jobs.has(id) || jobs.size >= maxConcurrent) return;
    const controller = new AbortController();
    const recordFailure = async (kind: string) => {
      if (disposed || !fail) return;
      try {
        await fail(kind);
      } catch {
        ctx.logger.warn('Research task status could not be persisted');
      }
    };
    // Acceptance is durable before work starts. The HTTP request no longer owns
    // this lifetime; explicit cancellation and host disposal do.
    const promise = new Promise<void>((resolve) => setTimeout(resolve, 0))
      .then(async () => {
        if (controller.signal.aborted || disposed) return;
        const result = await execute({ ...ctx, abortSignal: controller.signal });
        if (!result.ok) await recordFailure(result.error.kind);
      })
      .catch(async () => {
        await recordFailure('internal');
      })
      .finally(() => jobs.delete(id));
    jobs.set(id, { controller, promise });
  };
  return {
    canStart: (id) =>
      !disposed && ((id !== undefined && jobs.has(id)) || jobs.size < maxConcurrent),
    startEvaluation(session, ctx) {
      launch(
        session.id,
        ctx,
        (context) =>
          (options.replay ?? replayStrategyRangeWorkflow.run)(
            {
              strategyId: session.strategyId,
              versionId: session.strategyVersionId,
              from: session.from,
              to: session.to,
              ...(session.stockIds === undefined ? {} : { stockIds: session.stockIds }),
              persist: true,
              resumeSessionId: session.id,
              owner: `dsh-research:${session.id}`,
            },
            context,
          ),
        async (kind) => {
          const current = await getStrategyEvaluationSessionTool.execute(
            { sessionId: session.id },
            ctx,
          );
          if (current.ok && current.data.session?.status === 'running')
            await finishStrategyEvaluationSessionTool.execute(
              { sessionId: session.id, status: 'failed', error: `research_job_failed:${kind}` },
              ctx,
            );
        },
      );
    },
    startStrict(backtestRunId, ctx) {
      launch(`strict:${backtestRunId}`, ctx, (context) =>
        executeStrictStrategyBacktestTool.execute({ backtestRunId }, context),
      );
    },
    cancel(sessionId) {
      jobs.get(sessionId)?.controller.abort('Research evaluation cancelled');
    },
    status: (sessionId) => (jobs.has(sessionId) ? 'running' : 'idle'),
    async settled() {
      await Promise.all([...jobs.values()].map((job) => job.promise));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const job of jobs.values()) job.controller.abort('Research host disposed');
    },
  };
};
