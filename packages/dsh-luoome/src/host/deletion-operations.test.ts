// 决策 3-C / 外部评审①：删除类工具的 Operation 接入。
//
// 关键边界（Codex 明确要求验收）：
// **删除后回执写入中断时保持 `unknown`；不能仅凭「对象不存在」认定本次成功，也不能自动重删。**
// Operation 与业务写入目前不是同一事务，所以这个边界必须被测试覆盖。
import { randomUUID } from 'node:crypto';
import type { Advice } from '@luoome/core';
import { STANDARD_DISCLAIMERS } from '@luoome/core';
import { createInMemoryRepos } from '@luoome/db/memory';
import { buildContext, createPluginOperationService, createStrategyTool } from '@luoome/tools';
import { describe, expect, it, vi } from 'vitest';
import { DELETION_OPERATION_POLICIES } from './deletion-operations.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');
const USER_ID = 'del-user';
const ACCOUNT_ID = 'del-account';
const principal = { userId: USER_ID, accountId: ACCOUNT_ID };

const harness = async () => {
  const repos = createInMemoryRepos();
  const ctx = buildContext({
    repos,
    adapters: { market: {} as never },
    user: { id: USER_ID, defaultAccountId: ACCOUNT_ID },
    clock: () => new Date(NOW),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const service = createPluginOperationService({
    repository: repos.pluginAuthority,
    policies: DELETION_OPERATION_POLICIES,
    capabilities: ['read', 'write'],
    policyVersion: 1,
    now: () => NOW.getTime(),
    context: () => ctx,
  });
  return { repos, ctx, service };
};

const run = async (
  service: Awaited<ReturnType<typeof harness>>['service'],
  tool: string,
  input: unknown,
) => {
  const operationId = randomUUID();
  const prepared = await service.prepare(principal, { id: operationId, tool, input });
  if (!prepared.ok) throw new Error(`prepare failed: ${JSON.stringify(prepared.error)}`);
  const data = (prepared as { ok: true; data: Record<string, unknown> }).data;
  const confirmed = await service.confirm(
    principal,
    { id: operationId, token: String(data.confirmationToken) },
    new AbortController().signal,
  );
  return { operationId, prepared: data, confirmed };
};

const adviceFixture = (id: string, subjectId: string): Advice =>
  ({
    id,
    subjectKind: 'stock',
    subjectId,
    decision: 'watch',
    confidence: 50,
    horizon: 'short',
    reasoning: { premise: '观察', evidence: ['行情'], counterEvidence: ['量能未知'] },
    risks: ['信息有限'],
    disclaimers: STANDARD_DISCLAIMERS,
    basedOn: { dataAsOf: NOW },
    validFrom: NOW,
    validUntil: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
  }) as Advice;

describe('删除类工具的 Operation 接入（决策 3-C）', () => {
  it('delete_strategy：prepare 冻结 → 执行 → 回执落库可读回摘要', async () => {
    const { repos, ctx, service } = await harness();
    await createStrategyTool.execute(
      { id: 'del-me', name: '待删策略', description: '验证回执' },
      ctx,
    );

    const { operationId, confirmed } = await run(service, 'delete_strategy', {
      strategyId: 'del-me',
    });
    expect(confirmed.ok).toBe(true);
    // 业务确实删除。
    expect(await repos.strategy.findById('del-me')).toBeNull();

    // ① 落库读回：查的是 plugin_operations 那一行，不是内存返回值。
    const row = await repos.pluginAuthority.findOperation({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      id: operationId,
    });
    expect(row?.state).toBe('succeeded');
    const persisted = JSON.parse(row?.resultJson ?? '{}') as {
      data?: { summary?: Record<string, unknown> };
    };
    expect(persisted.data?.summary).toMatchObject({
      strategyId: 'del-me',
      name: '待删策略',
      versionCount: 0,
      notCounted: ['schedules', 'evaluationStates'],
    });
  });

  it('delete_advice：批量逐项结果（deleted[] / notFound[]）进回执', async () => {
    const { repos, service } = await harness();
    const hit = adviceFixture('adv-hit', '600519.SH');
    await repos.advice.save(hit);

    const { operationId, confirmed } = await run(service, 'delete_advice', {
      ids: ['adv-hit', 'adv-missing'],
    });
    expect(confirmed.ok).toBe(true);

    const row = await repos.pluginAuthority.findOperation({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      id: operationId,
    });
    const persisted = JSON.parse(row?.resultJson ?? '{}') as {
      data?: { deleted?: unknown[]; notFound?: unknown[] };
    };
    // 逐项结果必须完整落库：既能看出删了哪条，也能看出哪条没命中。
    expect(persisted.data?.deleted).toEqual([
      expect.objectContaining({ adviceId: 'adv-hit', subjectId: '600519.SH' }),
    ]);
    expect(persisted.data?.notFound).toEqual([{ id: 'adv-missing', reason: 'not-found' }]);
  });

  it('重复请求（同一 operationId 重放）不产生第二次删除', async () => {
    const { repos, ctx, service } = await harness();
    await createStrategyTool.execute(
      { id: 'del-once', name: '只删一次', description: '验证幂等' },
      ctx,
    );
    const operationId = randomUUID();
    const prepared = await service.prepare(principal, {
      id: operationId,
      tool: 'delete_strategy',
      input: { strategyId: 'del-once' },
    });
    if (!prepared.ok) throw new Error('prepare failed');
    const data = (prepared as { ok: true; data: Record<string, unknown> }).data;
    const removeSpy = vi.spyOn(repos.strategy, 'remove');

    const first = await service.confirm(
      principal,
      { id: operationId, token: String(data.confirmationToken) },
      new AbortController().signal,
    );
    expect(first.ok).toBe(true);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    // 重放：已终结的 Operation 直接返回既有结果，**不再执行业务**。
    const replay = await service.confirm(
      principal,
      { id: operationId, token: String(data.confirmationToken) },
      new AbortController().signal,
    );
    expect(replay.ok).toBe(true);
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  // ── 最关键的一条：回执写入中断 ──
  it('业务删除成功但回执落库失败 → 不判成功、不自动重删', async () => {
    const { repos, ctx, service } = await harness();
    await createStrategyTool.execute(
      { id: 'del-orphan', name: '回执丢失', description: '验证 unknown 边界' },
      ctx,
    );
    const operationId = randomUUID();
    const prepared = await service.prepare(principal, {
      id: operationId,
      tool: 'delete_strategy',
      input: { strategyId: 'del-orphan' },
    });
    if (!prepared.ok) throw new Error('prepare failed');
    const data = (prepared as { ok: true; data: Record<string, unknown> }).data;

    // 只让 settle 的**第一次**调用失败（模拟回执写入中断）。
    // 用「首次失败、之后放行」的包装，而不是 mockRejectedValue：后者会让
    // 「失败后再写一次并强行标成功」这种伪造也一起失败，从而掩盖掉要抓的形态。
    const realSettle = repos.pluginAuthority.settleOperation.bind(repos.pluginAuthority);
    let settleCalls = 0;
    vi.spyOn(repos.pluginAuthority, 'settleOperation').mockImplementation(async (input) => {
      settleCalls += 1;
      if (settleCalls === 1) throw new Error('disk full');
      return realSettle(input);
    });
    const removeSpy = vi.spyOn(repos.strategy, 'remove');

    const result = await service.confirm(
      principal,
      { id: operationId, token: String(data.confirmationToken) },
      new AbortController().signal,
    );

    // 业务**确实**删了（这就是「不是同一事务」的现实）。
    expect(await repos.strategy.findById('del-orphan')).toBeNull();
    // 但结果不能宣布成功：`confirm` 返回错误，而不是 ok:true。
    expect(result.ok).toBe(false);
    // 精确断言（实测值）：claim 成功但 settle 失败 → 停在 `executing`，
    // 即「已受理、结果未明」。这正是用户该看到的：不要重复提交，需要 reconcile 核对。
    const row = await repos.pluginAuthority.findOperation({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      id: operationId,
    });
    expect(row?.state).toBe('executing');
    expect(row?.claimToken).not.toBeNull();
    expect(row?.resultJson ?? null).toBeNull();
    // 不自动重删：业务删除只发生一次。
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('已终结的 Operation 重放不产生第二次删除', async () => {
    const { repos, ctx, service } = await harness();
    await createStrategyTool.execute(
      { id: 'del-once', name: '只删一次', description: '验证幂等' },
      ctx,
    );
    const operationId = randomUUID();
    const prepared = await service.prepare(principal, {
      id: operationId,
      tool: 'delete_strategy',
      input: { strategyId: 'del-once' },
    });
    if (!prepared.ok) throw new Error('prepare failed');
    const data = (prepared as { ok: true; data: Record<string, unknown> }).data;
    const removeSpy = vi.spyOn(repos.strategy, 'remove');

    const first = await service.confirm(
      principal,
      { id: operationId, token: String(data.confirmationToken) },
      new AbortController().signal,
    );
    expect(first.ok).toBe(true);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    const replay = await service.confirm(
      principal,
      { id: operationId, token: String(data.confirmationToken) },
      new AbortController().signal,
    );
    expect(replay.ok).toBe(true);
    // 重放不再执行业务。
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('不能仅凭「对象不存在」认定成功（reconcile 前不猜）', async () => {
    const { repos, ctx, service } = await harness();
    await createStrategyTool.execute(
      { id: 'del-guess', name: '不许猜', description: '验证不猜测' },
      ctx,
    );
    const operationId = randomUUID();
    const prepared = await service.prepare(principal, {
      id: operationId,
      tool: 'delete_strategy',
      input: { strategyId: 'del-guess' },
    });
    if (!prepared.ok) throw new Error('prepare failed');
    const data = (prepared as { ok: true; data: Record<string, unknown> }).data;

    const settleSpy = vi
      .spyOn(repos.pluginAuthority, 'settleOperation')
      .mockRejectedValue(new Error('disk full'));
    await service.confirm(
      principal,
      { id: operationId, token: String(data.confirmationToken) },
      new AbortController().signal,
    );
    settleSpy.mockRestore();

    const row = await repos.pluginAuthority.findOperation({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      id: operationId,
    });
    // 对象已经不存在，但 Operation **不得**因此被标成 succeeded。
    expect(await repos.strategy.findById('del-guess')).toBeNull();
    // 「对象不存在」是**已知事实**，但它不是「本次操作成功」的证据——
    // 这条断言把「不许用前者推断后者」钉死：状态必须仍是未决（executing）。
    expect(row?.state).toBe('executing');
    expect(row?.resultJson ?? null).toBeNull();
  });
});

/**
 * 守卫（决策 3-C）：删除类 policy 一律 `scheduled: false`。
 *
 * 删除是用户当下的明确动作，`scheduled: true` 会把它们暴露给**自动化授权路径**
 * （定时任务可代用户删数据），那是扩大暴露面。这条守卫防止「为了省事统一打开」。
 */
describe('删除类 policy 的调度守卫', () => {
  it('所有删除 policy 都不得允许定时调用', () => {
    for (const policy of DELETION_OPERATION_POLICIES)
      expect(policy.scheduled, `${policy.tool.name} 不得 scheduled:true`).toBe(false);
  });

  it('接入的 policy 清单精确（多一个或少一个都红）', () => {
    const names = DELETION_OPERATION_POLICIES.map((policy) => policy.tool.name).sort();
    // `delete_alert_plan` 在 ALERT_PLAN_OPERATION_POLICIES 里，不在这里重复。
    // `delete_chat_session` **刻意不接入**：chat 面按 H1 决策保留不暴露
    // （见 `exposure/classify.ts:70-80`），接入会违反该决策。
    expect(names).toEqual([
      'delete_advice',
      'delete_report',
      'delete_stock_event',
      'delete_strategy',
    ]);
    for (const name of names) expect(name.startsWith('delete_')).toBe(true);
    // **H1 守卫**：`delete_chat_session` 不得出现在这里。
    // chat 面由 DSH 宿主承载，领域层 chat 工具没有插件入口
    // （`exposure/classify.ts:19-22`）。接进来等于把宿主职责往领域层搬。
    expect(names).not.toContain('delete_chat_session');
  });
});
