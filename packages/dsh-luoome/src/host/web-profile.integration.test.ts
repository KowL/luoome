import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { PluginAutomationGrantSchema } from '@luoome/core';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const diagnostic = z.object({ requests: z.number(), adviceIds: z.array(z.string()) });
const review = z.object({
  ok: z.literal(true),
  data: z.object({
    context: z.object({ contextHash: z.string() }),
    revisions: z.array(z.unknown()),
  }),
});
const operation = z.object({
  ok: z.literal(true),
  data: z
    .object({
      operationId: z.string(),
      state: z.string(),
      confirmationToken: z.string().optional(),
      input: z.object({ requestId: z.string() }).passthrough(),
    })
    .passthrough(),
});
const confirmation = z.object({
  ok: z.boolean(),
  data: z.object({ state: z.string() }).optional(),
});

const repo = resolve(import.meta.dirname, '../../../..');
const roots: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((done) => child.once('close', () => done()));
      child.kill('SIGTERM');
      await closed;
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const profile = async (kind: string, state = 'empty') => {
  const built = spawnSync('bun', ['--no-env-file', 'infra/dsh/acceptance.ts', kind, state], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (built.status !== 0) throw new Error('Acceptance profile build failed');
  const root = built.stdout.trim();
  roots.push(root);
  return launchProfile(root);
};

const launchProfile = async (root: string) => {
  const launch = JSON.parse(await readFile(`${root}/launch.json`, 'utf8'));
  const child = spawn(process.execPath, [launch.cli, '--profile', launch.profile, ...launch.args], {
    cwd: launch.cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DSH_HOME: root,
      DSH_AGENTS_HOME: `${root}/agents`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise<number | null>((done) => child.once('close', done));
  return { root, launch, child, exited, output: () => output };
};

const loginProfile = async (fixture: Awaited<ReturnType<typeof profile>>) => {
  let startup: string | undefined;
  for (let i = 0; i < 300; i++) {
    startup = /dsh web: (\S+)/.exec(fixture.output())?.[1];
    if (startup) break;
    if (fixture.child.exitCode !== null) throw new Error('Web profile exited before ready');
    await new Promise((done) => setTimeout(done, 20));
  }
  if (!startup) throw new Error('Web profile did not become ready');
  const origin = new URL(startup).origin;
  const login = await fetch(startup, { redirect: 'manual' });
  expect(login.status).toBe(303);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Web profile did not issue signed cookie');
  const headers = { cookie, origin, 'content-type': 'application/json' };
  const remote = async (method: string, request: unknown) => {
    const response = await fetch(`${origin}/api/${method}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'client-request',
        rpcId: randomUUID(),
        method,
        payload: { args: method === 'session/list' ? { _request: request } : { request } },
      }),
    });
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value).toMatchObject({ result: { ok: true } });
    return z.object({ result: z.object({ ok: z.literal(true), value: z.unknown() }) }).parse(value)
      .result.value;
  };
  return { origin, headers, remote };
};

describe('official DSH profile lifecycle and Web carrier', () => {
  it.each([
    ['ready', 0],
    ['empty', 1],
    ['error', 2],
  ] as const)(
    'probe profile returns %s/%s with no Agent or provider',
    async (state, code) => {
      const fixture = await profile('probe', state);
      expect(await fixture.exited).toBe(code);
      expect(fixture.output().trim()).toBe(state);
    },
    30_000,
  );

  it.each([
    ['ready', 1],
    ['empty', 0],
    ['error', 0],
  ] as const)(
    'headless %s resolves %s model requests',
    async (state, count) => {
      const fixture = await profile('worker', state);
      expect(await fixture.exited).toBe(state === 'ready' ? 0 : 1);
      expect(fixture.output()).toContain(`preflight:${state}`);
      expect(fixture.output()).toContain(`model-requests:${count}`);
      expect(fixture.output()).not.toContain('did not activate');
    },
    30_000,
  );

  it('enforces real browser login, Host/Origin, bounded input and durable operation protocol', async () => {
    const fixture = await profile('web');
    let startup: string | undefined;
    for (let i = 0; i < 300; i++) {
      startup = /dsh web: (\S+)/.exec(fixture.output())?.[1];
      if (startup) break;
      if (fixture.child.exitCode !== null) throw new Error('Web profile exited before ready');
      await new Promise((done) => setTimeout(done, 20));
    }
    if (!startup) throw new Error('Web profile did not become ready');
    const origin = new URL(startup).origin;
    expect((await fetch(`${origin}/api/luoome/profile`)).status).toBe(401);
    const login = await fetch(startup, { redirect: 'manual' });
    expect(login.status).toBe(303);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('Web profile did not issue signed cookie');
    const headers = { cookie, origin, 'content-type': 'application/json' };
    const post = (path: string, body: unknown) =>
      fetch(`${origin}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const get = (path: string) => fetch(`${origin}${path}`, { headers: { cookie } });
    const metadata = await get('/api/luoome/profile');
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      profile: 'luoome-acceptance',
      automationsEnabled: false,
    });
    const forgedHost = await new Promise<number | undefined>((done, reject) => {
      const req = httpRequest(
        `${origin}/api/luoome/profile`,
        { headers: { cookie, host: 'untrusted.invalid' } },
        (res) => {
          res.resume();
          done(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(forgedHost).toBe(403);
    for (const badOrigin of [undefined, 'https://untrusted.invalid']) {
      expect(
        (
          await fetch(`${origin}/api/luoome/operations/prepare`, {
            method: 'POST',
            headers: {
              cookie,
              'content-type': 'application/json',
              ...(badOrigin ? { origin: badOrigin } : {}),
            },
            body: '{}',
          })
        ).status,
      ).toBe(403);
    }
    expect(
      (await post('/api/luoome/call', { tool: 'save_decision_review', input: {} })).status,
    ).toBe(403);
    expect(
      (
        await post('/api/luoome/operations/prepare', {
          id: randomUUID(),
          tool: 'save_decision_review',
          input: {},
          approved: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post('/api/luoome/operations/prepare', {
          id: randomUUID(),
          tool: 'save_decision_review',
          input: 'x'.repeat(65536),
        })
      ).status,
    ).toBe(413);
    const adviceIds = diagnostic.parse(
      await (await get('/api/luoome-acceptance')).json(),
    ).adviceIds;
    const subject = { kind: 'advice', id: adviceIds[0] };
    const preview = review.parse(
      await (
        await post('/api/luoome/call', { tool: 'get_decision_review_context', input: { subject } })
      ).json(),
    );
    expect(preview.ok).toBe(true);
    const input = {
      subject,
      contextHash: preview.data.context.contextHash,
      expectedRevision: 0,
      content: {
        tradeIds: [],
        adviceFeedback: null,
        triggerFeedback: null,
        note: 'real HTTP confirmation',
      },
    };
    const id = randomUUID();
    const prepared = operation.parse(
      await (
        await post('/api/luoome/operations/prepare', { id, tool: 'save_decision_review', input })
      ).json(),
    );
    expect(prepared).toMatchObject({ ok: true, data: { operationId: id, state: 'pending' } });
    const token = z.string().parse(prepared.data.confirmationToken);
    expect(typeof token).toBe('string');
    const pending = operation.parse(await (await get(`/api/luoome/operations/${id}`)).json());
    expect(pending.data).not.toHaveProperty('confirmationToken');
    expect(pending.data.input.requestId).toBe(id);
    expect((await post(`/api/luoome/operations/${id}/confirm`, { token, input: {} })).status).toBe(
      400,
    );
    expect((await post(`/api/luoome/operations/${id}/confirm`, { token: 'forged' })).status).toBe(
      403,
    );
    const confirmed = await Promise.all(
      [1, 2].map(async () =>
        confirmation.parse(
          await (await post(`/api/luoome/operations/${id}/confirm`, { token })).json(),
        ),
      ),
    );
    expect(confirmed.some((r) => r.ok && r.data?.state === 'succeeded')).toBe(true);
    const final = operation.parse(await (await get(`/api/luoome/operations/${id}`)).json());
    expect(final.data.state).toBe('succeeded');
    const after = review.parse(
      await (
        await post('/api/luoome/call', { tool: 'get_decision_review_context', input: { subject } })
      ).json(),
    );
    expect(after.data.revisions).toHaveLength(1);
    const cancelled = operation.parse(
      await (
        await post('/api/luoome/operations/prepare', {
          id: randomUUID(),
          tool: 'save_decision_review',
          input,
        })
      ).json(),
    );
    expect(
      (
        await post(`/api/luoome/operations/${cancelled.data.operationId}/cancel`, {
          token: cancelled.data.confirmationToken,
        })
      ).status,
    ).toBe(200);
    const replayCancelled = await post(
      `/api/luoome/operations/${cancelled.data.operationId}/confirm`,
      {
        token: cancelled.data.confirmationToken,
      },
    );
    expect(replayCancelled.status).toBe(200);
    expect(operation.parse(await replayCancelled.json()).data.state).toBe('cancelled');
    const unchanged = review.parse(
      await (
        await post('/api/luoome/call', { tool: 'get_decision_review_context', input: { subject } })
      ).json(),
    );
    expect(unchanged.data.revisions).toHaveLength(1);
    const candidate = z
      .object({ grantCandidate: PluginAutomationGrantSchema })
      .parse(await (await get('/api/luoome-acceptance')).json()).grantCandidate;
    const grantId = randomUUID();
    const grantPrepared = z
      .object({
        ok: z.literal(true),
        data: z.object({
          operationId: z.string(),
          confirmationToken: z.string(),
          input: z.object({ grant: PluginAutomationGrantSchema }),
        }),
      })
      .parse(
        await (
          await post('/api/luoome/operations/prepare', {
            id: grantId,
            tool: 'configure_plugin_automation',
            input: { grant: candidate, expectedVersion: null },
          })
        ).json(),
      );
    expect(grantPrepared.data.input.grant).toEqual(candidate);
    expect(
      await (
        await post(`/api/luoome/operations/${grantId}/confirm`, {
          token: grantPrepared.data.confirmationToken,
        })
      ).json(),
    ).toMatchObject({ ok: true, data: { state: 'succeeded' } });
    expect(await (await get('/api/luoome-acceptance')).json()).toMatchObject({
      configuredGrantVersion: 1,
      requests: 0,
      unscopedReadDenied: true,
    });
    expect(await (await get('/api/luoome/profile')).json()).toMatchObject({
      automationsEnabled: false,
    });
    expect(diagnostic.parse(await (await get('/api/luoome-acceptance')).json()).requests).toBe(0);
    expect(fixture.output()).not.toContain('did not activate');
  }, 30_000);

  it('uses the official SessionController for pending approval, cancellation and cold resume', async () => {
    const first = await profile('web');
    const browser = await loginProfile(first);
    const created = z
      .object({ sessionId: z.string() })
      .parse(await browser.remote('session/create', { cwd: first.launch.cwd }));
    expect(
      await browser.remote('session/prompt', {
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: JSON.stringify({ readTool: 'get_advice', input: {} }) }],
      }),
    ).toMatchObject({ accepted: true });
    let readCalls = 0;
    for (let i = 0; i < 100; i++) {
      readCalls = z
        .object({ readCalls: z.number() })
        .parse(
          await (
            await fetch(`${browser.origin}/api/luoome-acceptance`, { headers: browser.headers })
          ).json(),
        ).readCalls;
      if (readCalls === 1) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(readCalls).toBe(1);
    const id = randomUUID();
    const diagnostics = diagnostic.parse(
      await (
        await fetch(`${browser.origin}/api/luoome-acceptance`, { headers: browser.headers })
      ).json(),
    );
    const preview = review.parse(
      await (
        await fetch(`${browser.origin}/api/luoome/call`, {
          method: 'POST',
          headers: browser.headers,
          body: JSON.stringify({
            tool: 'get_decision_review_context',
            input: { subject: { kind: 'advice', id: diagnostics.adviceIds[0] } },
          }),
        })
      ).json(),
    );
    const input = {
      id,
      tool: 'save_decision_review',
      input: {
        subject: { kind: 'advice', id: diagnostics.adviceIds[0] },
        contextHash: preview.data.context.contextHash,
        expectedRevision: 0,
        content: {
          tradeIds: [],
          adviceFeedback: null,
          triggerFeedback: null,
          note: 'No attached browser answerer',
        },
      },
    };
    expect(
      await browser.remote('session/prompt', {
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: JSON.stringify(input) }],
      }),
    ).toMatchObject({ accepted: true });
    let state = '';
    for (let i = 0; i < 200; i++) {
      const response = await fetch(`${browser.origin}/api/luoome/operations/${id}`, {
        headers: browser.headers,
      });
      if (response.status === 200) state = operation.parse(await response.json()).data.state;
      if (state === 'pending') break;
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(state).toBe('pending');
    expect(await browser.remote('session/cancel', { sessionId: created.sessionId })).toMatchObject({
      accepted: true,
    });
    for (let i = 0; i < 100; i++) {
      state = operation.parse(
        await (
          await fetch(`${browser.origin}/api/luoome/operations/${id}`, {
            headers: browser.headers,
          })
        ).json(),
      ).data.state;
      if (state === 'cancelled') break;
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(state).toBe('cancelled');
    const beforeRestart = review.parse(
      await (
        await fetch(`${browser.origin}/api/luoome/call`, {
          method: 'POST',
          headers: browser.headers,
          body: JSON.stringify({
            tool: 'get_decision_review_context',
            input: { subject: input.input.subject },
          }),
        })
      ).json(),
    );
    expect(beforeRestart.data.revisions).toHaveLength(0);
    first.child.kill('SIGTERM');
    await first.exited;
    const restarted = await launchProfile(first.root);
    const resumed = await loginProfile(restarted);
    const list = z
      .object({ items: z.array(z.object({ sessionId: z.string() })) })
      .parse(await resumed.remote('session/list', {}));
    expect(list.items.some((item) => item.sessionId === created.sessionId)).toBe(true);
    expect(
      await resumed.remote('session/prompt', {
        requestId: randomUUID(),
        sessionId: created.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'resume persisted session' }],
      }),
    ).toMatchObject({ accepted: true });
    let requests = 0;
    for (let i = 0; i < 100; i++) {
      requests = diagnostic.parse(
        await (
          await fetch(`${resumed.origin}/api/luoome-acceptance`, { headers: resumed.headers })
        ).json(),
      ).requests;
      if (requests === 1) break;
      await new Promise((done) => setTimeout(done, 20));
    }
    expect(requests).toBe(1);
    expect(restarted.output()).not.toContain('did not activate');
  }, 30_000);
});
