import { randomUUID } from 'node:crypto';
import { money, type ToolContext } from '@luoome/core';
import { createPluginOperationService, deriveAccountFacts } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { createAccountOperationPolicies, updateAccountOperation } from './account-operations.js';

type Service = ReturnType<typeof createPluginOperationService>;
type Principal = { readonly userId: string; readonly accountId: string };
type Prepared = {
  readonly confirmationToken?: string;
  readonly operationId: string;
  readonly state: string;
  readonly input: Record<string, unknown>;
};

const principalOf = (ctx: ToolContext): Principal => ({
  userId: ctx.user.id,
  accountId: ctx.user.defaultAccountId,
});

const serviceFor = (ctx: ToolContext, policies = createAccountOperationPolicies()): Service =>
  createPluginOperationService({
    repository: ctx.repos.pluginAuthority,
    policies,
    capabilities: ['write'],
    policyVersion: 1,
    now: Date.now,
    context: () => ctx,
  });

const prepare = async (
  service: Service,
  principal: Principal,
  tool: string,
  input: unknown,
): Promise<Prepared> => {
  const prepared = await service.prepare(principal, { id: randomUUID(), tool, input });
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  return prepared.data as Prepared;
};

const confirm = async (
  service: Service,
  principal: Principal,
  prepared: Prepared,
): Promise<{ readonly state: string; readonly result: unknown; readonly input: unknown }> => {
  const result = await service.confirm(
    principal,
    { id: prepared.operationId, token: prepared.confirmationToken as string },
    new AbortController().signal,
  );
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data as { state: string; result: unknown; input: unknown };
};

const digestOf = async (ctx: ToolContext, accountId: string): Promise<string> => {
  const facts = await deriveAccountFacts(ctx, accountId);
  if (facts === null) throw new Error('account facts unavailable');
  return facts.digest;
};

