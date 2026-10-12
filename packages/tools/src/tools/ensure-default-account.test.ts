import type { ToolContext } from '@luoome/core';
import { createInMemoryRepos } from '@luoome/db/memory';
import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../registry.js';
import { buildTestContext } from '../testing/context.js';
import { ensureDefaultAccountTool } from './ensure-default-account.js';

const workerContext = async (authorized = true): Promise<ToolContext> => ({
  ...(await buildTestContext()),
  repos: createInMemoryRepos(),
  identity: {
    mode: 'hosted',
    userId: 'test-user',
    tenantId: 'tenant-one',
    tenantGeneration: 1,
    actor: 'worker',
    requestId: 'provision-one',
  },
  ...(authorized ? { hostedAuthorization: () => null } : {}),
});

describe('ensure_default_account', () => {
  it('converges concurrent retries on one actual empty CNY account without financial entries', async () => {
    const ctx = await workerContext();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ensureDefaultAccountTool.execute({}, ctx)),
    );
    for (const result of results) {
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.data.account).toMatchObject({
        id: 'default-account',
        name: '默认投资账户',
        kind: 'real',
        currency: 'CNY',
        initialCapital: 0,
        cashBalance: 0,
      });
    }
    expect(await ctx.repos.account.list()).toHaveLength(1);
    expect(await ctx.repos.holding.listByAccount('default-account')).toEqual([]);
    expect(await ctx.repos.trade.listByAccount('default-account')).toEqual([]);
    expect(await ctx.repos.portfolioCashFlow.listByAccount('default-account')).toEqual([]);
  });

  it('requires trusted hosted worker authorization and stays out of public discovery', async () => {
    const ctx = await workerContext();
    if (ctx.identity?.mode !== 'hosted') throw new Error('Expected hosted worker fixture');
    const user: ToolContext = {
      ...ctx,
      identity: { ...ctx.identity, actor: 'user' },
    };
    for (const context of [await buildTestContext(), user, await workerContext(false)]) {
      const result = await ensureDefaultAccountTool.execute({}, context);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('permission_denied');
    }
    expect(toolRegistry.get('ensure_default_account')).toBeUndefined();
    expect(await ctx.repos.account.list()).toEqual([]);
  });
});
