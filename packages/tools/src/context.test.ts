import { describe, expect, it } from 'vitest';
import { type BuildContextInput, buildContext } from './context.js';
import { buildTestContext } from './testing/context.js';

describe('context execution identity', () => {
  it('retains local default composition', async () => {
    const dependencies = await buildTestContext();
    const { user: _user, identity: _identity, ...input } = dependencies;
    const ctx = buildContext(input);
    expect(ctx.identity).toEqual({ mode: 'local', userId: 'local-user' });
    expect(ctx.user).toEqual({ id: 'local-user', defaultAccountId: '' });
  });

  it('requires a hosted identity and never supplies local-user', async () => {
    const dependencies = await buildTestContext();
    expect(() =>
      buildContext({
        ...dependencies,
        mode: 'hosted',
        identity: undefined,
      } as unknown as BuildContextInput),
    ).toThrow();
  });

  it('freezes the trusted hosted identity and per-request user selection', async () => {
    const dependencies = await buildTestContext();
    const identity = {
      mode: 'hosted' as const,
      userId: 'hosted-user',
      tenantId: 'tenant-1',
      tenantGeneration: 1,
      actor: 'user' as const,
      requestId: 'req-1',
    };
    const ctx = buildContext({
      ...dependencies,
      mode: 'hosted',
      identity,
      user: { id: identity.userId, defaultAccountId: 'a1' },
    });
    identity.tenantId = 'other-tenant';
    expect(ctx.identity?.mode === 'hosted' && ctx.identity.tenantId).toBe('tenant-1');
    expect(Object.isFrozen(ctx.identity)).toBe(true);
    expect(Object.isFrozen(ctx.user)).toBe(true);
    expect(() => buildContext({ ...dependencies, mode: 'hosted', identity })).toThrow(
      'does not match',
    );
  });
});
