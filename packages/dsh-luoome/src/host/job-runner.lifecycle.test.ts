import { Context } from '@deepseek-ai/cordis';
import type { JobId } from '@deepseek-ai/dsh-jobs';
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local';
import { money } from '@luoome/core';
import { enqueueAnalysisJobTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { createDshJobRunner } from './job-runner.js';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

// Test the installed registry's lifecycle rather than a status-map substitute.
describe('JobRunner with real LocalJobRegistry', () => {
  it('owns host control and waits for producer cleanup before disposal', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(LocalJobRegistry, {});
    await fiber.await();
    const runner = createDshJobRunner(ctx);
    const entered = gate();
    const cleanup = gate();
    let stopped = false;
    let disposed = false;
    try {
      const id = runner.start({
        label: 'plugin-owned lifecycle',
        run: async (handle) => {
          const aborted = new Promise<void>((resolve) =>
            handle.signal?.addEventListener(
              'abort',
              () => {
                stopped = true;
                resolve();
              },
              { once: true },
            ),
          );
          entered.release();
          await aborted;
          await cleanup.promise;
          return null;
        },
      });
      await entered.promise;
      const disposal = runner.dispose().then(() => {
        disposed = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(true);
      expect(disposed).toBe(false);
      expect(ctx.jobs.list().find((job) => String(job.id) === id)?.status).toBe('stopping');
      expect(() => runner.start({ label: 'late', run: async () => null })).toThrow('disposed');
      cleanup.release();
      await disposal;
      expect(runner.get(id)).toBeNull();
      expect(() =>
        ctx.jobs.start({
          kind: 'probe' as never,
          label: 'no controller',
          run: () => ({
            cancel: () => {},
            done: Promise.resolve({ status: 'completed' as const }),
          }),
        }),
      ).toThrow('no job controller');
    } finally {
      cleanup.release();
      await runner.dispose();
      await fiber.dispose();
    }
  });
  it.each([false, true])(
    'writes actual domain completion or cancellation with a real host (cancel=%s)',
    async (cancel) => {
      const host = new Context();
      const fiber = host.plugin(LocalJobRegistry, {});
      await fiber.await();
      const detach = host.jobs.attachController('luoome-analysis-test');
      const work = gate();
      const entered = gate();
      try {
        const now = new Date('2026-07-29T04:00:00Z');
        const base = await buildTestContext({ clock: () => now, advices: [] });
        await base.repos.quote.save({
          stockId: '600519.SH',
          ts: now,
          observedAt: now,
          fetchedAt: now,
          timestampSource: 'upstream',
          open: money(100),
          high: money(101),
          low: money(99),
          close: money(100),
          volume: 1000,
          source: 'test',
        });
        const runner = createDshJobRunner(host);
        const domain = {
          ...base,
          jobRunner: runner,
          analysisRunner: async () => {
            entered.release();
            await work.promise;
            return {
              result: {
                decision: 'watch',
                confidence: 50,
                horizon: 'short',
                reasoning: { premise: '观察', evidence: ['行情'], counterEvidence: ['量能不足'] },
                risks: ['数据有限'],
              },
              provenance: { generatorKind: 'dsh-worker', evidenceFactIds: ['quote:600519.SH'] },
            };
          },
        };
        const queued = await enqueueAnalysisJobTool.execute(
          { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' }, source: 'workflow' },
          domain,
        );
        if (!queued.ok) throw new Error('enqueue failed');
        await entered.promise;
        const hostId = host.jobs.list()[0]?.id;
        if (!hostId) throw new Error('missing real host job');
        expect(host.jobs.get(hostId).status).toBe('running');
        expect(
          (await domain.repos.analysis.findJob(domain.user.defaultAccountId, queued.data.jobId))
            ?.status,
        ).toBe('claimed');
        if (cancel) {
          expect(runner.kill(String(hostId))).toBe('requested');
          expect(host.jobs.get(hostId).status).toBe('stopping');
        }
        work.release();
        expect((await host.jobs.wait(hostId, 1000)).status).toBe(cancel ? 'killed' : 'completed');
        const saved = await domain.repos.analysis.findJob(
          domain.user.defaultAccountId,
          queued.data.jobId,
        );
        expect(saved?.status).toBe(cancel ? 'cancelled' : 'completed');
        if (cancel) {
          expect(saved?.result).toBeNull();
          expect(saved?.cancelledOutput).toContain('assembled');
          expect(await domain.repos.advice.query({ includeExpired: true })).toEqual([]);
        } else {
          expect(saved?.result).not.toBeNull();
          expect(saved?.cancelledOutput).toBeNull();
          expect(await domain.repos.advice.findById(saved?.result?.resultRef ?? '')).not.toBeNull();
        }
      } finally {
        work.release();
        detach();
        await fiber.dispose();
      }
    },
  );
  it('keeps work running until released, then completes with retained output', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(LocalJobRegistry, {});
    await fiber.await();
    const detach = ctx.jobs.attachController('luoome-test');
    const work = gate();
    try {
      const runner = createDshJobRunner(ctx);
      let isCancelled = () => false;
      const id = runner.start({
        label: 'gated',
        run: async (handle) => {
          isCancelled = () => handle.cancelled;
          handle.append('started\n');
          await work.promise;
          handle.append('finished\n');
          return { output: 'result' };
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(ctx.jobs.get(id as JobId).status).toBe('running');
      work.release();
      expect((await ctx.jobs.wait(id as JobId, 1000)).status).toBe('completed');
      expect(runner.get(id)?.output).toBe('started\nfinished\n');
      expect(runner.kill(id)).toBe('already-finished');
      expect(isCancelled()).toBe(false);
    } finally {
      work.release();
      detach();
      await fiber.dispose();
    }
  });

  it('stays stopping until cancelled producer releases, then settles killed', async () => {
    const ctx = new Context();
    const fiber = ctx.plugin(LocalJobRegistry, {});
    await fiber.await();
    const detach = ctx.jobs.attachController('luoome-test');
    const work = gate();
    try {
      const runner = createDshJobRunner(ctx);
      let cancelled = false;
      const id = runner.start({
        label: 'cancel-gated',
        run: async (handle) => {
          handle.append('started\n');
          await work.promise;
          cancelled = handle.cancelled;
          handle.append('released\n');
          return { output: 'late-result' };
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(runner.kill(id)).toBe('requested');
      expect(ctx.jobs.get(id as JobId).status).toBe('stopping');
      work.release();
      expect((await ctx.jobs.wait(id as JobId, 1000)).status).toBe('killed');
      expect(cancelled).toBe(true);
      expect(runner.get(id)?.output).toContain('released');
    } finally {
      work.release();
      detach();
      await fiber.dispose();
    }
  });
});
