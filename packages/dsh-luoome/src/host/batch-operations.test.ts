import { randomUUID } from 'node:crypto';
import { createPluginOperationService } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';
import { createBatchOperationPolicies } from './batch-operations.js';
import { createProductionOperationPolicies } from './production.js';
import { resolveProductionConfigFromEnv } from './production-config.js';

describe('native batch policies', () => {
  it('keeps batch and automation disabled until trusted configuration opts in', () => {
    const env = { LUOOME_OWNER_USER_ID: 'owner', LUOOME_OWNER_ACCOUNT_ID: 'account' };
    expect(resolveProductionConfigFromEnv(env)).toMatchObject({
      batchEnabled: false,
      automationsEnabled: false,
    });
    expect(() =>
      resolveProductionConfigFromEnv({ ...env, LUOOME_AUTOMATIONS_ENABLED: 'true' }),
    ).toThrow();
    expect(
      resolveProductionConfigFromEnv({
        ...env,
        LUOOME_BATCH_ENABLED: 'true',
        LUOOME_AUTOMATIONS_ENABLED: 'true',
      }),
    ).toMatchObject({ batchEnabled: true, automationsEnabled: true });
    expect(createProductionOperationPolicies()).toHaveLength(29);
    const policies = createProductionOperationPolicies(undefined, { batchEnabled: true });
    expect(policies).toHaveLength(34);
    expect(policies.filter((policy) => policy.scheduled)).toHaveLength(5);
  });

  it('freezes only the current account and rejects cross-account or undeclared parameters', async () => {
    const ctx = await buildTestContext();
    const principal = { userId: ctx.user.id, accountId: ctx.user.defaultAccountId };
    for (const policy of createBatchOperationPolicies()) {
      expect(policy.tool.requiredCapabilities).toEqual(['write', 'external']);
      expect(await policy.bind({}, principal, randomUUID(), ctx)).toEqual({
        accountId: principal.accountId,
      });
      expect(await policy.bind({ force: true }, principal, randomUUID(), ctx)).toEqual({
        accountId: principal.accountId,
        force: true,
      });
      await expect(
        policy.bind({ accountId: 'other-account' }, principal, randomUUID(), ctx),
      ).rejects.toThrow();
      await expect(policy.bind({ approved: true }, principal, randomUUID(), ctx)).rejects.toThrow();
      expect(await policy.receipt({}, ctx)).toBeNull();
    }
  });

  it('cannot prepare a batch with write authority alone', async () => {
    const ctx = await buildTestContext();
    const service = createPluginOperationService({
      repository: ctx.repos.pluginAuthority,
      policies: createBatchOperationPolicies(),
      capabilities: ['read', 'write'],
      policyVersion: 1,
      now: Date.now,
      context: () => ctx,
    });
    expect(
      await service.prepare(
        { userId: ctx.user.id, accountId: ctx.user.defaultAccountId },
        { id: randomUUID(), tool: 'run_intraday_plan_batch', input: {} },
      ),
    ).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });
    service.dispose();
  });
});
