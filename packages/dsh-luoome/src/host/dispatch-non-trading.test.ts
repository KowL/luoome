import type { Context } from '@deepseek-ai/cordis';
import { MessageId } from '@deepseek-ai/dsh-llm/brand';
import { type ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { PluginAutomationGrant } from '@luoome/core';
import { createPluginOperationService, pluginInputHash, pluginInputJson } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { scheduledOperationFixture } from '../testing/dsh-host.js';
import { createDshIdentity, dshScheduleHash } from './dsh-identity.js';
import { createScheduleDispatcher } from './schedule-dispatcher.js';

/**
 * REQ-M4-06 ⑤：**非交易日派发 `skipped`，且事实表零写入**。
 *
 * ## 为什么这条才是真正防事故的
 *
 * 「返回 skipped」容易做到；**「skipped 的同时真的没写」只有 dump 对比能证明**。
 * 「返回 skipped 但偷偷写了数据」是可能发生的——本次会话的教训（记录 ≠ 断言）同样适用。
 *
 * ## fixture 为什么能造（不是等真实非交易日）
 *
 * - `lastDelivery` 是 `ScheduleCatalogEntry` 的**数据字段**，塞进去即可
 * - 交易日判断由 `isTradingDay()` 注入，不需要真的等到周末
 *
 * 两个都是「字段组合」，不是「外部条件」。
 */
const setup = async (options: { isTradingDay: boolean }) => {
  const domain = await buildTestContext();
  const principal = { userId: 'owner', accountId: domain.user.defaultAccountId };
  const now = Date.now();
  const { policy, batch } = scheduledOperationFixture();
  const input = { accountId: principal.accountId, label: 'non-trading-day' };
  const task: ScheduleCatalogEntry = {
    id: ScheduleId('schedule-non-trading'),
    sessionId: SessionId('session-non-trading'),
    kind: 'cron',
    title: 'non trading day',
    prompt: 'should be skipped',
    expression: '0 18 * * 1-5',
    timeZone: 'Asia/Shanghai',
    status: 'active',
    scheduledAt: new Date(now + 60_000).toISOString(),
    lastDelivery: {
      scheduledAt: new Date(now - 1000).toISOString(),
      deliveredAt: new Date(now - 900).toISOString(),
      messageId: MessageId('message-non-trading'),
    },
  };
  const tasks = [task];
  const listeners: (() => void)[] = [];
  const ctx = {
    schedule: { catalog: async () => tasks },
    on: (name: string, run: () => void) => {
      if (name === 'schedule/changed') listeners.push(run);
      return () => undefined;
    },
  } as unknown as Context;

  const identity = createDshIdentity(ctx, {
    profile: 'validation',
    repository: domain.repos.pluginAuthority,
    principalForSession: () => principal,
    now: () => now,
  });
  const service = createPluginOperationService({
    repository: domain.repos.pluginAuthority,
    policies: [policy],
    capabilities: ['write', 'external'],
    policyVersion: 1,
    now: () => now,
    context: () => domain,
    validateGrant: identity.validateGrant,
  });
  const grant: PluginAutomationGrant = {
    id: `batch:${task.id}:${principal.accountId}`,
    identity: {
      userId: principal.userId,
      profile: 'validation',
      sessionId: task.sessionId,
      taskId: task.id,
    },
    scheduleHash: dshScheduleHash(task),
    version: 1,
    policyVersion: 1,
    enabled: true,
    allowedCalls: [
      {
        tool: batch.name,
        accountId: principal.accountId,
        inputJson: pluginInputJson(input),
        inputHash: pluginInputHash(input),
        capabilities: ['write', 'external'],
      },
    ],
    createdAt: now - 2000,
    updatedAt: now - 2000,
    expiresAt: now + 60_000,
  };
  await domain.repos.pluginAuthority.saveGrant(grant, null);

  const dispatcher = createScheduleDispatcher(ctx, {
    service,
    repository: domain.repos.pluginAuthority,
    identity,
    principalForSession: () => principal,
    automationTier: 'granted',
    now: () => now,
    isTradingDay: () => options.isTradingDay,
  });
  return { domain, dispatcher, listeners, task };
};

/** 业务表的完整快照：**逐字段**比较，不是「条数相同」。 */
const businessSnapshot = async (domain: Awaited<ReturnType<typeof buildTestContext>>) => {
  const accounts = await domain.repos.account.list();
  const operations = await domain.repos.pluginAuthority.listNonTerminalOperationsByAccount(
    domain.user.defaultAccountId,
  );
  return JSON.stringify({ accounts, operations });
};

describe('非交易日：skipped 且事实表零写入', () => {
  it('非交易日 reconcile → 不执行，且业务表逐字段不变', async () => {
    const { domain, dispatcher, listeners } = await setup({ isTradingDay: false });
    const before = await businessSnapshot(domain);

    // 触发一次 reconcile（模拟 schedule/changed 事件）。
    for (const run of listeners) run();
    // 等待链式 Promise 落定。
    await new Promise((done) => setTimeout(done, 200));

    const after = await businessSnapshot(domain);

    // ① 业务表**逐字段**相同（不是「条数相同」——那漏得掉内容改动）。
    expect(after).toBe(before);
    // ② 没有任何非终结 Operation 被创建（没派发就不该留 pending/executing）。
    const nonTerminal = await domain.repos.pluginAuthority.listNonTerminalOperationsByAccount(
      domain.user.defaultAccountId,
    );
    expect(nonTerminal).toEqual([]);

    dispatcher.dispose();
  });

  it('交易日对照：同样 fixture 会真的派发（证明上面那条不是恒真）', async () => {
    const { domain, dispatcher, listeners } = await setup({ isTradingDay: true });
    const before = await businessSnapshot(domain);

    for (const run of listeners) run();
    await new Promise((done) => setTimeout(done, 500));

    const after = await businessSnapshot(domain);
    // **对照组**：交易日会产生 Operation（before ≠ after）。
    // 若这条也相等，说明上面那条「不变」是因为根本没跑，而不是因为非交易日。
    expect(after).not.toBe(before);

    dispatcher.dispose();
  });
});
