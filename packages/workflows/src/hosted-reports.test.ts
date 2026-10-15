import { createHash } from 'node:crypto';
import type { Report, ToolContext } from '@luoome/core';
import { getAccountFactsTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentStrategyFingerprint } from './account-plan-batch.js';
import { buildWorkflowTools } from './define-workflow.js';
import { hostedReportsWorkflow } from './hosted-reports.js';
import { openingReportWorkflow } from './opening-report.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const setup = async (configured = true) => {
  let now = new Date('2026-10-15T00:49:00Z');
  const base = await buildTestContext({ clock: () => now });
  let authorized = true;
  const ctx: ToolContext = {
    ...base,
    identity: {
      mode: 'hosted',
      actor: 'worker',
      tenantId: 'tenant-A',
      tenantGeneration: 1,
      userId: base.user.id,
      requestId: 'fixture',
    },
    hostedAuthorization: async () =>
      authorized
        ? null
        : { ok: false, error: { kind: 'permission_denied', required: 'entitlement:expired' } },
  };
  if (configured) {
    const settings = await ctx.repos.watchDelivery.settings();
    await ctx.repos.watchDelivery.saveSettings({
      ...settings,
      expectedRevision: settings.revision,
      webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/report-fixture',
      now,
    });
  }
  const http = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => Response.json({ StatusCode: 0 }));
  const llm = vi.spyOn(ctx.adapters.llm, 'generate');
  return {
    ctx,
    http,
    llm,
    run: () => hostedReportsWorkflow.run({}, ctx),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    at: (value: string) => {
      now = new Date(value);
    },
    expire: () => {
      authorized = false;
    },
  };
};
const body = ({ deliveryStatus: _delivery, updatedAt: _updated, ...facts }: Report) => facts;
const markPlanBatch = async (
  ctx: ToolContext,
  status: 'running' | 'failed' | 'complete' | 'partial',
) => {
  const facts = await getAccountFactsTool.execute({ accountId: ctx.user.defaultAccountId }, ctx);
  if (!facts.ok) throw new Error('fixture facts missing');
  const fingerprint = await currentStrategyFingerprint('2026-10-15', {
    ...ctx,
    tools: buildWorkflowTools(ctx),
  });
  const digest = createHash('sha256')
    .update(`${fingerprint}:${facts.data.facts.digest}`)
    .digest('hex')
    .slice(0, 16);
  await ctx.repos.workflowRun.save({
    id: `account-plan-batch:2026-10-15:${ctx.user.defaultAccountId}:${digest}`,
    workflowName: 'account-plan-batch',
    mode: 'scheduled',
    status:
      status === 'running'
        ? 'running'
        : status === 'failed'
          ? 'failed'
          : status === 'partial'
            ? 'partial'
            : 'succeeded',
    startedAt: ctx.clock(),
    ...(status === 'running' ? {} : { finishedAt: ctx.clock() }),
    ...(status === 'failed' ? { error: 'fixture failed' } : {}),
    inputSummary: {},
    outputSummary: { status },
    providerStatuses: [],
  });
};

