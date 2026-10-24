import { money } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../registry.js';
import { buildTestContext } from '../testing/context.js';
import { getAnalysisContextTool } from './context.js';
import { claimAnalysisJobsTool, enqueueAnalysisJobTool, getAnalysisMetricsTool } from './jobs.js';
import { completeAnalysisJobTool, recordAdviceTool } from './record.js';

const now = new Date('2026-10-22T04:00:00Z');
const result = {
  decision: 'watch',
  confidence: 50,
  horizon: 'short',
  reasoning: { premise: '等待确认', evidence: ['已保存行情'], counterEvidence: ['缺少量能'] },
  risks: ['信息有限'],
};
const provenance = {
  generatorKind: 'dsh-chat',
  model: 'test:model',
  skillVersion: 'test',
  evidenceFactIds: ['quote:600519.SH'],
};
const setup = async () => {
  const ctx = await buildTestContext({ clock: () => now, advices: [] });
  await ctx.repos.quote.save({
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
  return ctx;
};

describe('analysis tools', () => {
  it('records an interactive context without creating a job; injects disclaimers and supports retry', async () => {
    const ctx = await setup();
    const snapshot = await getAnalysisContextTool.execute(
      { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' } },
      ctx,
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const input = { contextId: snapshot.data.id, result, provenance };
    const recorded = await recordAdviceTool.execute(input, ctx);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.data.disclaimers).toHaveLength(3);
    expect(recorded.data.basedOn.dataAsOf).toEqual(now);
    expect(
      await recordAdviceTool.execute(input, {
        ...ctx,
        clock: () => new Date(now.getTime() + 60000),
      }),
    ).toEqual(recorded);
    expect(await ctx.repos.analysis.listJobs({ accountId: ctx.user.defaultAccountId })).toEqual([]);
    expect(
      (
        await recordAdviceTool.execute(
          { ...input, provenance: { ...provenance, evidenceFactIds: ['invented'] } },
          ctx,
        )
      ).ok,
    ).toBe(false);
  });

  it('enqueues internally, lets only one consumer claim, and completes once', async () => {
    const ctx = await setup();
    expect(toolRegistry.get('enqueue_analysis_job')).toBeUndefined();
    const queued = await enqueueAnalysisJobTool.execute(
      { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' }, source: 'schedule' },
      ctx,
    );
    expect(queued.ok).toBe(true);
    const claims = await Promise.all(
      ['dsh:test', 'hosted:test'].map((owner) => claimAnalysisJobsTool.execute({ owner }, ctx)),
    );
    const acquired = claims.flatMap((item) => (item.ok ? item.data.claims : []));
    expect(acquired).toHaveLength(1);
    const claim = acquired[0];
    if (!claim) return;
    const input = { jobId: claim.job.id, claimToken: claim.claimToken, result, provenance };
    const completed = await completeAnalysisJobTool.execute(input, ctx);
    expect(completed.ok).toBe(true);
    expect(await completeAnalysisJobTool.execute(input, ctx)).toEqual(completed);
    expect((await completeAnalysisJobTool.execute({ ...input, claimToken: 'stale' }, ctx)).ok).toBe(
      false,
    );
    expect(
      (await recordAdviceTool.execute({ contextId: claim.context.id, result, provenance }, ctx)).ok,
    ).toBe(false);
    const metrics = await getAnalysisMetricsTool.execute({}, ctx);
    expect(metrics.ok && metrics.data.completed).toBe(1);
  });

  it('rejects expired writes while retaining the audit snapshot', async () => {
    const ctx = await setup();
    const snapshot = await getAnalysisContextTool.execute(
      { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' } },
      ctx,
    );
    if (!snapshot.ok) throw new Error('snapshot failed');
    const later = { ...ctx, clock: () => new Date(now.getTime() + 31 * 60000) };
    expect(
      await recordAdviceTool.execute({ contextId: snapshot.data.id, result, provenance }, later),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input', message: 'context_expired' } });
    expect((await getAnalysisContextTool.execute({ contextId: snapshot.data.id }, later)).ok).toBe(
      true,
    );
  });
});
