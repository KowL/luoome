import { randomUUID } from 'node:crypto';
import { createPluginOperationService, getWatchlistTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { createWatchlistOperationPolicies } from './watchlist-operations.js';

const setup = async (capabilities: readonly ('read' | 'write')[] = ['read', 'write']) => {
  const ctx = await buildTestContext();
  const principal = { userId: ctx.user.id, accountId: ctx.user.defaultAccountId };
  const policies = createWatchlistOperationPolicies();
  const service = createPluginOperationService({
    repository: ctx.repos.pluginAuthority,
    policies,
    capabilities,
    policyVersion: 1,
    now: Date.now,
    context: () => ctx,
  });
  const prepare = async (tool: string, input: unknown) => {
    const id = randomUUID();
    const result = await service.prepare(principal, { id, tool, input });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const data = result.data as { confirmationToken: string; input: { id?: string } };
    return { id, token: data.confirmationToken, input: data.input };
  };
  const confirm = (operation: { id: string; token: string }) =>
    service.confirm(principal, operation, new AbortController().signal);
  return { ctx, principal, policies, service, prepare, confirm };
};

describe('watchlist confirmed operations', () => {
  it('freezes creation, permits cancellation and confirms each member change only once', async () => {
    const { ctx, service, principal, prepare, confirm } = await setup();
    const create = await prepare('create_watchlist', {
      name: '持续研究',
      kind: 'personal',
      membershipPolicy: 'mixed',
    });
    expect(create.input.id).toBe(`watchlist-${create.id}`);
    expect(await ctx.repos.watchlist.list()).toEqual([]);
    expect(await confirm(create)).toMatchObject({ ok: true, data: { state: 'succeeded' } });
    expect(await confirm(create)).toMatchObject({ ok: true, data: { state: 'succeeded' } });
    const watchlistId = create.input.id;
    const change = await prepare('update_watchlist', { watchlistId, name: '不应写入' });
    await service.cancel(principal, change);
    expect(await confirm(change)).toMatchObject({ ok: true, data: { state: 'cancelled' } });
    expect((await ctx.repos.watchlist.list())[0]?.name).toBe('持续研究');
    const add = await prepare('add_watchlist_member', {
      watchlistId,
      stockId: '600519',
      reason: '研究现金流',
    });
    expect(await ctx.repos.watchlistMember.listMembers(watchlistId ?? '')).toEqual([]);
    expect(await confirm(add)).toMatchObject({ ok: true, data: { state: 'succeeded' } });
    expect(await confirm(add)).toMatchObject({ ok: true, data: { state: 'succeeded' } });
    const update = await prepare('update_watchlist_member', {
      watchlistId,
      stockId: '600519.SH',
      stage: 'researching',
      priority: 'important',
    });
    expect(await confirm(update)).toMatchObject({ ok: true, data: { state: 'succeeded' } });
    expect(await getWatchlistTool.execute({ watchlistId }, ctx)).toMatchObject({
      ok: true,
      data: {
        members: [
          {
            member: { stage: 'researching', priority: 'important' },
            sources: [{ kind: 'manual' }],
          },
        ],
      },
    });
    service.dispose();
  });

  it('removes only the manual source while retaining another source on the same member', async () => {
    const { ctx, prepare, confirm, service } = await setup();
    const create = await prepare('create_watchlist', {
      name: '多个来源',
      kind: 'personal',
      membershipPolicy: 'mixed',
    });
    await confirm(create);
    const watchlistId = create.input.id ?? '';
    await confirm(await prepare('add_watchlist_member', { watchlistId, stockId: '600519.SH' }));
    const member = await ctx.repos.watchlistMember.findMember(watchlistId, '600519.SH');
    if (!member) throw new Error('Missing member');
    const source = (await ctx.repos.watchlistMember.listSources(member.id))[0];
    if (!source) throw new Error('Missing source');
    await ctx.repos.watchlistMember.saveSource({
      ...source,
      id: 'ai-source',
      kind: 'ai',
      sourceKey: 'ai:research',
      reason: '另一研究来源',
    });
    const remove = await prepare('archive_watchlist_member', { watchlistId, stockId: '600519.SH' });
    expect(await confirm(remove)).toMatchObject({ ok: true, data: { state: 'succeeded' } });
    expect(await ctx.repos.watchlistMember.listMembers(watchlistId)).toHaveLength(1);
    expect(await ctx.repos.watchlistMember.listSources(member.id)).toMatchObject([
      { kind: 'ai', status: 'active' },
    ]);
    service.dispose();
  });

  it('rejects unapproved capabilities and foreign account input and never schedules these writes', async () => {
    const { ctx, service, principal, policies } = await setup(['read']);
    expect(
      await service.prepare(principal, {
        id: randomUUID(),
        tool: 'create_watchlist',
        input: { name: '禁止', kind: 'personal', membershipPolicy: 'mixed' },
      }),
    ).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    for (const policy of policies) {
      expect(policy.scheduled).toBe(false);
      expect(() => policy.bind({ accountId: 'foreign' }, principal, randomUUID(), ctx)).toThrow();
      if (policy.tool.name !== 'create_watchlist') expect(await policy.receipt({}, ctx)).toBeNull();
    }
    expect(await ctx.repos.watchlist.list()).toEqual([]);
    service.dispose();
  });
});