describe('hosted report workflow', () => {
  it('manual hosted generation leaves notification to the same worker delivery intent', async () => {
    const h = await setup();
    h.advance(60_000);
    const manual = await openingReportWorkflow.run(
      {
        mode: 'manual',
        notify: true,
        scope: { kind: 'account', accountId: h.ctx.user.defaultAccountId },
      },
      h.ctx,
    );
    expect(manual.ok).toBe(true);
    expect(h.http).not.toHaveBeenCalled();
    const first = (await h.ctx.repos.report.list({}))[0] as Report;
    expect(await h.run()).toMatchObject({ ok: true, data: { created: [], accepted: [first.id] } });
    expect(h.http).toHaveBeenCalledTimes(1);
    expect(body((await h.ctx.repos.report.findById(first.id)) as Report)).toEqual(body(first));
  });
  it('starts at 08:50, generates once under concurrency and reuses immutable facts after restart', async () => {
    const h = await setup();
    expect(await h.run()).toMatchObject({ ok: true, data: { created: [] } });
    h.advance(60_000);
    const results = await Promise.all([h.run(), h.run()]);
    expect(results.filter((result) => result.ok && result.data.acquired)).toHaveLength(1);
    const reports = await h.ctx.repos.report.list({});
    expect(reports).toHaveLength(1);
    const first = reports[0] as Report;
    expect(first.kind).toBe('opening');
    expect(first.sections.length).toBeGreaterThan(0);
    expect(first.missingDimensions.length).toBeGreaterThan(0);
    expect((await h.ctx.repos.reportAutomation.list())[0]).toMatchObject({
      tenantId: 'tenant-A',
      state: 'accepted',
      deliveredAt: null,
      providerMessageId: null,
    });
    h.advance(60_000);
    await h.run();
    expect(body((await h.ctx.repos.report.findById(first.id)) as Report)).toEqual(body(first));
    expect(h.http).toHaveBeenCalledTimes(1);
    expect(h.llm).not.toHaveBeenCalled();
  });
  it('waits beyond 18:00 for account batches; completion publishes one closing report and late facts do not revise it', async () => {
    const h = await setup(false);
    h.at('2026-10-15T10:01:00Z');
    expect(await h.run()).toMatchObject({ ok: true, data: { waiting: ['closing'] } });
    expect(await h.ctx.repos.report.list({ kind: 'closing' })).toHaveLength(0);
    for (const status of ['running', 'failed'] as const) {
      h.advance(60_000);
      await markPlanBatch(h.ctx, status);
      expect(await h.run()).toMatchObject({ ok: true, data: { waiting: ['closing'] } });
      expect(await h.ctx.repos.report.list({ kind: 'closing' })).toHaveLength(0);
    }
    h.advance(60_000);
    await markPlanBatch(h.ctx, 'complete');
    expect(await h.run()).toMatchObject({ ok: true, data: { waiting: [] } });
    const first = (await h.ctx.repos.report.list({ kind: 'closing' }))[0] as Report;
    expect(first).toBeDefined();
    h.advance(60_000);
    await markPlanBatch(h.ctx, 'partial');
    await h.run();
    expect(await h.ctx.repos.report.list({ kind: 'closing' })).toHaveLength(1);
    expect(body((await h.ctx.repos.report.findById(first.id)) as Report)).toEqual(body(first));
    expect(h.llm).not.toHaveBeenCalled();
  });
  it('bounds confirmed rejection retries to three attempts with one/five minute backoff using the original report', async () => {
    const h = await setup();
    h.advance(60_000);
    h.http.mockImplementation(async () => new Response('rejected', { status: 503 }));
    await h.run();
    const original = (await h.ctx.repos.report.list({}))[0] as Report;
    h.advance(59_999);
    await h.run();
    expect(h.http).toHaveBeenCalledTimes(1);
    h.advance(1);
    await h.run();
    expect(h.http).toHaveBeenCalledTimes(2);
    h.advance(299_999);
    await h.run();
    expect(h.http).toHaveBeenCalledTimes(2);
    h.advance(1);
    await h.run();
    expect(h.http).toHaveBeenCalledTimes(3);
    h.advance(300_000);
    await h.run();
    expect(h.http).toHaveBeenCalledTimes(3);
    expect(body((await h.ctx.repos.report.findById(original.id)) as Report)).toEqual(
      body(original),
    );
    expect((await h.ctx.repos.reportAutomation.list())[0]?.attempt).toBe(3);
  });
  it.each(['missing', 'unknown'] as const)(
    '%s channel outcomes never automatically retry',
    async (outcome) => {
      const h = await setup(outcome !== 'missing');
      h.advance(60_000);
      if (outcome === 'unknown') h.http.mockRejectedValue(new TypeError('connection interrupted'));
      await h.run();
      h.advance(600_000);
      await h.run();
      expect(h.http).toHaveBeenCalledTimes(outcome === 'unknown' ? 1 : 0);
      expect((await h.ctx.repos.reportAutomation.list())[0]).toMatchObject(
        outcome === 'unknown'
          ? { state: 'unknown' }
          : { state: 'suppressed', errorKind: 'fallback-log' },
      );
    },
  );
  it('rechecks entitlement during generation and does not commit or send after expiry', async () => {
    const h = await setup();
    h.advance(60_000);
    h.ctx.adapters.market.batchQuote = async () => {
      h.expire();
      return new Map();
    };
    expect((await h.run()).ok).toBe(false);
    expect(await h.ctx.repos.report.list({})).toEqual([]);
    expect(h.http).not.toHaveBeenCalled();
  });
  it('keeps a generation lease alive with heartbeats during slow upstream IO', async () => {
    const h = await setup();
    h.advance(60_000);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const batch = h.ctx.adapters.market.batchQuote.bind(h.ctx.adapters.market);
    h.ctx.adapters.market.batchQuote = async (ids) => {
      for (let tick = 0; tick < 5; tick += 1) {
        h.advance(30_000);
        await vi.advanceTimersByTimeAsync(30_000);
      }
      expect(
        await h.ctx.repos.reportAutomation.execution('acquire', 'other-worker', h.ctx.clock()),
      ).toBe(false);
      return batch(ids);
    };
    expect((await h.run()).ok).toBe(true);
    expect(h.http).toHaveBeenCalledTimes(1);
  });
  it('an expired owner cannot publish after a successor takes over', async () => {
    const h = await setup();
    h.advance(60_000);
    const batch = h.ctx.adapters.market.batchQuote.bind(h.ctx.adapters.market);
    h.ctx.adapters.market.batchQuote = async (ids) => {
      const quotes = await batch(ids);
      h.advance(121_000);
      expect(
        await h.ctx.repos.reportAutomation.execution('acquire', 'successor', h.ctx.clock()),
      ).toBe(true);
      return quotes;
    };
    expect((await h.run()).ok).toBe(false);
    expect(await h.ctx.repos.report.list({})).toEqual([]);
    expect(h.http).not.toHaveBeenCalled();
  });
});
