import type { HostedEntitlement, HostedExecutionIdentity, Tenant, ToolContext } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';
import { toolRegistry } from '../registry.js';
import { buildTestContext } from '../testing/context.js';
import type { HostedInvocation } from './invoke.js';
import {
  authorizeHostedWebRequest,
  contextForHostedWebTools,
  HOSTED_WEB_POLICY_VERSION,
  hostedWebInternalToolNames,
  hostedWebPublicToolNames,
} from './web.js';

const now = new Date('2026-10-12T03:00:00Z');
const fixture = async (userId = 'user-one') => {
  const base = await buildTestContext({ clock: () => now });
  const identity: HostedExecutionIdentity = {
    mode: 'hosted',
    userId,
    tenantId: `tenant-${userId}`,
    tenantGeneration: 1,
    actor: 'user',
    requestId: 'request-one',
  };
  const context: ToolContext = {
    ...base,
    identity,
    user: { ...base.user, id: userId },
  };
  const tenant: Tenant = {
    id: identity.tenantId,
    ownerUserId: userId,
    generation: 1,
    status: 'active',
    schemaVersion: 1,
    provisioningErrorKind: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const entitlement: HostedEntitlement = {
    capturedUnits: 0,
    heldUnits: 0,
    availableUnits: 30,
    plan: {
      id: 'plan-web-v2',
      code: 'personal',
      currency: 'CNY',
      priceMinor: 9900,
      durationMonths: 1,
      productPolicyVersion: HOSTED_WEB_POLICY_VERSION,
      publishedAt: now,
      limits: {
        watchlistStocks: 100,
        enabledRules: 20,
        dailyJobs: 20,
        concurrentJobs: 1,
        queuedJobs: 10,
        researchUnits: 30,
      },
    },
    period: {
      id: 'period-one',
      tenantId: tenant.id,
      planVersionId: 'plan-web-v2',
      startsAt: new Date(now.getTime() - 1000),
      endsAt: new Date(now.getTime() + 86_400_000),
      anchorDay: 12,
      sourceOrderId: null,
      status: 'trial',
      createdAt: now,
    },
  };
  const state: { tenant: Tenant | null; entitlement: HostedEntitlement | null } = {
    tenant,
    entitlement,
  };
  const invocation: HostedInvocation = {
    context,
    identity,
    entitlement,
    capabilities: { write: true, external: true },
    currentTenant: async () => state.tenant,
    currentEntitlement: async () => state.entitlement,
    currentReadWindow: async () => false,
  };
  return { invocation, state, context: contextForHostedWebTools(invocation) };
};
const authorize = (ctx: ToolContext, name: string, input: unknown = {}) =>
  ctx.hostedAuthorization?.(name, input, []) ?? Promise.resolve(null);
const execute = (ctx: ToolContext, name: string, input: unknown = {}) => {
  const tool = toolRegistry.get(name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool.execute(input, ctx);
};

describe('hosted original Web business policy', () => {
  it('explicitly accounts for every registry tool without granting unknown tools', async () => {
    expect(
      [
        ...hostedWebPublicToolNames,
        'create_account',
        'get_research_vault_remote_sync_status',
      ].sort(),
    ).toEqual(
      toolRegistry
        .all()
        .map((tool) => tool.name)
        .sort(),
    );
    expect(new Set(hostedWebInternalToolNames).size).toBe(hostedWebInternalToolNames.length);
    const { context } = await fixture();
    for (const name of [
      'create_account',
      'get_research_vault_remote_sync_status',
      'pull_research_vault_git',
      'create_tenant_export_snapshot',
      'request_hosted_export',
      'claim_hosted_job',
      'future_tool',
    ]) {
      expect(await authorize(context, name)).toMatchObject({
        ok: false,
        error: { kind: 'permission_denied' },
      });
    }
    for (const name of [
      'create_strategy',
      'run_strategy',
      'analyze_stock',
      'generate_strategy_recommendations',
      'create_watchlist',
      'create_alert_plan',
      'save_decision_review',
      'send_notification',
      'import_local_research_document',
      'export_strategy_manifest',
      'save_report',
      'execute_strict_strategy_backtest',
    ]) {
      expect(await authorize(context, name)).toBeNull();
    }
  });

  it('rechecks current identity, tenant ownership, generation and lifecycle before every call', async () => {
    const { invocation, state, context } = await fixture();
    expect(await authorize(context, 'list_accounts')).toBeNull();
    const original = state.tenant;
    if (original === null) throw new Error('fixture tenant missing');
    for (const tenant of [
      null,
      { ...original, id: 'other-tenant' },
      { ...original, ownerUserId: 'other' },
      { ...original, generation: 2 },
      { ...original, status: 'deleting' as const },
      { ...original, status: 'deleted' as const },
    ]) {
      state.tenant = tenant;
      expect(await authorize(context, 'list_accounts')).toMatchObject({ ok: false });
    }
    state.tenant = original;
    expect(
      await authorizeHostedWebRequest(
        { ...invocation, identity: { ...invocation.identity, actor: 'worker' } },
        false,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await authorizeHostedWebRequest(
        {
          ...invocation,
          context: { ...invocation.context, user: { id: 'other', defaultAccountId: 'account' } },
        },
        false,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await authorizeHostedWebRequest(
        {
          ...invocation,
          context: {
            ...invocation.context,
            user: { id: invocation.identity.userId, defaultAccountId: '' },
          },
        },
        false,
      ),
    ).toMatchObject({ ok: false });
  });

  it('keeps historical reads after expiry but requires the current v2 period for changes and refreshes', async () => {
    const { state, context } = await fixture();
    const original = state.entitlement;
    if (original === null) throw new Error('fixture entitlement missing');
    for (const entitlement of [
      null,
      { ...original, period: { ...original.period, endsAt: now } },
      { ...original, period: { ...original.period, startsAt: new Date(now.getTime() + 1) } },
      { ...original, period: { ...original.period, status: 'revoked' as const } },
      { ...original, period: { ...original.period, tenantId: 'other' } },
      { ...original, period: { ...original.period, planVersionId: 'other' } },
      { ...original, plan: { ...original.plan, productPolicyVersion: 'hosted-facts-v1' as const } },
    ]) {
      state.entitlement = entitlement;
      expect(await authorize(context, 'list_accounts')).toBeNull();
      expect(await authorize(context, 'list_reports')).toBeNull();
      for (const name of [
        'create_watchlist',
        'analyze_stock',
        'send_notification',
        'compute_indicators',
        'fetch_news',
      ])
        expect(await authorize(context, name)).toMatchObject({ ok: false });
    }
    state.entitlement = original;
    if (state.tenant === null) throw new Error('fixture tenant missing');
    state.tenant = { ...state.tenant, status: 'suspended' };
    expect(await authorize(context, 'get_advice')).toBeNull();
    expect(await authorize(context, 'update_account')).toMatchObject({ ok: false });
  });

  it('preserves write and external opt-ins including advice and old read tools with provider access', async () => {
    const { invocation } = await fixture();
    for (const capabilities of [
      { write: false, external: true },
      { write: true, external: false },
    ]) {
      const ctx = contextForHostedWebTools({ ...invocation, capabilities });
      for (const name of [
        'analyze_stock',
        'market_outlook',
        'fetch_quote',
        'compute_indicators',
        'search_stocks',
        'limit_up_ladder',
        'dragon_tiger_list',
        'northbound_flow',
        'fetch_news',
        'fetch_sector_quotes',
        'get_stock_research_view',
      ]) {
        expect(await authorize(ctx, name)).toMatchObject({
          ok: false,
          error: { kind: 'permission_denied' },
        });
      }
    }
    const ctx = contextForHostedWebTools({
      ...invocation,
      capabilities: { write: true, external: false },
    });
    expect(await authorize(ctx, 'update_account')).toBeNull();
    expect(
      await authorizeHostedWebRequest(
        { ...invocation, capabilities: { write: false, external: true } },
        true,
      ),
    ).toMatchObject({ ok: false, error: { required: 'capability:write' } });
  });

  it('binds explicit and nested account inputs to the default and executes original tenant-scoped tools', async () => {
    const first = await fixture('one');
    const second = await fixture('two');
    expect(
      await execute(first.context, 'update_account', { accountId: 'foreign', name: 'no' }),
    ).toMatchObject({ ok: false, error: { required: 'hosted:default-account' } });
    expect(
      await authorize(first.context, 'save_report', { report: { accountId: 'foreign' } }),
    ).toMatchObject({ ok: false, error: { required: 'hosted:default-account' } });
    expect(await execute(first.context, 'update_account', { name: '我的账户' })).toMatchObject({
      ok: true,
    });
    const id = first.context.user.defaultAccountId;
    expect((await first.context.repos.account.findById(id))?.name).toBe('我的账户');
    expect((await second.context.repos.account.findById(id))?.name).not.toBe('我的账户');
    expect(
      await execute(first.context, 'create_watchlist', {
        id: 'private-watch',
        name: 'private',
        kind: 'personal',
        membershipPolicy: 'manual',
      }),
    ).toMatchObject({ ok: true });
    expect(
      await execute(second.context, 'get_watchlist', { watchlistId: 'private-watch' }),
    ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  });

  it('allows only user-confirmed decision bookkeeping on its dedicated route without external permission', async () => {
    const { invocation, context } = await fixture();
    expect(await authorize(context, 'record_decision_trade')).toMatchObject({
      ok: false,
      error: { required: 'capability:trade' },
    });
    const dedicated = contextForHostedWebTools(
      { ...invocation, capabilities: { write: true, external: false } },
      { allowDecisionTrade: true },
    );
    expect(await authorize(dedicated, 'record_decision_trade')).toBeNull();
    const workerIdentity = { ...invocation.identity, actor: 'worker' as const };
    const worker = contextForHostedWebTools(
      {
        ...invocation,
        identity: workerIdentity,
        context: { ...invocation.context, identity: workerIdentity },
      },
      { allowDecisionTrade: true },
    );
    expect(await authorize(worker, 'record_decision_trade')).toMatchObject({ ok: false });
    expect(await dedicated.hostedAuthorization?.('update_account', {}, ['trade'])).toMatchObject({
      ok: false,
    });
  });

  it('reads expired holdings from saved quotes without provider calls or cache writes', async () => {
    const { invocation, state, context } = await fixture();
    const holdings = await context.repos.holding.listByAccount(context.user.defaultAccountId);
    const quotes = await context.adapters.market.batchQuote(holdings.map((item) => item.stockId));
    for (const quote of quotes.values()) await context.repos.quote.save(quote);
    state.entitlement = null;
    const batch = vi.spyOn(context.adapters.market, 'batchQuote');
    const quote = vi.spyOn(context.adapters.market, 'fetchQuote');
    const daily = vi.spyOn(context.adapters.market, 'fetchDailyBars');
    const save = vi.spyOn(context.repos.quote, 'save');
    expect(await execute(context, 'list_holdings')).toMatchObject({ ok: true });
    expect(await execute(context, 'get_holding', { holdingId: holdings[0]?.id })).toMatchObject({
      ok: true,
    });
    expect(batch).not.toHaveBeenCalled();
    expect(quote).not.toHaveBeenCalled();
    expect(daily).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(await authorizeHostedWebRequest(invocation, false)).toBeNull();
  });
});
