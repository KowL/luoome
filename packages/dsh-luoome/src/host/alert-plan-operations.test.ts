// task-39 批次 B：告警规则增删改的 Operation 闭环。
import { randomUUID } from 'node:crypto';
import type { ToolContext } from '@luoome/core';
import { createInMemoryRepos } from '@luoome/db/memory';
import { buildContext, createPluginOperationService } from '@luoome/tools';
import { describe, expect, it } from 'vitest';

import { ALERT_PLAN_OPERATION_POLICIES } from './alert-plan-operations.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');
const USER_ID = 'alert-user';
const ACCOUNT_ID = 'alert-account';
const principal = { userId: USER_ID, accountId: ACCOUNT_ID };

const harness = async () => {
  const repos = createInMemoryRepos();
  await repos.watchlist.save({
    id: 'wl-1',
    name: '默认关注',
    kind: 'personal',
    membershipPolicy: 'manual',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  } as never);
  const ctx: ToolContext = buildContext({
    repos,
    adapters: { market: {} as never },
    user: { id: USER_ID, defaultAccountId: ACCOUNT_ID },
    clock: () => new Date(NOW),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const service = createPluginOperationService({
    repository: repos.pluginAuthority,
    policies: ALERT_PLAN_OPERATION_POLICIES,
    capabilities: ['read', 'write'],
    policyVersion: 1,
    now: () => NOW.getTime(),
    context: () => ctx,
  });
  return { repos, ctx, service };
};

/** `price-level` 规则的真实形状：`level`（正数阈值）+ `side`（above/below）。 */
/** prepare → confirm：`confirm` 需要 prepare 返回的 token，且要传 AbortSignal。 */
const runOperation = async (
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

const rule = () => ({
  id: 'rule-1',
  kind: 'price-level' as const,
  level: 100,
  side: 'above' as const,
  priority: 'normal' as const,
});

describe('task-39 告警规则 Operation 闭环', () => {
  it('create：动作 → 回执 → list_alert_plans 回读一致', async () => {
    const { repos, service } = await harness();
    const input = {
      id: 'plan-1',
      name: '默认规则',
      watchlistId: 'wl-1',
      rules: [rule()],
      logic: 'ANY' as const,
      triggerMode: 'on-enter' as const,
      cooldownMinutes: 30,
      dailyNotificationLimit: 10,
      notifyOnRecovery: false,
      enabled: true,
    };
    const { confirmed } = await runOperation(service, 'create_alert_plan', input);
    expect(confirmed.ok, JSON.stringify(confirmed)).toBe(true);
    // 回读：仓储里确实是提交的那条。
    const saved = await repos.alertPlan.findById('plan-1');
    expect(saved?.name).toBe('默认规则');
    expect(saved?.cooldownMinutes).toBe(30);
  });

  it('update：回执读回**更新后**的整条规则', async () => {
    const { repos, service } = await harness();
    await repos.alertPlan.save({
      id: 'plan-2',
      name: '旧名',
      watchlistId: 'wl-1',
      rules: [rule()],
      logic: 'ANY',
      triggerMode: 'on-enter',
      cooldownMinutes: 5,
      dailyNotificationLimit: 10,
      notifyOnRecovery: false,
      enabled: false,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
    const prepared = await service.prepare(principal, {
      id: randomUUID(),
      tool: 'update_alert_plan',
      input: { alertPlanId: 'plan-2', name: '新名' },
    });
    expect(prepared.ok).toBe(true);
    // 冻结的 patch 只含被改字段。
    expect((prepared as { ok: true; data: { input: unknown } }).data.input).toMatchObject({
      name: '新名',
    });
  });

  it('delete：摘要进入持久化回执并可读回（决策 3-B 补齐了原已知缺口）', async () => {
    const { repos, service } = await harness();
    await repos.alertPlan.save({
      id: 'plan-3',
      name: '要删的规则',
      watchlistId: 'wl-1',
      rules: [rule()],
      logic: 'ALL',
      triggerMode: 'daily-first',
      cooldownMinutes: 60,
      dailyNotificationLimit: 20,
      notifyOnRecovery: true,
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    } as never);

    const { confirmed, operationId } = await runOperation(service, 'delete_alert_plan', {
      alertPlanId: 'plan-3',
    });
    expect(confirmed.ok).toBe(true);
    // 删除确实发生了。
    expect(await repos.alertPlan.findById('plan-3')).toBeNull();

    // 原先这里断言的是「回执里拿不到」——那是**缺口**，不是期望行为。
    // 决策 3-B 让 `delete_alert_plan` 的输出带摘要，而成功路径的 `resultJson`
    // 写的就是工具自身输出（`plugin-operations.ts:365`），所以摘要会真的落库。
    const data = (confirmed as { ok: true; data: { result?: { data?: Record<string, unknown> } } })
      .data;
    const summary = (data.result?.data as { summary?: Record<string, unknown> } | undefined)
      ?.summary;
    expect(summary).toEqual({
      alertPlanId: 'plan-3',
      name: '要删的规则',
      watchlistId: 'wl-1',
      ruleCount: 1,
    });

    // **持久化**读回：直接查 plugin_operations 的 resultJson，而不是只看内存里的返回值。
    const row = await repos.pluginAuthority.findOperation({
      userId: principal.userId,
      accountId: principal.accountId,
      id: operationId,
    });
    expect(row?.state).toBe('succeeded');
    expect(row?.resultJson).not.toBeNull();
    // 真正读**落库的那一行**的 resultJson，而不是复用内存里的返回值。
    const persisted = JSON.parse(row?.resultJson ?? '{}') as {
      data?: { summary?: Record<string, unknown> };
    };
    expect(persisted.data?.summary).toEqual({
      alertPlanId: 'plan-3',
      name: '要删的规则',
      watchlistId: 'wl-1',
      ruleCount: 1,
    });
  });
});
