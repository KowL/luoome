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

const setup = async (options: { automationsEnabled?: boolean } = {}) => {
  const domain = await buildTestContext();
  const principal = { userId: 'owner', accountId: domain.user.defaultAccountId };
  const now = Date.now();
  const task: ScheduleCatalogEntry = {
    id: ScheduleId('schedule-host-callback'),
    sessionId: SessionId('session-host-callback'),
    kind: 'cron',
    title: 'host callback',
    prompt: 'no model call required',
    expression: '0 18 * * 1-5',
    timeZone: 'Asia/Shanghai',
    status: 'active',
    scheduledAt: new Date(now + 60_000).toISOString(),
    lastDelivery: {
      scheduledAt: new Date(now - 1000).toISOString(),
      deliveredAt: new Date(now - 900).toISOString(),
      messageId: MessageId('delivery-1'),
    },
  };
  const tasks = [task];
  const listeners = new Set<() => void>();
  const ctx = {
    schedule: { catalog: async () => tasks },
    on: (name: string, listener: () => void) => {
      if (name === 'schedule/changed') listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Context;
  const { batch, policy } = scheduledOperationFixture();
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
  const input = { accountId: principal.accountId, label: 'host-callback' };
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
    policies: [policy],
    principalForSession: () => principal,
    automationsEnabled: options.automationsEnabled ?? true,
    now: () => now,
  });
  return { domain, principal, task, tasks, listeners, grant, dispatcher, service };
};

describe('schedule dispatcher', () => {
  it('executes a durable delivery without a model and deduplicates scans and restart', async () => {
    const fixture = await setup();
    try {
      const before = (await fixture.domain.repos.account.findById(fixture.principal.accountId))
        ?.name;
      await fixture.dispatcher.reconcile();
      const after = (await fixture.domain.repos.account.findById(fixture.principal.accountId))
        ?.name;
      expect(after).toBe(`${before}|host-callback`);
      await fixture.dispatcher.reconcile();
      expect((await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name).toBe(
        after,
      );
      fixture.dispatcher.dispose();
      const restarted = createScheduleDispatcher(
        {
          schedule: { catalog: async () => fixture.tasks },
          on: () => () => undefined,
        } as unknown as Context,
        {
          service: fixture.service,
          repository: fixture.domain.repos.pluginAuthority,
          identity: createDshIdentity(
            { schedule: { catalog: async () => fixture.tasks } } as unknown as Context,
            {
              profile: 'validation',
              repository: fixture.domain.repos.pluginAuthority,
              principalForSession: () => fixture.principal,
              now: Date.now,
            },
          ),
          policies: [scheduledOperationFixture().policy],
          principalForSession: () => fixture.principal,
          automationsEnabled: true,
          now: Date.now,
        },
      );
      await restarted.reconcile();
      expect((await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name).toBe(
        after,
      );
      restarted.dispose();
    } finally {
      fixture.dispatcher.dispose();
      fixture.service.dispose();
    }
  });

  it('does not execute when automations are disabled', async () => {
    const fixture = await setup({ automationsEnabled: false });
    try {
      const before = (await fixture.domain.repos.account.findById(fixture.principal.accountId))
        ?.name;
      await fixture.dispatcher.reconcile();
      expect((await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name).toBe(
        before,
      );
    } finally {
      fixture.dispatcher.dispose();
      fixture.service.dispose();
    }
  });

  it('does not execute with a changed task hash or a force input', async () => {
    const fixture = await setup();
    try {
      const before = (await fixture.domain.repos.account.findById(fixture.principal.accountId))
        ?.name;
      fixture.tasks[0] = { ...fixture.task, prompt: 'changed after authorization' };
      await fixture.dispatcher.reconcile();
      expect((await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name).toBe(
        before,
      );
      fixture.tasks[0] = fixture.task;
      const forced = {
        ...fixture.grant,
        version: 2,
        allowedCalls: fixture.grant.allowedCalls.map((call) => ({
          ...call,
          inputJson: JSON.stringify({ accountId: fixture.principal.accountId, force: true }),
        })),
      };
      await fixture.domain.repos.pluginAuthority.saveGrant(forced, 1);
      await fixture.dispatcher.reconcile();
      expect((await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name).toBe(
        before,
      );
    } finally {
      fixture.dispatcher.dispose();
      fixture.service.dispose();
    }
  });
});
