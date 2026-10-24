import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginAutomationGrant } from '@luoome/core';
import { createInMemoryRepos } from '@luoome/db/memory';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Call, createDshTestHost } from '../testing/dsh-host.js';
import { MANUAL_OPERATION_TOOL, SCHEDULED_OPERATION_TOOL } from './dsh-authority.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const rootDir = async () => {
  const root = await mkdtemp(join(tmpdir(), 'luoome-dsh-e2e-'));
  roots.push(root);
  return root;
};
const eventually = async (predicate: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 500; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('DSH integration did not settle');
};

const start = (root: string, options: Parameters<typeof createDshTestHost>[2] = {}) =>
  createDshTestHost(root, { repos: createInMemoryRepos(), close() {} }, options);

const fixtureClock = () => {
  let now = Date.now();
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    advance(ms: number) {
      now += ms;
    },
    restore: () => spy.mockRestore(),
  };
};
const drive = async (fixture: Awaited<ReturnType<typeof start>>) => {
  const wake = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
    prompt: 'timer recomputation',
    title: 'fixture clock drive',
    after_seconds: 3600,
  });
  await fixture.ctx.schedule.delete({ sessionId: fixture.handle.agent.id, id: wake.id });
};
const scheduledCall = (grant: PluginAutomationGrant, input: unknown): Call => {
  const [call] = grant.allowedCalls;
  if (!call) throw new Error('Missing grant fixture call');
  return {
    name: SCHEDULED_OPERATION_TOOL,
    input: {
      grantId: grant.id,
      grantVersion: grant.version,
      tool: call.tool,
      accountId: call.accountId,
      input,
    },
  };
};

describe('Node PTC approval and scheduled delivery integration', () => {
  it('runs approved and scheduled inner calls through the actual Node PTC runtime', async () => {
    const clock = fixtureClock();
    const fixture = await start(await rootDir(), { automationsEnabled: true, ptc: true });
    try {
      const removeAnswer = fixture.answer('allowed-once');
      const task = await fixture.ctx.schedule.create(fixture.handle.agent.id, {
        prompt: 'PTC batch',
        title: 'PTC',
        every_seconds: 60,
      });
      const input = { accountId: fixture.principal.accountId, label: 'PTC' };
      const grant = fixture.grant(task, input);
      const result = await fixture.run({
        name: MANUAL_OPERATION_TOOL,
        input: {
          id: randomUUID(),
          tool: 'configure_plugin_automation',
          input: { grant, expectedVersion: null },
        },
      });
      expect(result?.isError, result?.diagnostic).toBe(false);
      expect(result?.value).toMatchObject({ result: { ok: true, data: { state: 'succeeded' } } });
      const before = fixture.results.length;
      const args = JSON.stringify(scheduledCall(grant, input).input);
      fixture.model.calls.push(
        [
          {
            name: 'run_code',
            input: {
              description: 'repeat one delivered PTC operation',
              code: `return [await tools.${SCHEDULED_OPERATION_TOOL}(${args}), await tools.${SCHEDULED_OPERATION_TOOL}(${args})];`,
            },
          },
        ],
        [],
      );
      clock.advance(65_000);
      await drive(fixture);
      await eventually(() => fixture.results.length >= before + 3);
      await fixture.handle.agent.whenIdle();
      expect(fixture.results.at(-1)?.value).toMatchObject({
        result: [
          { ok: true, data: { state: 'succeeded' } },
          { ok: true, data: { state: 'succeeded' } },
        ],
      });
      expect(
        (await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name.match(
          /\|PTC/g,
        ),
      ).toHaveLength(1);
      expect(fixture.approvals).toEqual(['allowed-once']);
      const replay = await fixture.run(scheduledCall(grant, input));
      expect(replay?.isError).toBe(true);
      removeAnswer();
      fixture.answer('rejected');
      const rejected = await fixture.run({
        name: MANUAL_OPERATION_TOOL,
        input: {
          id: randomUUID(),
          tool: 'configure_plugin_automation',
          input: { grant: { ...grant, version: 2 }, expectedVersion: 1 },
        },
      });
      expect(rejected?.isError).toBe(true);
      expect(
        (await fixture.db.repos.pluginAuthority.findGrant(grant.id, fixture.principal.userId))
          ?.version,
      ).toBe(1);
      expect(
        (await fixture.domain.repos.account.findById(fixture.principal.accountId))?.name.match(
          /\|PTC/g,
        ),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
      clock.restore();
    }
  }, 20_000);
});
