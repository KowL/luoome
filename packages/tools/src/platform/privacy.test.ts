import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTenantExportSnapshotTool } from '../hosted/privacy.js';
import { toolRegistry } from '../registry.js';
import { buildTestContext } from '../testing/context.js';
import { buildPlatformContext } from './context.js';
import {
  completeHostedDeletionTool,
  completeHostedExportTool,
  getHostedExportTool,
  requestHostedDeletionTool,
  requestHostedExportTool,
  resolveHostedExportDownloadTool,
} from './privacy.js';
import { platformToolRegistry } from './registry.js';
import {
  buildPlatformTestContext,
  buildPlatformWorkerTestContext,
  loginPlatformTestUser,
  PLATFORM_TEST_NOW,
  provisionPlatformTestTenant,
} from './testing-context.js';

const setup = async () => {
  let now = new Date(PLATFORM_TEST_NOW);
  const fixture = buildPlatformTestContext({ clock: () => now });
  const user = await loginPlatformTestUser(fixture);
  await provisionPlatformTestTenant(user.ctx);
  return {
    ...fixture,
    user,
    worker: buildPlatformWorkerTestContext(user.ctx),
    setNow: (value: Date) => {
      now = value;
    },
  };
};

describe('hosted privacy tools', () => {
  it('supports idempotent exports without paid entitlement and enforces private, expiring downloads', async () => {
    const fixture = await setup();
    expect(
      await fixture.ctx.repos.subscriptions.currentEntitlement({
        tenantId: fixture.user.tenant.id,
        now: PLATFORM_TEST_NOW,
      }),
    ).toBeNull();
    const request = await requestHostedExportTool.execute(
      { requestId: 'one-export' },
      fixture.user.ctx,
    );
    if (!request.ok) throw new Error('Export fixture request failed');
    const replay = await requestHostedExportTool.execute(
      { requestId: 'one-export' },
      fixture.user.ctx,
    );
    expect(replay).toMatchObject({
      ok: true,
      data: {
        export: { id: request.data.export.id, operationId: request.data.export.operationId },
        replayed: true,
      },
    });
    const complete = {
      id: request.data.export.id,
      generation: 1,
      resultHash: 'f'.repeat(64),
      byteLength: 500,
    };
    expect(await completeHostedExportTool.execute(complete, fixture.user.ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(await completeHostedExportTool.execute(complete, fixture.worker)).toMatchObject({
      ok: true,
      data: { state: 'ready' },
    });
    expect(
      await resolveHostedExportDownloadTool.execute({ id: complete.id }, fixture.user.ctx),
    ).toMatchObject({
      ok: true,
      data: { exportId: complete.id, artifactRef: complete.id, byteLength: 500 },
    });
    const another = await loginPlatformTestUser(fixture, 'another@example.test');
    await provisionPlatformTestTenant(another.ctx);
    expect(await getHostedExportTool.execute({ id: complete.id }, another.ctx)).toMatchObject({
      ok: false,
      error: { kind: 'not_found' },
    });
    expect(
      await resolveHostedExportDownloadTool.execute({ id: complete.id }, another.ctx),
    ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    fixture.setNow(request.data.export.expiresAt);
    expect(
      await resolveHostedExportDownloadTool.execute({ id: complete.id }, fixture.user.ctx),
    ).toMatchObject({ ok: false, error: { kind: 'not_found' } });
    expect(await getHostedExportTool.execute({ id: complete.id }, fixture.user.ctx)).toMatchObject({
      ok: true,
      data: { export: { state: 'expired', artifactRef: null } },
    });
  });

  it('rejects user destinations and enforces write and actor capabilities', async () => {
    const fixture = await setup();
    expect(
      await requestHostedExportTool.execute(
        { requestId: 'injected', destination: 'external-recipient' },
        fixture.user.ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(
      await requestHostedExportTool.execute(
        { requestId: 'injected', tenantId: 'another-tenant' },
        fixture.user.ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    const disabled = buildPlatformContext({
      ...fixture.user.ctx,
      capabilities: { write: false, external: false },
    });
    expect(await requestHostedExportTool.execute({ requestId: 'blocked' }, disabled)).toMatchObject(
      { ok: false, error: { kind: 'permission_denied', required: 'write' } },
    );
    expect(
      await requestHostedExportTool.execute({ requestId: 'worker' }, fixture.worker),
    ).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    expect(await fixture.ctx.repos.privacy.listExports({})).toHaveLength(0);
  });

  it('requires persisted recent verification, explicit tenant confirmation, and trusted deletion completion', async () => {
    const fixture = await setup();
    const input = { requestId: 'delete-one', confirmationTenantId: fixture.user.tenant.id };
    expect(
      await requestHostedDeletionTool.execute(
        { ...input, confirmationTenantId: 'another-tenant' },
        fixture.user.ctx,
      ),
    ).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    fixture.setNow(new Date(PLATFORM_TEST_NOW.getTime() + 11 * 60_000));
    expect(await requestHostedDeletionTool.execute(input, fixture.user.ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied', required: 'auth:recent-verification' },
    });
    if (fixture.user.ctx.principal.kind !== 'user')
      throw new Error('User fixture principal missing');
    const forged = buildPlatformContext({
      ...fixture.user.ctx,
      principal: { ...fixture.user.ctx.principal, authenticatedAt: fixture.ctx.clock() },
    });
    expect(await requestHostedDeletionTool.execute(input, forged)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied', required: 'auth:valid-session' },
    });
    const verified = await loginPlatformTestUser(fixture);
    const begun = await requestHostedDeletionTool.execute(input, verified.ctx);
    if (!begun.ok) throw new Error('Delete fixture request failed');
    expect(begun).toMatchObject({
      data: {
        deletion: { state: 'draining', generation: 2 },
        tenant: { status: 'deleting', generation: 2 },
      },
    });
    expect(await getHostedExportTool.execute({ id: 'any-id' }, verified.ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    const completion = { id: begun.data.deletion.id, generation: 2 };
    expect(await completeHostedDeletionTool.execute(completion, verified.ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(await completeHostedDeletionTool.execute(completion, fixture.worker)).toMatchObject({
      ok: true,
      data: {
        deletion: { state: 'completed' },
        tombstone: { id: fixture.user.tenant.id, generation: 2 },
      },
    });
    expect((await fixture.ctx.repos.auth.findUserById(fixture.user.user.id))?.email).toBeNull();
  });

  it('limits tenant snapshot creation to the current trusted worker generation and keeps it outside model discovery', async () => {
    const base = await buildTestContext({ clock: () => new Date(PLATFORM_TEST_NOW) });
    const input = { operationId: 'private-export', inputHash: 'a'.repeat(64), generation: 1 };
    expect(await createTenantExportSnapshotTool.execute(input, base)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    const identity = {
      mode: 'hosted' as const,
      actor: 'worker' as const,
      userId: 'privacy-user',
      tenantId: 'privacy-tenant',
      tenantGeneration: 1,
      requestId: 'privacy-request',
    };
    const ctx = {
      ...base,
      identity,
      user: { id: identity.userId, defaultAccountId: '' },
      hostedAuthorization: async () => null,
    };
    expect(
      await createTenantExportSnapshotTool.execute({ ...input, generation: 2 }, ctx),
    ).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    const result = await createTenantExportSnapshotTool.execute(input, ctx);
    if (!result.ok) throw new Error('Snapshot fixture creation failed');
    expect(result.data.receipt.resultHash).toBe(
      createHash('sha256').update(JSON.stringify(result.data.snapshot)).digest('hex'),
    );
    expect(await createTenantExportSnapshotTool.execute(input, ctx)).toMatchObject({
      ok: true,
      data: { replayed: true },
    });
    expect(toolRegistry.get(createTenantExportSnapshotTool.name)).toBeUndefined();
    expect(toolRegistry.get(requestHostedExportTool.name)).toBeUndefined();
    expect(platformToolRegistry.get(requestHostedExportTool.name)).toBe(requestHostedExportTool);
  });
});
