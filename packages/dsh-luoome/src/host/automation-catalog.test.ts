import { type ScheduleCatalogEntry, ScheduleId } from '@deepseek-ai/dsh-schedule';
import { SessionId } from '@deepseek-ai/dsh-session';
import { pluginInputHash, pluginInputJson } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { createAutomationCatalog } from './automation-catalog.js';
import { createBatchOperationPolicies } from './batch-operations.js';
import { dshScheduleHash } from './dsh-identity.js';

describe('host automation catalog', () => {
  it('returns exact current hashes and canonical account calls without changing schedules or grants', async () => {
    const ctx = await buildTestContext();
    const principal = { userId: ctx.user.id, accountId: ctx.user.defaultAccountId };
    const task: ScheduleCatalogEntry = {
      id: ScheduleId('schedule-existing'),
      sessionId: SessionId('session-existing'),
      kind: 'cron',
      expression: '0 9 * * 1-5',
      timeZone: 'Asia/Shanghai',
      title: '已有盘中任务',
      prompt: '调用旧批处理',
      status: 'active',
      scheduledAt: '2026-10-26T01:00:00.000Z',
    };
    const tasks = [
      task,
      { ...task, id: ScheduleId('schedule-foreign'), sessionId: SessionId('session-foreign') },
    ];
    const read = createAutomationCatalog({
      profile: 'test',
      policyVersion: 1,
      repository: ctx.repos.pluginAuthority,
      policies: createBatchOperationPolicies(),
      context: () => ctx,
      tasks: async () => tasks,
      principalForSession: (id) => (id === task.sessionId ? principal : null),
    });
    const before = JSON.stringify(tasks);
    const result = await read(principal);
    expect(result.total).toBe(1);
    expect(result.tasks[0]).toMatchObject({
      task,
      scheduleHash: dshScheduleHash(task),
      existingGrant: null,
    });
    expect(result.allowedCalls).toHaveLength(5);
    for (const call of result.allowedCalls) {
      expect(call.accountId).toBe(principal.accountId);
      expect(call.inputJson).toBe(pluginInputJson({ accountId: principal.accountId }));
      expect(call.inputHash).toBe(pluginInputHash({ accountId: principal.accountId }));
      expect(call.capabilities).toEqual(['write', 'external']);
    }
    expect(JSON.stringify(tasks)).toBe(before);
    const changed = { ...task, prompt: '原生授权后再调用' };
    tasks[0] = changed;
    expect((await read(principal)).tasks[0]?.scheduleHash).not.toBe(result.tasks[0]?.scheduleHash);
  });
});
