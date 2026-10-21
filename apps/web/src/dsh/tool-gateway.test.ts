import type { AgentCallableTool, ToolError } from '@luoome/core';
import {
  PROTOCOL_VERSION,
  type ToolCall,
  WEB_FETCH_MANIFEST_ENTRY,
} from '@luoome/dsh-bridge/protocol';
import { AGENT_SCENARIOS, toolRegistry } from '@luoome/tools';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { GatewayCaller, GatewayScopeSnapshot } from './execution-scope.js';
import { type GatewayAuthorizer, ToolGateway, type ToolGatewayOptions } from './tool-gateway.js';
import { buildGatewayCallableManifest } from './tool-manifest.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const setup = (
  options: {
    execute?: AgentCallableTool['execute'];
    tools?: readonly AgentCallableTool[];
    authorize?: GatewayAuthorizer;
    admitExternal?: GatewayAuthorizer | null;
    gatewayOptions?: ToolGatewayOptions;
    scope?: Partial<GatewayScopeSnapshot>;
    abortSignal?: AbortSignal;
  } = {},
) => {
  const execute = vi.fn(
    options.execute ?? (async (input) => ({ ok: true, output: { input, quote: 12.01 } })),
  );
  const tools = options.tools ?? [
    {
      name: 'fetch_quote',
      description: 'fixture quote',
      inputSchema: z
        .object({ stockId: z.string().min(1), stockName: z.string().optional() })
        .strict(),
      execute,
    },
  ];
  const manifest = buildGatewayCallableManifest(tools, AGENT_SCENARIOS.research);
  const scope: GatewayScopeSnapshot = {
    tenantId: 'tenant-1',
    tenantGeneration: 2,
    accountId: 'account-1',
    conversationId: 'conversation-1',
    runId: 'run-1',
    runtimeInstanceId: 'runtime-1',
    sessionId: 'session-1',
    audience: 'tools',
    scenario: 'research',
    expiresAt: 10_000,
    allowedCapabilities: ['read', 'external'],
    budgetOperationId: 'existing-operation-1',
    manifestHash: manifest.manifest.manifestHash,
    ...options.scope,
  };
  let now = 1_000;
  const gateway = new ToolGateway({ clock: () => now, ...options.gatewayOptions });
  const authorize = vi.fn(options.authorize ?? (() => null));
  const admitExternal = vi.fn(options.admitExternal ?? (() => null));
  const registration = {
    scope,
    manifest,
    authorize,
    ...(options.admitExternal === null ? {} : { admitExternal }),
    ...(options.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
  };
  gateway.register(registration);
  const caller: GatewayCaller = { ...scope };
  const call: ToolCall = {
    protocolVersion: PROTOCOL_VERSION,
    runId: scope.runId,
    callId: 'call-1',
    toolName: 'fetch_quote',
    input: { stockId: '000001.SZ' },
    manifestHash: scope.manifestHash,
  };
  return {
    gateway,
    caller,
    call,
    execute,
    authorize,
    admitExternal,
    registration,
    setNow: (value: number) => {
      now = value;
    },
  };
};

const permissionDenied: ToolError = {
  kind: 'permission_denied',
  required: 'fixture current authorization',
};

describe('ToolGateway', () => {
  it('runs the supplied callable and reuses a confirmed receipt for the same call', async () => {
    const fixture = setup();
    const first = await fixture.gateway.execute(fixture.caller, fixture.call);
    expect(first).toMatchObject({
      kind: 'reply',
      replayed: false,
      reply: { ok: true, output: { quote: 12.01 } },
    });
    expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toEqual({
      ...first,
      replayed: true,
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.admitExternal).toHaveBeenCalledTimes(1);
    expect(fixture.authorize).toHaveBeenCalledTimes(3);
    expect(fixture.gateway.receipts(fixture.call.runId)).toHaveLength(1);
  });

  it('keeps native tools outside the executable business map in a combined manifest', async () => {
    const fixture = setup();
    const manifest = buildGatewayCallableManifest(
      [
        {
          name: 'fetch_quote',
          description: 'quote fixture',
          inputSchema: z.object({ stockId: z.string() }),
          execute: fixture.execute,
        },
      ],
      AGENT_SCENARIOS.research,
      [WEB_FETCH_MANIFEST_ENTRY],
    );
    const gateway = new ToolGateway({ clock: () => 1_000 });
    gateway.register({
      ...fixture.registration,
      manifest,
      scope: { ...fixture.registration.scope, manifestHash: manifest.manifest.manifestHash },
    });
    const call = { ...fixture.call, manifestHash: manifest.manifest.manifestHash };
    expect(
      await gateway.execute(fixture.caller, {
        ...call,
        toolName: 'web_fetch',
        input: { url: 'https://example.invalid/fixture' },
      }),
    ).toMatchObject({ error: { code: 'permission_denied' } });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(await gateway.execute(fixture.caller, call)).toMatchObject({
      kind: 'reply',
      reply: { ok: true },
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it('shares pending receipts for concurrent duplicates and canonicalizes input key order', async () => {
    const started = deferred<void>();
    const done = deferred<{ ok: boolean; output: unknown }>();
    const fixture = setup({
      execute: async () => {
        started.resolve();
        return done.promise;
      },
    });
    const one = fixture.gateway.execute(fixture.caller, {
      ...fixture.call,
      input: { stockId: '000001.SZ', stockName: '测试' },
    });
    await started.promise;
    const two = fixture.gateway.execute(fixture.caller, {
      ...fixture.call,
      input: { stockName: '测试', stockId: '000001.SZ' },
    });
    expect(
      await fixture.gateway.execute(fixture.caller, {
        ...fixture.call,
        input: { stockName: '测试', stockId: '000002.SZ' },
      }),
    ).toMatchObject({ error: { code: 'invalid_request' } });
    done.resolve({ ok: true, output: { observedAt: new Date('2026-10-20T01:00:00Z') } });
    const results = await Promise.all([one, two]);
    expect(results.map((result) => result.kind === 'reply' && result.replayed)).toEqual([
      false,
      true,
    ]);
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatchObject({
      reply: { output: { observedAt: '2026-10-20T01:00:00.000Z' } },
    });
  });

  it('rejects changing the input or tool under a reserved callId', async () => {
    const another = vi.fn(async () => ({ ok: true, output: {} }));
    const primary = vi.fn(async () => ({ ok: true, output: {} }));
    const fixture = setup({
      tools: [
        {
          name: 'fetch_quote',
          description: 'quote fixture',
          inputSchema: z.object({ stockId: z.string() }),
          execute: primary,
        },
        {
          name: 'search_stocks',
          description: 'search fixture',
          inputSchema: z.object({ query: z.string() }),
          execute: another,
        },
      ],
    });
    await fixture.gateway.execute(fixture.caller, fixture.call);
    for (const change of [
      { input: { stockId: '000002.SZ' } },
      { toolName: 'search_stocks', input: { query: 'fixture' } },
    ]) {
      expect(
        await fixture.gateway.execute(fixture.caller, { ...fixture.call, ...change }),
      ).toMatchObject({ kind: 'rejected', error: { code: 'invalid_request' } });
    }
    expect(primary).toHaveBeenCalledTimes(1);
    expect(another).not.toHaveBeenCalled();
  });

  it.each([
    ['tenantId', 'other'],
    ['tenantGeneration', 9],
    ['accountId', 'other'],
    ['conversationId', 'other'],
    ['runId', 'other'],
    ['runtimeInstanceId', 'other'],
    ['sessionId', 'other'],
    ['audience', 'models'],
  ] as const)(
    'rejects mismatched authenticated %s without invoking authorization or tools',
    async (key, value) => {
      const fixture = setup();
      expect(
        await fixture.gateway.execute({ ...fixture.caller, [key]: value }, fixture.call),
      ).toMatchObject({ kind: 'rejected', error: { code: 'permission_denied' } });
      expect(fixture.execute).not.toHaveBeenCalled();
      expect(fixture.authorize).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown runs/tools, expired/revoked scopes, manifest mismatch and model identity injection', async () => {
    const fixture = setup();
    for (const request of [
      { ...fixture.call, runId: 'unknown' },
      { ...fixture.call, toolName: 'settle_chat_draft' },
      { ...fixture.call, toolName: 'add_trade' },
    ])
      expect(await fixture.gateway.execute(fixture.caller, request)).toMatchObject({
        error: { code: 'permission_denied' },
      });
    expect(
      await fixture.gateway.execute(fixture.caller, {
        ...fixture.call,
        manifestHash: `sha256:${'a'.repeat(64)}`,
      }),
    ).toMatchObject({ error: { code: 'manifest_mismatch' } });
    expect(
      await fixture.gateway.execute(fixture.caller, { ...fixture.call, tenantId: 'tenant-2' }),
    ).toMatchObject({ error: { code: 'invalid_request' } });
    fixture.setNow(10_000);
    expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toMatchObject({
      error: { code: 'permission_denied' },
    });
    fixture.setNow(1_000);
    fixture.gateway.revoke(fixture.call.runId);
    expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toMatchObject({
      error: { code: 'permission_denied' },
    });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('enforces current authorization, account binding, capability opt-in and external admission', async () => {
    for (const options of [
      { authorize: () => permissionDenied },
      { admitExternal: () => permissionDenied },
      { admitExternal: null },
      { scope: { allowedCapabilities: ['read'] as const } },
    ]) {
      const fixture = setup(options);
      expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toMatchObject({
        error: { code: 'permission_denied' },
      });
      expect(fixture.execute).not.toHaveBeenCalled();
    }
    const fixture = setup({
      tools: [
        {
          name: 'get_account',
          description: 'account fixture',
          inputSchema: z.object({ accountId: z.string() }),
          execute: async () => {
            throw new Error('must not execute');
          },
        },
      ],
    });
    expect(
      await fixture.gateway.execute(fixture.caller, {
        ...fixture.call,
        toolName: 'get_account',
        input: { accountId: 'other-account' },
      }),
    ).toMatchObject({ error: { code: 'permission_denied' } });
  });

  it('rechecks live authorization for replay and after asynchronous external admission', async () => {
    let authorized = true;
    const fixture = setup({ authorize: () => (authorized ? null : permissionDenied) });
    await fixture.gateway.execute(fixture.caller, fixture.call);
    authorized = false;
    expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toMatchObject({
      error: { code: 'permission_denied' },
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    const admitted = deferred<ToolError | null>();
    const entered = deferred<void>();
    const pending = setup({
      admitExternal: () => {
        entered.resolve();
        return admitted.promise;
      },
    });
    const result = pending.gateway.execute(pending.caller, pending.call);
    await entered.promise;
    pending.setNow(10_000);
    admitted.resolve(null);
    expect(await result).toMatchObject({ error: { code: 'permission_denied' } });
    expect(pending.execute).not.toHaveBeenCalled();
  });

  it('binds the call identity even when asynchronous authorization rejects its first attempt', async () => {
    let authorized = false;
    const fixture = setup({ authorize: () => (authorized ? null : permissionDenied) });
    expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toMatchObject({
      error: { code: 'permission_denied' },
    });
    authorized = true;
    expect(
      await fixture.gateway.execute(fixture.caller, {
        ...fixture.call,
        input: { stockId: '000002.SZ' },
      }),
    ).toMatchObject({ error: { code: 'invalid_request' } });
    expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toMatchObject({
      error: { code: 'permission_denied' },
    });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.admitExternal).not.toHaveBeenCalled();
  });

  it('preserves callable business failure output and its original kind', async () => {
    const output = {
      error: { kind: 'adapter_error', adapter: 'fixture', cause: 'unavailable', recoverable: true },
    };
    const fixture = setup({ execute: async () => ({ ok: false, output }) });
    const result = await fixture.gateway.execute(fixture.caller, fixture.call);
    expect(result).toMatchObject({ kind: 'reply', reply: { ok: false, output } });
    expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toMatchObject({
      kind: 'reply',
      replayed: true,
      reply: { ok: false, output },
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft closure authoritative without executing the registered write tool or fee gate', async () => {
    const registered = toolRegistry.get('create_watchlist');
    if (registered === undefined) throw new Error('missing fixture tool');
    const businessExecute = vi.spyOn(registered, 'execute').mockImplementation(async () => {
      throw new Error('real write must remain unreachable');
    });
    try {
      const input = { name: 'fixture list', kind: 'personal', membershipPolicy: 'manual' };
      const output = {
        __luoomeDraft: true,
        draft: {
          kind: 'watchlist',
          tool: 'create_watchlist',
          input,
          summary: '待确认',
          display: { risk: '未执行' },
        },
      };
      const draftExecute = vi.fn(async () => ({ ok: true, output }));
      const fixture = setup({
        tools: [
          {
            name: 'create_watchlist',
            description: 'draft fixture',
            inputSchema: registered.inputSchema,
            execute: draftExecute,
          },
        ],
        scope: { allowedCapabilities: ['read'] },
      });
      expect(
        await fixture.gateway.execute(fixture.caller, {
          ...fixture.call,
          toolName: 'create_watchlist',
          input,
        }),
      ).toMatchObject({ kind: 'reply', reply: { ok: true, output } });
      expect(businessExecute).not.toHaveBeenCalled();
      expect(draftExecute).toHaveBeenCalledTimes(1);
      expect(fixture.admitExternal).not.toHaveBeenCalled();
    } finally {
      businessExecute.mockRestore();
    }
  });

  it('rejects invalid callable input before fee admission and preserves one parsing transform', async () => {
    const fixture = setup();
    expect(
      await fixture.gateway.execute(fixture.caller, { ...fixture.call, input: { stockId: '' } }),
    ).toMatchObject({ error: { code: 'invalid_request' } });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.admitExternal).not.toHaveBeenCalled();
    const schema = z.object({ count: z.number().transform((value) => value + 1) });
    const execute = vi.fn(async (input: unknown) => ({ ok: true, output: schema.parse(input) }));
    const transformed = setup({
      tools: [
        { name: 'search_stocks', description: 'transform fixture', inputSchema: schema, execute },
      ],
    });
    expect(
      await transformed.gateway.execute(transformed.caller, {
        ...transformed.call,
        toolName: 'search_stocks',
        input: { count: 1 },
      }),
    ).toMatchObject({ reply: { output: { count: 2 } } });
  });

  it('does not repeat execution after callable throws or returns oversized/non-JSON output', async () => {
    for (const execute of [
      async () => {
        throw new Error('secret raw provider details');
      },
      async () => ({ ok: true, output: { text: '中'.repeat(100) } }),
      async () => ({ ok: true, output: { amount: 1n } }),
    ]) {
      const fixture = setup({ execute, gatewayOptions: { maxOutputBytes: 100 } });
      const result = await fixture.gateway.execute(fixture.caller, fixture.call);
      expect(result).toMatchObject({ error: { code: 'runtime_failed' } });
      expect(JSON.stringify(result)).not.toContain('secret');
      expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toEqual(result);
      expect(fixture.execute).toHaveBeenCalledTimes(1);
    }
  });

  it('enforces date wire projection while passing raw JSON to the original callable schema', async () => {
    const inputSchema = z.object({ since: z.coerce.date() }).strict();
    const execute = vi.fn(async (input: unknown) => ({
      ok: true,
      output: inputSchema.parse(input),
    }));
    const fixture = setup({
      tools: [{ name: 'search_stocks', description: 'dated fixture', inputSchema, execute }],
    });
    for (const since of [0, null, '2026-10-20']) {
      expect(
        await fixture.gateway.execute(fixture.caller, {
          ...fixture.call,
          callId: `invalid-${since}`,
          toolName: 'search_stocks',
          input: { since },
        }),
      ).toMatchObject({ error: { code: 'invalid_request' } });
    }
    const input = { since: '2026-10-20T08:00:00+08:00' };
    expect(
      await fixture.gateway.execute(fixture.caller, {
        ...fixture.call,
        toolName: 'search_stocks',
        input,
      }),
    ).toMatchObject({ reply: { ok: true, output: { since: '2026-10-20T00:00:00.000Z' } } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(input);
  });

  it('bounds untrusted JSON, call count and run registration', async () => {
    const fixture = setup({
      gatewayOptions: { maxInputBytes: 400, maxCallsPerRun: 1, maxRuns: 1 },
    });
    expect(
      await fixture.gateway.execute(fixture.caller, {
        ...fixture.call,
        input: { stockId: 'x'.repeat(1_000) },
      }),
    ).toMatchObject({ error: { code: 'invalid_request' } });
    await fixture.gateway.execute(fixture.caller, fixture.call);
    expect(
      await fixture.gateway.execute(fixture.caller, { ...fixture.call, callId: 'second' }),
    ).toMatchObject({ error: { code: 'runtime_unavailable' } });
    expect(() => fixture.gateway.register(fixture.registration)).toThrow();
    expect(() =>
      fixture.gateway.register({
        ...fixture.registration,
        scope: { ...fixture.registration.scope, runId: 'new-run' },
      }),
    ).toThrow();
    expect(fixture.execute).toHaveBeenCalledTimes(1);
  });

  it('revokes waiting calls immediately but keeps resource ownership until the closure really settles', async () => {
    const started = deferred<void>();
    const done = deferred<{ ok: boolean; output: unknown }>();
    const controller = new AbortController();
    const fixture = setup({
      abortSignal: controller.signal,
      execute: async () => {
        started.resolve();
        return done.promise;
      },
    });
    const result = fixture.gateway.execute(fixture.caller, fixture.call);
    await started.promise;
    controller.abort();
    expect(await result).toMatchObject({ error: { code: 'cancelled' } });
    expect(await fixture.gateway.drain(fixture.call.runId, 1)).toEqual({
      drained: false,
      activeCalls: 1,
    });
    expect(fixture.gateway.release(fixture.call.runId)).toBe(false);
    expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toMatchObject({
      error: { code: 'permission_denied' },
    });
    done.resolve({ ok: true, output: { completedAfterRevocation: true } });
    expect(await fixture.gateway.drain(fixture.call.runId, 100)).toEqual({
      drained: true,
      activeCalls: 0,
    });
    expect(fixture.gateway.receipts(fixture.call.runId)).toMatchObject([
      { ok: true, output: { completedAfterRevocation: true } },
    ]);
    expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toMatchObject({
      error: { code: 'permission_denied' },
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.gateway.release(fixture.call.runId)).toBe(true);
  });

  it('keeps timed-out execution unresolved and reuses its eventual receipt without a second call', async () => {
    const done = deferred<{ ok: boolean; output: unknown }>();
    const fixture = setup({ execute: () => done.promise, gatewayOptions: { callTimeoutMs: 5 } });
    expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toMatchObject({
      error: { code: 'timeout' },
    });
    expect(fixture.gateway.release(fixture.call.runId)).toBe(false);
    done.resolve({ ok: true, output: { final: true } });
    expect(await fixture.gateway.execute(fixture.caller, fixture.call)).toMatchObject({
      kind: 'reply',
      replayed: true,
      reply: { output: { final: true } },
    });
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    await fixture.gateway.drain(fixture.call.runId, 100);
    expect(fixture.gateway.release(fixture.call.runId)).toBe(true);
  });

  it('retains hanging authorization work during shutdown without starting the callable', async () => {
    const entered = deferred<void>();
    const authorization = deferred<ToolError | null>();
    const fixture = setup({
      authorize: () => {
        entered.resolve();
        return authorization.promise;
      },
    });
    const result = fixture.gateway.execute(fixture.caller, fixture.call);
    await entered.promise;
    fixture.gateway.revoke(fixture.call.runId);
    expect(await result).toMatchObject({ error: { code: 'cancelled' } });
    expect(await fixture.gateway.drain(fixture.call.runId, 1)).toEqual({
      drained: false,
      activeCalls: 1,
    });
    authorization.resolve(null);
    expect(await fixture.gateway.drain(fixture.call.runId, 100)).toEqual({
      drained: true,
      activeCalls: 0,
    });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('registers active work before a synchronous authorizer can revoke and release its run', async () => {
    const authorization = deferred<ToolError | null>();
    const entered = deferred<void>();
    let releasedDuringAuthorization: boolean | undefined;
    const fixture = setup({
      authorize: () => {
        fixture.gateway.revoke(fixture.call.runId);
        releasedDuringAuthorization = fixture.gateway.release(fixture.call.runId);
        entered.resolve();
        return authorization.promise;
      },
    });
    const result = fixture.gateway.execute(fixture.caller, fixture.call);
    await entered.promise;
    expect(releasedDuringAuthorization).toBe(false);
    expect(await result).toMatchObject({ error: { code: 'cancelled' } });
    expect(await fixture.gateway.drain(fixture.call.runId, 1)).toEqual({
      drained: false,
      activeCalls: 1,
    });
    authorization.resolve(null);
    expect(await fixture.gateway.drain(fixture.call.runId, 100)).toEqual({
      drained: true,
      activeCalls: 0,
    });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.gateway.release(fixture.call.runId)).toBe(true);
  });

  it('skips admission callbacks when the run is revoked before queued work starts', async () => {
    const fixture = setup();
    const result = fixture.gateway.execute(fixture.caller, fixture.call);
    fixture.gateway.revoke(fixture.call.runId);
    expect(await result).toMatchObject({ error: { code: 'cancelled' } });
    expect(await fixture.gateway.drain(fixture.call.runId, 100)).toEqual({
      drained: true,
      activeCalls: 0,
    });
    expect(fixture.authorize).not.toHaveBeenCalled();
    expect(fixture.admitExternal).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.gateway.release(fixture.call.runId)).toBe(true);
  });
});
