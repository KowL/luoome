import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginAutomationGrant, PluginOperation, PluginOperationProof } from '@luoome/core';
import { createDrizzleRepos, ensureSchema } from '../../client.js';
import { createInMemoryRepos } from '../memory/index.js';

const identity = { userId: 'u', profile: 'p', sessionId: 's', taskId: 't' };
const operation = (id = 'op'): PluginOperation => ({
  id,
  userId: 'u',
  accountId: 'a',
  tool: 'batch',
  inputJson: '{}',
  inputHash: 'a'.repeat(64),
  policyVersion: 1,
  requiredCapabilities: ['write', 'external'],
  authorization: { kind: 'human', tokenHash: 'b'.repeat(64) },
  state: 'pending',
  claimToken: null,
  resultJson: null,
  createdAt: 100,
  updatedAt: 100,
  expiresAt: 1000,
});
const proof = (id = 'op'): PluginOperationProof & { claimToken: string } => ({
  id,
  userId: 'u',
  accountId: 'a',
  now: 200,
  policyVersion: 1,
  claimToken: 'claim',
  authorization: { kind: 'human', tokenHash: 'b'.repeat(64) },
});
const grant = (): PluginAutomationGrant => ({
  id: 'grant',
  identity: { ...identity },
  scheduleHash: 'd'.repeat(64),
  version: 1,
  policyVersion: 1,
  enabled: true,
  allowedCalls: [
    {
      tool: 'batch',
      accountId: 'a',
      inputHash: 'a'.repeat(64),
      inputJson: '{}',
      capabilities: ['write', 'external'],
    },
  ],
  createdAt: 100,
  updatedAt: 100,
  expiresAt: 1000,
});

