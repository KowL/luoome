import { describe, expect, it } from 'vitest';
import { buildContext } from './context.js';
import { buildTestContext } from './testing/context.js';

describe('context execution identity', () => {
  it('retains local default composition', async () => {
    const dependencies = await buildTestContext();
    const { user: _user, ...input } = dependencies;
    const ctx = buildContext(input);
    expect(ctx.user).toEqual({ id: 'local-user', defaultAccountId: '' });
  });
});