describe('account settings operation', () => {
  it('previews, confirms once, and reads back the same owner account', async () => {
    const ctx = await buildTestContext();
    const principal = principalOf(ctx);
    const original = await ctx.repos.account.findById(principal.accountId);
    const service = serviceFor(ctx, [updateAccountOperation]);
    const id = randomUUID();
    const prepared = await service.prepare(principal, {
      id,
      tool: 'update_account',
      input: { name: '新的账户名称' },
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    expect(await ctx.repos.account.findById(principal.accountId)).toEqual(original);
    const { confirmationToken, input } = prepared.data as {
      confirmationToken: string;
      input: unknown;
    };
    expect(input).toEqual({ accountId: principal.accountId, name: '新的账户名称' });
    for (let index = 0; index < 2; index++)
      expect(
        await service.confirm(
          principal,
          { id, token: confirmationToken },
          new AbortController().signal,
        ),
      ).toMatchObject({ ok: true, data: { state: 'succeeded' } });
    expect(await ctx.repos.account.findById(principal.accountId)).toEqual({
      ...original,
      name: '新的账户名称',
    });
    expect(() =>
      updateAccountOperation.bind(
        { accountId: 'foreign', name: '覆盖' },
        principal,
        randomUUID(),
        ctx,
      ),
    ).toThrow();
    expect(await updateAccountOperation.receipt(input, ctx)).toMatchObject({ ok: true });
    service.dispose();
  });
});

describe('account maintenance operations (T47)', () => {
  it('declares every account write as an unscheduled write policy (add_trade is not a trade capability)', () => {
    const byName = new Map(createAccountOperationPolicies().map((item) => [item.tool.name, item]));
    expect([...byName.keys()]).toEqual([
      'update_account',
      'add_trade',
      'close_holding',
      'create_portfolio_cash_flow',
    ]);
    for (const name of byName.keys()) {
      expect(byName.get(name)?.scheduled, name).toBe(false);
      expect(byName.get(name)?.tool.sideEffect, name).toBe('write');
      expect(byName.get(name)?.tool.requiredCapabilities, name).toEqual(['write']);
    }
  });

  it('add_trade: freezes input, writes once, replays the same receipt, moves the facts digest', async () => {
    const ctx = await buildTestContext();
    const principal = principalOf(ctx);
    const service = serviceFor(ctx);
    const beforeDigest = await digestOf(ctx, principal.accountId);
    const beforeTrades = (await ctx.repos.trade.listByAccount(principal.accountId)).length;

    const prepared = await prepare(service, principal, 'add_trade', {
      stockId: '600519.SH',
      side: 'buy',
      quantity: 100,
      price: 1500,
      fee: 5,
    });
    // 冻结的输入：账户由 host 绑定，executedAt 在 prepare 时定死（不再随 confirm 时刻漂移）。
    expect(prepared.input).toMatchObject({
      accountId: principal.accountId,
      stockId: '600519.SH',
      side: 'buy',
      quantity: 100,
      price: 1500,
      fee: 5,
    });
    expect(typeof prepared.input.executedAt).toBe('string');
    expect((await ctx.repos.trade.listByAccount(principal.accountId)).length).toBe(beforeTrades);

    const first = await confirm(service, principal, prepared);
    expect(first.state).toBe('succeeded');
    expect(await ctx.repos.trade.listByAccount(principal.accountId)).toHaveLength(beforeTrades + 1);
    const afterDigest = await digestOf(ctx, principal.accountId);
    expect(afterDigest).not.toBe(beforeDigest);
    expect(
      await ctx.repos.holding.findByAccountAndStock(principal.accountId, '600519.SH'),
    ).toMatchObject({ quantity: 200 });

    // 重复提交同一个 operationId：返回原回执，不第二次写库，事实指纹也不再变化。
    const replay = await confirm(service, principal, prepared);
    expect(replay.state).toBe('succeeded');
    expect(replay.result).toEqual(first.result);
    expect(await ctx.repos.trade.listByAccount(principal.accountId)).toHaveLength(beforeTrades + 1);
    expect(await digestOf(ctx, principal.accountId)).toBe(afterDigest);

    // 回执可回读：崩溃后 reconcile 能按冻结输入认回这笔成交。
    expect(await service.reconcile(principal, prepared.operationId)).toMatchObject({
      ok: true,
      data: { state: 'succeeded' },
    });
    service.dispose();
  });

  it('add_trade: rejects a foreign accountId at prepare', async () => {
    const ctx = await buildTestContext();
    const principal = principalOf(ctx);
    const service = serviceFor(ctx);
    const beforeTrades = (await ctx.repos.trade.listByAccount(principal.accountId)).length;
    const denied = await service.prepare(principal, {
      id: randomUUID(),
      tool: 'add_trade',
      input: {
        accountId: 'another-account',
        stockId: '600519.SH',
        side: 'buy',
        quantity: 1,
        price: 1,
      },
    });
    expect(denied.ok).toBe(false);
    expect(await ctx.repos.trade.listByAccount(principal.accountId)).toHaveLength(beforeTrades);
    service.dispose();
  });

  it('close_holding: writes once, replays the same receipt, and keeps the closedAt', async () => {
    const ctx = await buildTestContext();
    const principal = principalOf(ctx);
    const service = serviceFor(ctx);
    const holding = await ctx.repos.holding.findByAccountAndStock(principal.accountId, '002594.SZ');
    if (holding === null) throw new Error('fixture holding missing');
    const beforeDigest = await digestOf(ctx, principal.accountId);

    const prepared = await prepare(service, principal, 'close_holding', { holdingId: holding.id });
    expect(prepared.input).toEqual({ holdingId: holding.id });
    expect((await ctx.repos.holding.findById(holding.id))?.closedAt).toBeNull();

    const first = await confirm(service, principal, prepared);
    expect(first.state).toBe('succeeded');
    const closed = await ctx.repos.holding.findById(holding.id);
    expect(closed?.closedAt).not.toBeNull();
    expect(await digestOf(ctx, principal.accountId)).not.toBe(beforeDigest);

    const replay = await confirm(service, principal, prepared);
    expect(replay.state).toBe('succeeded');
    expect(replay.result).toEqual(first.result);
    expect((await ctx.repos.holding.findById(holding.id))?.closedAt).toEqual(closed?.closedAt);

    // 已平仓的持仓不再接受新的平仓请求：prepare 阶段就拒绝，不留 pending 操作。
    const again = await service.prepare(principal, {
      id: randomUUID(),
      tool: 'close_holding',
      input: { holdingId: holding.id },
    });
    expect(again.ok).toBe(false);
    service.dispose();
  });

  it('close_holding: rejects a holding owned by another account', async () => {
    const ctx = await buildTestContext();
    const principal = principalOf(ctx);
    const service = serviceFor(ctx);
    const accounts = await ctx.repos.account.list();
    const foreign = accounts.find((account) => account.id !== principal.accountId);
    if (foreign === undefined) throw new Error('fixture account missing');
    await ctx.repos.holding.save({
      id: 'foreign-holding-1',
      accountId: foreign.id,
      stockId: '600036.SH',
      quantity: 100,
      availableQuantity: 100,
      avgCost: money(40),
      openedAt: new Date('2026-01-05T01:00:00.000Z'),
      closedAt: null,
    });
    const denied = await service.prepare(principal, {
      id: randomUUID(),
      tool: 'close_holding',
      input: { holdingId: 'foreign-holding-1' },
    });
    expect(denied.ok).toBe(false);
    expect((await ctx.repos.holding.findById('foreign-holding-1'))?.closedAt).toBeNull();
    service.dispose();
  });

  it('create_portfolio_cash_flow: writes once, replays the same receipt, moves cash and digest', async () => {
    const ctx = await buildTestContext();
    const principal = principalOf(ctx);
    const service = serviceFor(ctx);
    const before = await ctx.repos.account.findById(principal.accountId);
    if (before === null) throw new Error('fixture account missing');
    const beforeDigest = await digestOf(ctx, principal.accountId);

    const prepared = await prepare(service, principal, 'create_portfolio_cash_flow', {
      occurredAt: '2026-07-01T02:00:00.000Z',
      kind: 'deposit',
      amount: 50_000,
      note: '工资入金',
    });
    expect(prepared.input).toMatchObject({
      accountId: principal.accountId,
      kind: 'deposit',
      amount: 50_000,
      currency: 'CNY',
      note: '工资入金',
    });
    expect(await ctx.repos.portfolioCashFlow.listByAccount(principal.accountId)).toHaveLength(0);

    const first = await confirm(service, principal, prepared);
    expect(first.state).toBe('succeeded');
    expect((await ctx.repos.portfolioCashFlow.listByAccount(principal.accountId)).length).toBe(1);
    expect((await ctx.repos.account.findById(principal.accountId))?.cashBalance).toBe(
      before.cashBalance + 50_000,
    );
    const afterDigest = await digestOf(ctx, principal.accountId);
    expect(afterDigest).not.toBe(beforeDigest);

    const replay = await confirm(service, principal, prepared);
    expect(replay.state).toBe('succeeded');
    expect(replay.result).toEqual(first.result);
    expect((await ctx.repos.portfolioCashFlow.listByAccount(principal.accountId)).length).toBe(1);
    expect((await ctx.repos.account.findById(principal.accountId))?.cashBalance).toBe(
      before.cashBalance + 50_000,
    );
    expect(await digestOf(ctx, principal.accountId)).toBe(afterDigest);
    service.dispose();
  });
});