for (const mode of ['memory', 'drizzle'] as const) {
  const setup = () => {
    const handle = mode === 'drizzle' ? createDrizzleRepos(':memory:') : null;
    return {
      repo: (handle?.repos ?? createInMemoryRepos()).pluginAuthority,
      close: () => handle?.close(),
    };
  };
  describe(`PluginAuthorityRepository [${mode}]`, () => {
    it('claims once, fences stale settlement and retains terminal receipts', async () => {
      const { repo, close } = setup();
      try {
        expect(await repo.insertOperation(operation())).toBe(true);
        expect(await repo.insertOperation({ ...operation(), inputHash: 'c'.repeat(64) })).toBe(
          false,
        );
        const claims = await Promise.all([
          repo.claimOperation(proof()),
          repo.claimOperation({ ...proof(), claimToken: 'other' }),
        ]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(
          await repo.settleOperation({
            ...proof(),
            claimToken: 'stale',
            state: 'succeeded',
            resultJson: '{}',
          }),
        ).toBe(false);
        expect(await repo.settleOperation({ ...proof(), state: 'unknown', resultJson: null })).toBe(
          true,
        );
        expect(await repo.claimOperation(proof())).toBe(null);
        expect(
          await repo.settleOperation({ ...proof(), state: 'succeeded', resultJson: '{"ok":true}' }),
        ).toBe(true);
        expect(await repo.settleOperation({ ...proof(), state: 'unknown', resultJson: null })).toBe(
          false,
        );
        expect((await repo.findOperation(proof()))?.state).toBe('succeeded');
      } finally {
        close();
      }
    });
    it('rejects cross-account, cross-user, expired, forged and outdated confirmations', async () => {
      const { repo, close } = setup();
      try {
        await repo.insertOperation(operation());
        for (const patch of [
          { accountId: 'other' },
          { userId: 'other' },
          { now: 1000 },
          { now: 99 },
          { policyVersion: 2 },
          { authorization: { kind: 'human' as const, tokenHash: 'wrong' } },
        ]) {
          expect(await repo.claimOperation({ ...proof(), ...patch })).toBe(null);
          expect(await repo.cancelOperation({ ...proof(), ...patch })).toBe(false);
        }
        expect(await repo.findOperation({ ...proof(), accountId: 'other' })).toBe(null);
        expect(await repo.cancelOperation(proof())).toBe(true);
        expect(await repo.claimOperation(proof())).toBe(null);
      } finally {
        close();
      }
    });
    it('binds scheduled claims to task identity, exact input, capabilities and current grant version', async () => {
      const { repo, close } = setup();
      try {
        await repo.saveGrant(grant(), null);
        const op: PluginOperation = {
          ...operation(),
          authorization: { kind: 'schedule', grantId: 'grant', grantVersion: 1 },
        };
        await repo.insertOperation(op);
        const scheduled = { ...proof(), authorization: { kind: 'schedule' as const, identity } };
        expect(await repo.claimOperation(proof())).toBe(null);
        for (const patch of [
          { userId: 'other' },
          { taskId: 'other' },
          { profile: 'other' },
          { sessionId: 'other' },
        ])
          expect(
            await repo.claimOperation({
              ...scheduled,
              authorization: { kind: 'schedule', identity: { ...identity, ...patch } },
            }),
          ).toBe(null);
        for (const patch of [
          { inputHash: 'c'.repeat(64) },
          { accountId: 'other' },
          { tool: 'other' },
        ]) {
          const bad = { ...op, ...patch, id: JSON.stringify(patch) };
          await repo.insertOperation(bad);
          expect(
            await repo.claimOperation({ ...scheduled, id: bad.id, accountId: bad.accountId }),
          ).toBe(null);
        }
        expect(await repo.saveGrant({ ...grant(), id: 'duplicate' }, null)).toBe(false);
        expect(
          await repo.saveGrant({ ...grant(), version: 2, enabled: false, updatedAt: 201 }, 1),
        ).toBe(true);
        expect(await repo.saveGrant({ ...grant(), version: 2, updatedAt: 202 }, 1)).toBe(false);
        expect(await repo.claimOperation({ ...scheduled, now: 202 })).toBe(null);
        const [call] = grant().allowedCalls;
        if (!call) throw new Error('Missing grant fixture call');
        const next = {
          ...grant(),
          version: 3,
          updatedAt: 203,
          allowedCalls: [{ ...call, capabilities: ['write' as const] }],
        };
        await repo.saveGrant(next, 2);
        await repo.insertOperation({
          ...op,
          id: 'missing-external',
          authorization: { kind: 'schedule', grantId: 'grant', grantVersion: 3 },
        });
        expect(await repo.claimOperation({ ...scheduled, id: 'missing-external', now: 204 })).toBe(
          null,
        );
      } finally {
        close();
      }
    });
    it('does not allow caller mutation to change persisted authorization', async () => {
      const { repo, close } = setup();
      try {
        const input = grant();
        await repo.saveGrant(input, null);
        input.identity.taskId = 'changed';
        const saved = await repo.findGrant('grant', 'u');
        if (!saved) throw new Error('Missing persisted grant fixture');
        saved.allowedCalls.length = 0;
        expect((await repo.findGrant('grant', 'u'))?.identity.taskId).toBe('t');
        expect((await repo.findGrant('grant', 'u'))?.allowedCalls).toHaveLength(1);
      } finally {
        close();
      }
    });
  });
}

it('persists across reopen, migrates twice and arbitrates two database connections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-authority-'));
  const file = join(dir, 'test.db');
  let first = createDrizzleRepos(file);
  let second: ReturnType<typeof createDrizzleRepos> | undefined;
  try {
    await first.repos.pluginAuthority.saveGrant(grant(), null);
    await first.repos.pluginAuthority.insertOperation(operation());
    first.close();
    first = createDrizzleRepos(file);
    ensureSchema(first.db);
    ensureSchema(first.db);
    second = createDrizzleRepos(file);
    const claims = await Promise.all([
      first.repos.pluginAuthority.claimOperation(proof()),
      second.repos.pluginAuthority.claimOperation({ ...proof(), claimToken: 'second' }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await second.repos.pluginAuthority.findOperation(proof()))?.state).toBe('executing');
    expect(await second.repos.pluginAuthority.findGrant('grant', 'u')).toEqual(grant());
  } finally {
    second?.close();
    first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
