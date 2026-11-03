import type { Context } from '@deepseek-ai/cordis';
import type { JobHandle, JobId, JobOutcome } from '@deepseek-ai/dsh-jobs';
import type { JobRunner, JobRunnerHandle } from '@luoome/core';

export const createDshJobRunner = (ctx: Context): JobRunner & { dispose(): Promise<void> } => {
  // Detached domain jobs need host control even when no Agent has job tools mounted.
  const releaseController = ctx.jobs.attachController('dsh-luoome');
  const outputs = new Map<string, string>();
  let disposal: Promise<void> | undefined;

  return {
    dispose() {
      disposal ??= (async () => {
        const owned = ctx.jobs.list().filter((job) => outputs.has(String(job.id)));
        for (const job of owned) ctx.jobs.kill(job.id);
        await Promise.all(
          owned.map(async (job) => {
            let view = job;
            while (view.status === 'running' || view.status === 'stopping') {
              view = await ctx.jobs.wait(job.id, 60_000);
            }
          }),
        );
        releaseController();
        outputs.clear();
      })();
      return disposal;
    },
    start({ label, run }) {
      if (disposal !== undefined) throw new Error('luoome background runner is disposed');
      const id = ctx.jobs.start({
        kind: 'luoome-analysis' as never,
        label,
        run: (job: JobHandle) => {
          let cancelled = false;
          const controller = new AbortController();
          outputs.set(String(job.id), '');
          // The host must own the producer's actual lifetime, including cancellation cleanup.
          const done = (async (): Promise<JobOutcome> => {
            try {
              const result = await run({
                signal: controller.signal,
                append: (text) => {
                  outputs.set(String(job.id), (outputs.get(String(job.id)) ?? '') + text);
                  job.append(text);
                },
                get cancelled() {
                  return cancelled;
                },
              } satisfies JobRunnerHandle);
              return cancelled
                ? { status: 'killed' }
                : { status: 'completed', ...(result === null ? {} : { result: result.output }) };
            } catch (error) {
              return {
                status: cancelled ? 'killed' : 'failed',
                detail: error instanceof Error ? error.message : String(error),
              };
            }
          })();
          return {
            cancel: () => {
              cancelled = true;
              controller.abort('Analysis job cancelled');
            },
            done,
          };
        },
      });
      if (!outputs.has(String(id))) outputs.set(String(id), '');
      return String(id);
    },

    kill(jobId, reason) {
      if (!outputs.has(jobId)) return 'already-finished';
      // Only the host-accepted cancel hook changes the producer's cancellation flag.
      return ctx.jobs.kill(jobId as JobId, undefined, reason);
    },

    get(jobId) {
      if (!outputs.has(jobId)) return null;
      const view = ctx.jobs.get(jobId as JobId);
      return { status: view.status, output: outputs.get(jobId) ?? '' };
    },
  };
};
