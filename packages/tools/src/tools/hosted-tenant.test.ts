import { FakeLLMAdapter, FakeMarketAdapter } from '@luoome/adapters/testing';
import {
  money,
  PersonalAlertPlanConfigSchema,
  stockCode,
  type ToolContext,
  WatchlistSchema,
  WatchTriggerSchema,
} from '@luoome/core';
import { createInMemoryRepos } from '@luoome/db/memory';
import { describe, expect, it, vi } from 'vitest';
import { toolRegistry } from '../registry.js';
import {
  buildPersonalAlertEvaluationTool,
  buildWatchlistFactsTool,
  commitPersonalAlertEvaluationTool,
  commitWatchlistFactsTool,
  commitWatchlistImportTool,
  hostedTenantTools,
  listPersonalAlertPlansTool,
  listPersonalWatchFeedbackTool,
  preparePersonalAlertRequestTool,
  previewPersonalAlertPlanTool,
  previewWatchlistImportTool,
  recordPersonalWatchFeedbackTool,
  removePersonalAlertPlanTool,
  removePersonalWatchlistMembersTool,
  savePersonalAlertPlanTool,
} from './hosted-tenant.js';

const now = new Date('2026-10-10T04:00:00Z');
const fixture = async (): Promise<ToolContext> => {
  const repos = createInMemoryRepos();
  await repos.stock.save({
    id: '600519.SH',
    code: stockCode('600519'),
    exchange: 'SH',
    name: '贵州茅台',
  });
  await repos.stock.save({
    id: '000001.SZ',
    code: stockCode('000001'),
    exchange: 'SZ',
    name: '平安银行',
  });
  await repos.watchlist.save(
    WatchlistSchema.parse({
      id: 'personal',
      name: '自选',
      kind: 'personal',
      membershipPolicy: 'mixed',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }),
  );
  return {
    repos,
    adapters: { market: new FakeMarketAdapter({ clock: () => now }), llm: new FakeLLMAdapter() },
    user: { id: 'user-one', defaultAccountId: '' },
    clock: () => now,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
};
describe('hosted tenant tools', () => {
  it('loads all hosted bindings while keeping them outside the general registry', () => {
    const names = toolRegistry.all().map((tool) => tool.name);
    for (const tool of [...hostedTenantTools, buildWatchlistFactsTool, commitWatchlistFactsTool])
      expect(names).not.toContain(tool.name);
    expect(buildWatchlistFactsTool.requiredCapabilities).toEqual(['external', 'write']);
  });
  it('previews canonical identities, duplicates, unknowns, and ambiguous exact names', async () => {
    const ctx = await fixture();
    await ctx.repos.stock.save({
      id: '600001.SH',
      code: stockCode('600001'),
      exchange: 'SH',
      name: '平安银行',
    });
    const result = await previewWatchlistImportTool.execute(
      { watchlistId: 'personal', format: 'text', content: 'SH600519\n600519.SH\n平安银行\n未知' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.preview.rows.map((row) => row.status)).toEqual([
      'ready',
      'duplicate',
      'ambiguous',
      'unknown',
    ]);
    const input = {
      previewId: result.data.preview.id,
      inputHash: result.data.preview.inputHash,
      requestId: 'one',
      selections: [
        { row: 1, stockId: '600519.SH' },
        { row: 3, stockId: '000001.SZ' },
      ],
      excludedRows: [2, 4],
      maxDistinctStocks: 50,
    };
    const committed = await commitWatchlistImportTool.execute(input, ctx);
    expect(committed.ok).toBe(true);
    expect(await ctx.repos.account.list()).toHaveLength(0);
    expect(await ctx.repos.holding.listByAccount('')).toHaveLength(0);
    expect(
      await commitWatchlistImportTool.execute({ ...input, excludedRows: [2] }, ctx),
    ).toMatchObject({ ok: false });
  });
  it('requires explicit CSV extra-column acknowledgement without writing portfolio facts', async () => {
    const ctx = await fixture();
    const result = await previewWatchlistImportTool.execute(
      {
        watchlistId: 'personal',
        format: 'csv',
        content: '股票代码,数量,成本\n"600519",100,1000\n000001,200,10',
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.preview.ignoredColumns).toEqual(['数量', '成本']);
    const input = {
      previewId: result.data.preview.id,
      inputHash: result.data.preview.inputHash,
      requestId: 'csv-one',
      selections: [
        { row: 1, stockId: '600519.SH' },
        { row: 2, stockId: '000001.SZ' },
      ],
      excludedRows: [],
      maxDistinctStocks: 50,
    };
    expect(await commitWatchlistImportTool.execute(input, ctx)).toMatchObject({ ok: false });
    expect(await ctx.repos.watchlistMember.listMembers('personal')).toHaveLength(0);
    expect(
      await commitWatchlistImportTool.execute({ ...input, acknowledgeExtraColumns: true }, ctx),
    ).toMatchObject({ ok: true });
    expect(await ctx.repos.account.list()).toHaveLength(0);
    expect(await ctx.repos.holding.listByAccount('')).toHaveLength(0);
  });
  it('rejects the entire oversized input and prevents preview reuse by another owner', async () => {
    const ctx = await fixture();
    for (const content of ['600519\n'.repeat(101), '股'.repeat(350_000)])
      expect(
        await previewWatchlistImportTool.execute(
          { watchlistId: 'personal', format: 'text', content },
          ctx,
        ),
      ).toMatchObject({ ok: false });
    const result = await previewWatchlistImportTool.execute(
      { watchlistId: 'personal', format: 'text', content: '600519' },
      ctx,
    );
    if (!result.ok) throw new Error('preview missing');
    expect(
      await commitWatchlistImportTool.execute(
        {
          previewId: result.data.preview.id,
          inputHash: result.data.preview.inputHash,
          requestId: 'foreign',
          selections: [{ row: 1, stockId: '600519.SH' }],
          excludedRows: [],
          maxDistinctStocks: 50,
        },
        { ...ctx, user: { id: 'another-user', defaultAccountId: '' } },
      ),
    ).toMatchObject({ ok: false });
    expect(await ctx.repos.watchlistMember.listMembers('personal')).toHaveLength(0);
  });
  it('removes with request receipts and supports owner import reactivation', async () => {
    const ctx = await fixture();
    const result = await previewWatchlistImportTool.execute(
      { watchlistId: 'personal', format: 'text', content: '600519' },
      ctx,
    );
    if (!result.ok) throw new Error('preview missing');
    await commitWatchlistImportTool.execute(
      {
        previewId: result.data.preview.id,
        inputHash: result.data.preview.inputHash,
        requestId: 'one',
        selections: [{ row: 1, stockId: '600519.SH' }],
        excludedRows: [],
        maxDistinctStocks: 50,
      },
      ctx,
    );
    const input = { watchlistId: 'personal', stockIds: ['600519.SH'], requestId: 'remove-one' };
    const removed = await removePersonalWatchlistMembersTool.execute(input, ctx);
    expect(removed).toMatchObject({
      ok: true,
      data: { results: [{ stockId: '600519.SH', archived: true }] },
    });
    expect(await removePersonalWatchlistMembersTool.execute(input, ctx)).toEqual(removed);
    expect(
      await removePersonalWatchlistMembersTool.execute({ ...input, stockIds: ['000001.SZ'] }, ctx),
    ).toMatchObject({ ok: false });
  });
  it('writes account-free feedback without legacy account actions or private snapshot fields', async () => {
    const ctx = await fixture();
    const base = WatchTriggerSchema.parse({
      id: 'price-trigger',
      poolId: 'price-plan',
      stockId: '600519.SH',
      ruleKind: 'price-level',
      ruleId: 'price-rule',
      direction: 'watch',
      reason: '用户条件',
      evidence: ['价格达到 100 元'],
      priority: 'normal',
      deliveryStatus: 'sent',
      notificationId: 'private-channel',
      notified: true,
      evalSnapshot: { threshold: 100, accountId: 'private-account', positionAmount: 10000 },
      createdAt: now,
    });
    await ctx.repos.watchTrigger.save(base);
    const input = {
      triggerId: base.id,
      expectedRevision: 0,
      rating: 'useful',
      note: '已核对',
      requestId: 'feedback-one',
    };
    const first = await recordPersonalWatchFeedbackTool.execute(input, ctx);
    expect(first).toMatchObject({
      ok: true,
      data: { feedback: { revision: 1, triggerSnapshot: { evalSnapshot: { threshold: 100 } } } },
    });
    if (!first.ok) return;
    expect(first.data.feedback.triggerSnapshot).not.toHaveProperty('notificationId');
    expect(await recordPersonalWatchFeedbackTool.execute(input, ctx)).toEqual(first);
    expect(
      await recordPersonalWatchFeedbackTool.execute(
        { ...input, expectedRevision: 1, rating: 'handled', requestId: 'two' },
        ctx,
      ),
    ).toMatchObject({ ok: true, data: { feedback: { revision: 2 } } });
    expect(await listPersonalWatchFeedbackTool.execute({ triggerId: base.id }, ctx)).toMatchObject({
      ok: true,
    });
    await ctx.repos.watchTrigger.save({ ...base, id: 'legacy-buy', direction: 'buy' });
    expect(
      await recordPersonalWatchFeedbackTool.execute(
        { ...input, triggerId: 'legacy-buy', requestId: 'forbidden' },
        ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    expect((await ctx.repos.watchTrigger.findById(base.id))?.feedback).toBeUndefined();
  });
});

const alertNow = new Date('2026-10-12T02:00:00Z');
const alertFixture = async () => {
  const base = await fixture();
  const market = new FakeMarketAdapter({ clock: () => alertNow, timestampSource: 'upstream' });
  const ctx: ToolContext = {
    ...base,
    clock: () => alertNow,
    adapters: { ...base.adapters, market },
  };
  const preview = await previewWatchlistImportTool.execute(
    { watchlistId: 'personal', format: 'text', content: '600519' },
    ctx,
  );
  if (!preview.ok) throw new Error('import preview failed');
  const committed = await commitWatchlistImportTool.execute(
    {
      previewId: preview.data.preview.id,
      inputHash: preview.data.preview.inputHash,
      requestId: 'members',
      selections: [{ row: 1, stockId: '600519.SH' }],
      excludedRows: [],
      maxDistinctStocks: 50,
    },
    ctx,
  );
  if (!committed.ok) throw new Error('import failed');
  const plan = PersonalAlertPlanConfigSchema.parse({
    id: 'price-plan',
    name: '用户价格',
    watchlistId: 'personal',
    rules: [{ id: 'above', kind: 'price-level', level: 100, side: 'above' }],
    logic: 'ANY',
    triggerMode: 'on-enter',
    cooldownMinutes: 10,
    dailyNotificationLimit: 5,
    notifyOnRecovery: true,
    enabled: false,
  });
  return { ctx, market, plan };
};

describe('personal price alert tools', () => {
  it('denies direct user execution of all formal worker tools even if composition authorizes the name', async () => {
    const { ctx } = await alertFixture();
    const userCtx: ToolContext = {
      ...ctx,
      identity: {
        mode: 'hosted',
        actor: 'user',
        userId: ctx.user.id,
        tenantId: 'tenant-one',
        tenantGeneration: 1,
        requestId: 'request-one',
      },
      hostedAuthorization: async () => null,
    };
    const denied = { ok: false, error: { kind: 'permission_denied', required: 'actor:worker' } };
    const metadata = {
      operationId: 'formal',
      inputHash: 'a'.repeat(64),
      generation: 1,
      fence: 1,
      attemptId: 'attempt-one',
    };
    const provider = vi.spyOn(ctx.adapters.market, 'batchQuote');
    expect(
      await preparePersonalAlertRequestTool.execute(
        { watchlistId: 'personal', period: '2026-10-12', maxDailyNotifications: 10 },
        userCtx,
      ),
    ).toEqual(denied);
    expect(await buildPersonalAlertEvaluationTool.execute(metadata, userCtx)).toEqual(denied);
    expect(await commitPersonalAlertEvaluationTool.execute(metadata, userCtx)).toEqual(denied);
    expect(provider).not.toHaveBeenCalled();
    expect(await ctx.repos.hostedTenant?.getReceipt('formal')).toBeNull();
  });
  it('keeps formal bindings outside user and general tool inventories', () => {
    const general = toolRegistry.all().map((tool) => tool.name);
    const user = hostedTenantTools.map((tool) => tool.name);
    for (const tool of [buildPersonalAlertEvaluationTool, commitPersonalAlertEvaluationTool]) {
      expect(general).not.toContain(tool.name);
      expect(user).not.toContain(tool.name);
    }
    expect(previewPersonalAlertPlanTool.requiredCapabilities).toEqual(['external']);
    expect(buildPersonalAlertEvaluationTool.requiredCapabilities).toEqual(['external', 'write']);
  });
  it('previews current hits with zero persistent writes, leases, cache saves or model calls', async () => {
    const { ctx, market, plan } = await alertFixture();
    const tenant = ctx.repos.hostedTenant;
    if (tenant === undefined) throw new Error('tenant missing');
    const writes = [
      vi.spyOn(ctx.repos.quote, 'save'),
      vi.spyOn(ctx.repos.dailyBar, 'saveMany'),
      vi.spyOn(ctx.repos.alertPlan, 'save'),
      vi.spyOn(ctx.repos.watchRuleState, 'upsertMany'),
      vi.spyOn(ctx.repos.watchTrigger, 'save'),
      vi.spyOn(ctx.repos.watchTrigger, 'commitEvaluation'),
      vi.spyOn(ctx.repos.watchTrigger, 'acquireExecution'),
      vi.spyOn(ctx.repos.watchTrigger, 'renewExecution'),
      vi.spyOn(ctx.repos.workflowRun, 'save'),
      vi.spyOn(ctx.repos.workflowRun, 'claim'),
      vi.spyOn(tenant, 'putExecutionRequest'),
      vi.spyOn(tenant, 'claimExecution'),
      vi.spyOn(tenant, 'renewExecution'),
      vi.spyOn(tenant, 'commitPersonalAlertEvaluation'),
      vi.spyOn(tenant, 'savePersonalAlertPlan'),
      vi.spyOn(tenant, 'ackOutbox'),
      vi.spyOn(ctx.adapters.llm, 'generate'),
    ];
    const provider = vi.spyOn(market, 'batchQuote');
    const first = await previewPersonalAlertPlanTool.execute({ plan }, ctx);
    const second = await previewPersonalAlertPlanTool.execute({ plan }, ctx);
    expect(first).toMatchObject({
      ok: true,
      data: {
        evaluation: {
          mode: 'preview',
          notificationPolicy: 'never',
          status: 'complete',
          conditions: [{ known: true, active: true }],
          triggers: [{ direction: 'watch', deliveryStatus: 'not-requested' }],
        },
      },
    });
    expect(second).toEqual(first);
    expect(provider).toHaveBeenCalledTimes(2);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(await ctx.repos.quote.latestByStock('600519.SH')).toBeNull();
    expect(await ctx.repos.watchTrigger.listByPool(plan.id)).toHaveLength(0);
    expect(await ctx.repos.watchRuleState.listByPool(plan.id)).toHaveLength(0);
    expect(await tenant.listOutbox()).toHaveLength(0);
    expect(await tenant.getReceipt('preview')).toBeNull();
    expect(await ctx.repos.account.list()).toHaveLength(0);
  });
  it('rejects all nonprice, repeat, duplicate identities and invalid thresholds before provider work', async () => {
    const { ctx, market, plan } = await alertFixture();
    const provider = vi.spyOn(market, 'batchQuote');
    for (const rules of [
      [{ id: 'bad', kind: 'strategy-signal', strategyId: 'private', minScore: 60 }],
      [{ id: 'bad', kind: 'cost-threshold', stopLossPct: 0.1 }],
      [{ id: 'bad', kind: 'event-date' }],
      [{ id: 'bad', kind: 'price-level', level: 0, side: 'above' }],
      [{ id: 'bad', kind: 'price-change', pct: -0.1 }],
      [plan.rules[0], plan.rules[0]],
    ])
      expect(
        await previewPersonalAlertPlanTool.execute({ plan: { ...plan, rules } }, ctx),
      ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(
      await previewPersonalAlertPlanTool.execute({ plan: { ...plan, triggerMode: 'repeat' } }, ctx),
    ).toMatchObject({ ok: false });
    expect(provider).not.toHaveBeenCalled();
  });
  it('shows unknown coverage for missing previous close, retrieval time and unavailable suppliers', async () => {
    const { ctx, market, plan } = await alertFixture();
    const changePlan = {
      ...plan,
      rules: [{ id: 'change', kind: 'price-change' as const, pct: 0.03, direction: 'up' as const }],
    };
    const original = await market.fetchQuote('600519.SH');
    const { prevClose: _prevClose, ...withoutPrevious } = original;
    vi.spyOn(market, 'batchQuote')
      .mockResolvedValueOnce(new Map([['600519.SH', { ...withoutPrevious, close: money(2000) }]]))
      .mockResolvedValueOnce(
        new Map([
          [
            '600519.SH',
            { ...original, observedAt: alertNow, ts: alertNow, timestampSource: 'retrieval' },
          ],
        ]),
      )
      .mockRejectedValueOnce(new Error('private provider token must not leak'));
    expect(await previewPersonalAlertPlanTool.execute({ plan: changePlan }, ctx)).toMatchObject({
      ok: true,
      data: { evaluation: { status: 'partial', conditions: [{ known: false }], triggers: [] } },
    });
    expect(await previewPersonalAlertPlanTool.execute({ plan }, ctx)).toMatchObject({
      ok: true,
      data: { evaluation: { status: 'partial', triggers: [] } },
    });
    const unavailable = await previewPersonalAlertPlanTool.execute({ plan }, ctx);
    expect(unavailable).toMatchObject({
      ok: true,
      data: { evaluation: { status: 'partial', triggers: [] } },
    });
    expect(JSON.stringify(unavailable)).not.toContain('token');
    expect(await ctx.repos.hostedTenant?.listOutbox()).toHaveLength(0);
  });
  it('does not fetch or claim A-share rule coverage for Hong Kong or US identities', async () => {
    const { ctx, market, plan } = await alertFixture();
    await ctx.repos.stock.save({
      id: '00700.HK',
      code: stockCode('00700'),
      exchange: 'HK',
      name: '香港样本',
    });
    await ctx.repos.stock.save({
      id: 'MSFT.US',
      code: stockCode('MSFT'),
      exchange: 'US',
      name: '美国样本',
    });
    const preview = await previewWatchlistImportTool.execute(
      { watchlistId: 'personal', content: '00700.HK\nMSFT.US', format: 'text' },
      ctx,
    );
    if (!preview.ok) throw new Error('preview failed');
    const committed = await commitWatchlistImportTool.execute(
      {
        previewId: preview.data.preview.id,
        inputHash: preview.data.preview.inputHash,
        requestId: 'other-markets',
        selections: [
          { row: 1, stockId: '00700.HK' },
          { row: 2, stockId: 'MSFT.US' },
        ],
        excludedRows: [],
        maxDistinctStocks: 50,
      },
      ctx,
    );
    if (!committed.ok) throw new Error('import failed');
    const provider = vi.spyOn(market, 'batchQuote');
    const result = await previewPersonalAlertPlanTool.execute({ plan }, ctx);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(provider).toHaveBeenCalledWith(['600519.SH']);
    expect(
      result.data.evaluation.conditions.filter((condition) => condition.stockId !== '600519.SH'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stockId: '00700.HK', known: false }),
        expect.objectContaining({ stockId: 'MSFT.US', known: false }),
      ]),
    );
    expect(
      result.data.evaluation.triggers.every((trigger) => trigger.stockId === '600519.SH'),
    ).toBe(true);
  });
  it('requires confirmation, checks quotas, freezes enabled rules and preserves delete history', async () => {
    const { ctx, plan } = await alertFixture();
    const input = {
      plan: { ...plan, enabled: true },
      expectedPlanRevision: null,
      requestId: 'enable',
      maxEnabledRules: 1,
      maxDailyNotifications: 10,
      minCooldownMinutes: 1,
    };
    expect(await savePersonalAlertPlanTool.execute(input, ctx)).toMatchObject({ ok: false });
    const saved = await savePersonalAlertPlanTool.execute({ ...input, enableConfirmed: true }, ctx);
    if (!saved.ok) throw new Error(JSON.stringify(saved.error));
    expect(
      await savePersonalAlertPlanTool.execute({ ...input, enableConfirmed: true }, ctx),
    ).toEqual(saved);
    expect(
      await listPersonalAlertPlansTool.execute({ watchlistId: 'personal' }, ctx),
    ).toMatchObject({ ok: true, data: { plans: [{ planRevision: saved.data.planRevision }] } });
    const prepared = await preparePersonalAlertRequestTool.execute(
      { watchlistId: 'personal', period: '2026-10-12', maxDailyNotifications: 10 },
      ctx,
    );
    expect(prepared).toMatchObject({
      ok: true,
      data: {
        input: {
          notificationPolicy: 'never',
          members: [{ stockId: '600519.SH' }],
          alertPlans: [{ id: plan.id }],
        },
      },
    });
    const removed = await removePersonalAlertPlanTool.execute(
      { alertPlanId: plan.id, expectedPlanRevision: saved.data.planRevision, requestId: 'delete' },
      ctx,
    );
    expect(removed.ok).toBe(true);
    expect(await ctx.repos.alertPlan.findById(plan.id)).toBeNull();
  });
});
