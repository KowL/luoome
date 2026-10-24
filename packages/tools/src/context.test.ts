import { describe, expect, it } from 'vitest';
import { buildContext } from './context.js';
import { buildTestContext } from './testing/context.js';

describe('context execution identity', () => {
  it('retains local default composition', async () => {
    const dependencies = await buildTestContext();
    const { user: _user, identity: _identity, ...input } = dependencies;
    const ctx = buildContext(input);
    expect(ctx.identity).toEqual({ mode: 'local', userId: 'local-user' });
    expect(ctx.user).toEqual({ id: 'local-user', defaultAccountId: '' });
  });

  it('freezes the local identity and keeps the user selection', async () => {
    const dependencies = await buildTestContext();
    const ctx = buildContext({
      ...dependencies,
      identity: { mode: 'local', userId: 'local-user' },
      user: { id: 'local-user', defaultAccountId: 'a1' },
    });
    expect(ctx.identity).toEqual({ mode: 'local', userId: 'local-user' });
    expect(Object.isFrozen(ctx.identity)).toBe(true);
    expect(ctx.user).toEqual({ id: 'local-user', defaultAccountId: 'a1' });
  });

  it('rejects a user that does not match the execution identity', async () => {
    const dependencies = await buildTestContext();
    expect(() =>
      buildContext({
        ...dependencies,
        identity: { mode: 'local', userId: 'local-user' },
        user: { id: 'other-user', defaultAccountId: 'a1' },
      }),
    ).toThrow('does not match');
  });
});
