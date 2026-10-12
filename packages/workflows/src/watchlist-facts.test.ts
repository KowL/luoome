import { createHash } from 'node:crypto';
import {
  AlertPlanSchema,
  stockCode,
  type ToolContext,
  WatchlistSchema,
  WatchTriggerSchema,
} from '@luoome/core';
import {
  commitWatchlistImportTool,
  prepareWatchlistFactsRequestTool,
  previewWatchlistImportTool,
  renderReportTool,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { watchlistFactsWorkflow } from './watchlist-facts.js';

const now = new Date('2026-10-10T04:00:00Z');
const tenantHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fixture = async (timestampSource: 'upstream' | 'retrieval' = 'upstream') => {
  const base = await buildTestContext({
    clock: () => now,
    marketTimestampSource: timestampSource,
    advices: [],
  });
  const ctx: ToolContext = { ...base, user: { id: 'owner', defaultAccountId: '' } };
  const { repos } = ctx;
  const { market, llm } = ctx.adapters;
  for (const account of await repos.account.list()) await repos.account.remove(account.id);
  await repos.stock.save({
    id: '600519.SH',
    code: stockCode('600519'),
    exchange: 'SH',
    name: '贵州茅台',
  });
  await repos.watchlist.save(
    WatchlistSchema.parse({
      id: 'personal',
      name: '我的自选',
      kind: 'personal',
      membershipPolicy: 'mixed',
      enabled: true,
      createdAt: new Date(now.getTime() - 60_000),
      updatedAt: new Date(now.getTime() - 60_000),
    }),
  );
  const preview = await previewWatchlistImportTool.execute(
    { watchlistId: 'personal', format: 'text', content: '600519' },
    ctx,
  );
  if (!preview.ok) throw new Error('preview failed');
  const committed = await commitWatchlistImportTool.execute(
    {
      previewId: preview.data.preview.id,
      inputHash: preview.data.preview.inputHash,
      requestId: 'import',
      selections: [{ row: 1, stockId: '600519.SH' }],
      excludedRows: [],
      maxDistinctStocks: 50,
    },
    ctx,
  );
  if (!committed.ok) throw new Error('import failed');
  return { ctx, market, llm };
};
const executeInput = async (
  ctx: ToolContext,
  operationId = 'facts-one',
  notificationPolicy: 'eligible' | 'never' = 'never',
) => {
  const prepared = await prepareWatchlistFactsRequestTool.execute(
    { watchlistId: 'personal', period: '2026-10-10', notificationPolicy },
    ctx,
  );
  if (!prepared.ok || ctx.repos.hostedTenant === undefined) throw new Error('prepare failed');
  const inputHash = tenantHash(prepared.data.input);
  await ctx.repos.hostedTenant.putExecutionRequest({
    operationId,
    inputHash,
    generation: 1,
    kind: 'watchlist-facts',
    input: prepared.data.input,
    createdAt: now,
  });
  const claimed = await ctx.repos.hostedTenant.claimExecution({
    operationId,
    generation: 1,
    attemptId: `${operationId}-attempt`,
    now,
    leaseMs: 120_000,
  });
  if (claimed.kind !== 'claimed') throw new Error('lease failed');
  return {
    operationId,
    inputHash,
    generation: 1,
    fence: claimed.lease.fence,
    attemptId: claimed.lease.attemptId,
  };
};

describe('watchlist-facts workflow', () => {
  it('persists deterministic account-free facts with truthful data time and recovers a receipt without another provider call', async () => {
    const { ctx, market, llm } = await fixture();
    const provider = vi.spyOn(market, 'batchQuote');
    const model = vi.spyOn(llm, 'generate');
    const input = await executeInput(ctx, 'facts-one', 'eligible');
    const first = await watchlistFactsWorkflow.run(input, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const report = first.data.report;
    expect(report.kind).toBe('watchlist-facts');
    expect(report.scope).toEqual({ kind: 'watchlist', watchlistId: 'personal' });
    expect(report.status).toBe('partial');
    expect(report.dataAsOf).toEqual(new Date(now.getTime() - 1000));
    expect(report.missingDimensions.map((gap) => gap.errorKind)).toContain('not-configured');
    expect(await ctx.repos.account.list()).toHaveLength(0);
    expect(model).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(1);
    const replayed = await watchlistFactsWorkflow.run(input, ctx);
    expect(replayed).toMatchObject({
      ok: true,
      data: { receipt: first.data.receipt, replayed: true },
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await ctx.repos.hostedTenant?.listOutbox()).toHaveLength(1);
    const rendered = await renderReportTool.execute(
      { reportId: report.id, format: 'markdown' },
      ctx,
    );
    expect(rendered.ok).toBe(true);
    if (rendered.ok) {
      expect(rendered.data.content).toContain('贵州茅台');
      expect(rendered.data.content).toContain('来源未配置');
    }
  });
  it('does not present retrieval time as a market fact timestamp', async () => {
    const { ctx } = await fixture('retrieval');
    const result = await watchlistFactsWorkflow.run(await executeInput(ctx), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.data.report.dataAsOf).toEqual(new Date(now.getTime() - 60_000));
    expect(result.data.report.evidence[0]?.provenance.freshness).toBe('unknown');
    const market = result.data.report.sections.find((section) => section.key === 'market');
    const table = market?.blocks[0];
    expect(table?.kind).toBe('table');
    if (table?.kind === 'table') expect(table.rows[0]?.dataAsOf).toBeNull();
    expect(market?.missingDimensions.some((gap) => gap.errorKind === 'unknown')).toBe(true);
  });
  it('keeps the saved watchlist and explicitly reports missing provider data', async () => {
    const { ctx, market } = await fixture();
    vi.spyOn(market, 'batchQuote').mockRejectedValue(new Error('provider unavailable'));
    const result = await watchlistFactsWorkflow.run(await executeInput(ctx), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.data.report.sections.find((section) => section.key === 'market')?.status).toBe(
      'unavailable',
    );
    expect((await ctx.repos.watchlistMember.listMembers('personal'))[0]?.stockId).toBe('600519.SH');
    expect(result.data.receipt.status).toBe('partial');
  });
  it('reads only price watch triggers belonging to the frozen alert plans', async () => {
    const { ctx } = await fixture();
    const plan = AlertPlanSchema.parse({
      id: 'price-plan',
      name: '我设置的价格条件',
      watchlistId: 'personal',
      rules: [{ id: 'price-rule', kind: 'price-level', level: 100, side: 'above' }],
      logic: 'ANY',
      triggerMode: 'on-enter',
      cooldownMinutes: 30,
      dailyNotificationLimit: 3,
      notifyOnRecovery: false,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.repos.alertPlan.save(plan);
    const trigger = WatchTriggerSchema.parse({
      id: 'selected-trigger',
      poolId: plan.id,
      alertPlanId: plan.id,
      stockId: '600519.SH',
      ruleKind: 'price-level',
      ruleId: 'price-rule',
      direction: 'watch',
      reason: '价格达到用户条件',
      evidence: ['价格 >= 100 元'],
      priority: 'normal',
      deliveryStatus: 'not-requested',
      evalSnapshot: { threshold: 100 },
      notified: false,
      createdAt: now,
    });
    await ctx.repos.watchTrigger.save(trigger);
    await ctx.repos.watchTrigger.save({
      ...trigger,
      id: 'wrong-watchlist-key',
      poolId: 'personal',
    });
    await ctx.repos.watchTrigger.save({ ...trigger, id: 'legacy-buy-action', direction: 'buy' });
    const result = await watchlistFactsWorkflow.run(await executeInput(ctx), ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const items = result.data.report.sections
      .find((section) => section.key === 'rules')
      ?.blocks.flatMap((block) => (block.kind === 'list' ? block.items : []));
    expect(
      items?.filter((item) => item.entityKind === 'watch-trigger').map((item) => item.entityId),
    ).toEqual(['selected-trigger']);
  });
  it('reuses identical fact inputs across operations and suppresses manual notification intent', async () => {
    const { ctx } = await fixture();
    const first = await watchlistFactsWorkflow.run(
      await executeInput(ctx, 'daily', 'eligible'),
      ctx,
    );
    const viewed = await watchlistFactsWorkflow.run(
      await executeInput(ctx, 'manual', 'never'),
      ctx,
    );
    expect(first.ok && viewed.ok).toBe(true);
    if (!first.ok || !viewed.ok) return;
    expect(viewed.data.report.id).toBe(first.data.report.id);
    expect(viewed.data.replayed).toBe(true);
    expect(
      (await ctx.repos.hostedTenant?.listOutbox())?.find((event) => event.operationId === 'manual')
        ?.notificationPolicy,
    ).toBe('never');
    expect(await ctx.repos.report.list({ kind: 'watchlist-facts' })).toHaveLength(1);
  });
  it('rejects a queued stale snapshot before provider work', async () => {
    const { ctx, market } = await fixture();
    const input = await executeInput(ctx);
    const provider = vi.spyOn(market, 'batchQuote');
    const watchlist = await ctx.repos.watchlist.findById('personal');
    if (watchlist === null) throw new Error('watchlist missing');
    await ctx.repos.watchlist.save({
      ...watchlist,
      name: '后来更改',
      updatedAt: new Date(now.getTime() + 1000),
    });
    expect(await watchlistFactsWorkflow.run(input, ctx)).toMatchObject({
      ok: false,
      error: { kind: 'invalid_input' },
    });
    expect(provider).not.toHaveBeenCalled();
    expect(await ctx.repos.hostedTenant?.getReceipt(input.operationId)).toBeNull();
  });
});
