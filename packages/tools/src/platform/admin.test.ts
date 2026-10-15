import type { PlanVersion } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import {
  getHostedUserDetailTool,
  listHostedUsersTool,
  recordHostedOperatorPaymentTool,
  setHostedUserStatusTool,
} from './admin.js';
import { buildPlatformContext, type PlatformContext } from './context.js';
import {
  buildPlatformTestContext,
  loginPlatformTestUser,
  provisionPlatformTestTenant,
} from './testing-context.js';

const adminCtx = (fixture: ReturnType<typeof buildPlatformTestContext>): PlatformContext =>
  buildPlatformContext({
    ...fixture.ctx,
    principal: {
      kind: 'admin',
      userId: 'fixture-operator',
      requestId: 'fixture-admin-request',
      ipKey: 'a'.repeat(64),
    },
  });

const setup = async () => {
  const fixture = buildPlatformTestContext();
  const user = await loginPlatformTestUser(fixture);
  const tenant = await provisionPlatformTestTenant(user.ctx);
  const plan: PlanVersion = {
    id: 'fixture-admin-monthly-v1',
    code: 'fixture-admin',
    currency: 'CNY',
    priceMinor: 4900,
    durationMonths: 1,
    limits: {
      watchlistStocks: 100,
      enabledRules: 20,
      dailyJobs: 20,
      concurrentJobs: 1,
      queuedJobs: 10,
      researchUnits: 30,
    },
    productPolicyVersion: 'hosted-facts-v1',
    publishedAt: fixture.ctx.clock(),
  };
  await fixture.ctx.repos.subscriptions.publishPlan(plan);
  const now = fixture.ctx.clock();
  await fixture.ctx.repos.subscriptions.grantTrial({
    period: {
      id: `fixture-admin-period:${tenant.id}`,
      tenantId: tenant.id,
      planVersionId: plan.id,
      startsAt: now,
      endsAt: new Date(now.getTime() + 7 * 86_400_000),
      anchorDay: 10,
      sourceOrderId: null,
      status: 'trial',
      createdAt: now,
    },
    now,
  });
  return { ...fixture, user, tenant, plan, admin: adminCtx(fixture) };
};

describe('platform admin tools', () => {
  it('rejects non-admin actors', async () => {
    const fixture = await setup();
    const listed = await listHostedUsersTool.execute({}, fixture.user.ctx);
    expect(listed.ok).toBe(false);
    if (!listed.ok && listed.error.kind === 'permission_denied')
      expect(listed.error.required).toBe('actor:admin');
  });

  it('lists users with tenant and trial entitlement', async () => {
    const fixture = await setup();
    const result = await listHostedUsersTool.execute({}, fixture.admin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.users).toHaveLength(1);
    const row = result.data.users[0];
    expect(row?.user.id).toBe(fixture.user.user.id);
    expect(row?.tenant.id).toBe(fixture.tenant.id);
    expect(row?.entitlement?.period.status).toBe('trial');
  });

  it('returns tenant detail with periods, orders and usage', async () => {
    const fixture = await setup();
    const missing = await getHostedUserDetailTool.execute({ tenantId: 'nope' }, fixture.admin);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe('not_found');
    const detail = await getHostedUserDetailTool.execute(
      { tenantId: fixture.tenant.id },
      fixture.admin,
    );
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.user.emailKey).toBe('research@example.test');
    expect(detail.data.periods.some((period) => period.status === 'trial')).toBe(true);
    expect(detail.data.orders).toHaveLength(0);
  });

  it('records an operator payment once and extends service after the trial', async () => {
    const fixture = await setup();
    const before = await fixture.ctx.repos.subscriptions.currentEntitlement({
      tenantId: fixture.tenant.id,
      now: fixture.ctx.clock(),
    });
    if (before === null) throw new Error('Fixture trial entitlement missing');
    const input = {
      tenantId: fixture.tenant.id,
      planVersionId: fixture.plan.id,
      reference: '微信转账 2026-10-15',
      requestId: 'operator-payment-1',
    };
    const recorded = await recordHostedOperatorPaymentTool.execute(input, fixture.admin);
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(recorded.data.replayed).toBe(false);
    expect(recorded.data.order.state).toBe('paid');
    expect(recorded.data.order.provider).toBe('operator-manual');
    expect(recorded.data.order.reconciliation).toBe('none');
    expect(recorded.data.period?.status).toBe('paid');
    expect(recorded.data.period?.startsAt.getTime()).toBe(before.period.endsAt.getTime());
    const entitlement = await fixture.ctx.repos.subscriptions.currentEntitlement({
      tenantId: fixture.tenant.id,
      now: new Date(before.period.endsAt.getTime() + 1000),
    });
    expect(entitlement?.period.id).toBe(recorded.data.period?.id);
    expect(entitlement?.plan.limits.researchUnits).toBe(30);

    const replay = await recordHostedOperatorPaymentTool.execute(input, fixture.admin);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.order.id).toBe(recorded.data.order.id);
    expect(await fixture.ctx.repos.payments.listOrders(fixture.tenant.id)).toHaveLength(1);
  });

  it('rejects reusing one reference for a second payment', async () => {
    const fixture = await setup();
    const first = await recordHostedOperatorPaymentTool.execute(
      {
        tenantId: fixture.tenant.id,
        planVersionId: fixture.plan.id,
        reference: '微信转账 2026-10-15',
        requestId: 'operator-payment-1',
      },
      fixture.admin,
    );
    expect(first.ok).toBe(true);
    const second = await recordHostedOperatorPaymentTool.execute(
      {
        tenantId: fixture.tenant.id,
        planVersionId: fixture.plan.id,
        reference: '微信转账 2026-10-15',
        requestId: 'operator-payment-2',
      },
      fixture.admin,
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.kind).toBe('invalid_input');
  });

  it('disables a user and revokes sessions, then re-enables', async () => {
    const fixture = await setup();
    const disabled = await setHostedUserStatusTool.execute(
      { userId: fixture.user.user.id, status: 'disabled' },
      fixture.admin,
    );
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.data.user.status).toBe('disabled');
    const session = await fixture.ctx.repos.auth.resolveSession({
      tokenHash:
        fixture.user.ctx.principal.kind === 'user' ? fixture.user.ctx.principal.tokenHash : '',
      now: fixture.ctx.clock(),
      touch: false,
    });
    expect(session).toBeNull();

    const enabled = await setHostedUserStatusTool.execute(
      { userId: fixture.user.user.id, status: 'active' },
      fixture.admin,
    );
    expect(enabled.ok).toBe(true);
    if (enabled.ok) expect(enabled.data.user.status).toBe('active');

    const missing = await setHostedUserStatusTool.execute(
      { userId: 'nope', status: 'disabled' },
      fixture.admin,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe('not_found');
  });
});
