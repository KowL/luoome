import { money, RiskVetoSchema } from '@luoome/core';
import { getAnalysisContextTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { createRiskVetoOverrideHandler } from './risk-veto.js';

const now = new Date('2026-07-29T04:00:00Z');
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
  const snapshot = await getAnalysisContextTool.execute(
    { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' } },
    ctx,
  );
  if (!snapshot.ok) throw new Error('fixture snapshot failed');
  await ctx.repos.riskVeto.save(
    RiskVetoSchema.parse({
      id: 'veto',
      accountId: ctx.user.defaultAccountId,
      subject: snapshot.data.subject,
      reason: 'previous evidence',
      factIds: ['old-fact'],
      contextId: 'old-context',
      createdAt: new Date(now.getTime() - 1000),
    }),
  );
  const principal = { userId: ctx.user.id, accountId: ctx.user.defaultAccountId };
  const body = {
    vetoId: 'veto',
    reason: 'new persisted quote',
    evidenceContextId: snapshot.data.id,
    newFactIds: ['quote:600519.SH'],
    confirmed: true,
  };
  return { ctx, principal, body };
};
const request = (body: unknown, origin = 'http://localhost') =>
  new Request('http://localhost/api/luoome/risk-veto/override', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('human risk-veto override HTTP carrier', () => {
  it('uses admitted owner identity and a persisted evidence snapshot', async () => {
    const { ctx, principal, body } = await setup();
    const handler = createRiskVetoOverrideHandler({
      admit: () => null,
      principal: () => principal,
      context: () => ctx,
    });
    const response = await handler(request(body));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
    expect(
      await ctx.repos.riskVeto.findActiveBySubject({
        accountId: principal.accountId,
        subject: { kind: 'stock', id: '600519.SH' },
      }),
    ).toBeNull();
    expect(ctx.riskVetoOverrideAuthorization).toBeUndefined();
  });
  it('rejects missing owner admission and does not mutate business state', async () => {
    const { ctx, principal, body } = await setup();
    const handler = createRiskVetoOverrideHandler({
      admit: () => new Response(null, { status: 403 }),
      principal: () => principal,
      context: () => ctx,
    });
    expect((await handler(request(body))).status).toBe(403);
    expect(
      await ctx.repos.riskVeto.findActiveBySubject({
        accountId: principal.accountId,
        subject: { kind: 'stock', id: '600519.SH' },
      }),
    ).not.toBeNull();
  });
  it('rejects cross-origin calls and fabricated evidence', async () => {
    const { ctx, principal, body } = await setup();
    const handler = createRiskVetoOverrideHandler({
      admit: () => null,
      principal: () => principal,
      context: () => ctx,
    });
    expect((await handler(request(body, 'http://other'))).status).toBe(403);
    expect((await handler(request({ ...body, newFactIds: ['fake'] }))).status).toBe(400);
    expect(
      await ctx.repos.riskVeto.findActiveBySubject({
        accountId: principal.accountId,
        subject: { kind: 'stock', id: '600519.SH' },
      }),
    ).not.toBeNull();
  });
});
