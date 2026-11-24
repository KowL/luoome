import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it } from 'vitest';
import { apply } from './plugin.js';
import type { JsonObject, RunRequest, ToolManifestEntry } from './protocol.js';

const hash = `sha256:${'a'.repeat(64)}`;
const token = 'controlled-subagent-token-123456';

const quote: ToolManifestEntry = {
  name: 'fetch_quote',
  description: 'Read a controlled market quote',
  inputSchema: {
    type: 'object',
    properties: { stockId: { type: 'string' } },
    required: ['stockId'],
    additionalProperties: false,
  },
  callMode: 'execute',
  domain: 'market',
  sourcePlugin: 'luoome-business',
  executionLocation: 'bun-gateway',
  sideEffect: 'read',
  requiredCapabilities: [],
  costPolicy: 'business-ledger',
};
const note: ToolManifestEntry = {
  name: 'write_note',
  description: 'Draft a controlled research note',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  callMode: 'execute',
  domain: 'research',
  sourcePlugin: 'luoome-business',
  executionLocation: 'bun-gateway',
  sideEffect: 'write',
  requiredCapabilities: [],
  costPolicy: 'business-ledger',
};

interface FakeToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
  execute: (input: unknown, exec: unknown) => Promise<unknown>;
}

interface FakeToolSchema {
  name: string;
  description: string;
  parameters: JsonObject;
}

interface FakeAgent {
  session: { id: string; header: Record<string, unknown> };
  ctx: {
    tools: {
      schemas: () => readonly FakeToolSchema[];
      restrict: (filter: { allow: readonly string[] }) => void;
    };
  };
}

type Handler = (...args: unknown[]) => unknown;

const schemaViews = (definitions: Iterable<FakeToolDefinition>): FakeToolSchema[] =>
  [...definitions].map(({ name, description, parameters }) => ({ name, description, parameters }));

const sse =
  'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n' +
  'data: [DONE]\n\n';

const cleanups: Array<() => Promise<void>> = [];
const previousConfig = process.env.LUOOME_DSH_BRIDGE_CONFIG;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (previousConfig === undefined) delete process.env.LUOOME_DSH_BRIDGE_CONFIG;
  else process.env.LUOOME_DSH_BRIDGE_CONFIG = previousConfig;
});

const createAgentFixture = async (
  options: {
    allowSubagents?: boolean;
    maxToolCalls?: number;
    maxModelCalls?: number;
    subagentTimeoutMs?: number;
  } = {},
) => {
  const emitted: JsonObject[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end();
      return;
    }
    if (request.url === '/events') {
      emitted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonObject);
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (request.url === '/model') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(sse);
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture endpoint unavailable');
  const base = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });

  const root = join(await mkdtemp(join(tmpdir(), 'luoome-subagent-test-')), 'bridge.json');
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const run: RunRequest = {
    protocolVersion: 1,
    runId: 'subagent-run',
    conversationId: 'subagent-conversation',
    manifestHash: hash,
    manifest: { protocolVersion: 1, manifestHash: hash, tools: [quote, note] },
    configRef: 'fixture-v1',
    instructions: 'Research using only the permitted tools.',
    prompt: 'Research.',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...(options.allowSubagents === true ? { allowSubagents: true } : {}),
  };
  await writeFile(
    root,
    JSON.stringify({
      host: {
        configRef: 'fixture-v1',
        gateway: { endpoint: `${base}/tools`, token },
        model: { endpoint: `${base}/model`, token, model: 'controlled-stub', maxTokens: 256 },
        limits: {
          runTimeoutMs: 15000,
          initializeTimeoutMs: 10000,
          toolTimeoutMs: 1000,
          maxToolCalls: options.maxToolCalls ?? 8,
          maxModelCalls: options.maxModelCalls ?? 8,
          ...(options.subagentTimeoutMs === undefined
            ? {}
            : { subagentTimeoutMs: options.subagentTimeoutMs }),
        },
      },
      run,
      sessionId: 'root-session',
      eventSink: { endpoint: `${base}/events`, token },
    }),
    { mode: 0o600 },
  );
  process.env.LUOOME_DSH_BRIDGE_CONFIG = root;

  const handlers = new Map<string, Handler[]>();
  const guards: Array<(exec: unknown) => string | undefined> = [];
  const adapters: unknown[] = [];
  const registered = new Map<string, FakeToolDefinition>();
  const liveAgents = new Map<string, FakeAgent>();
  const interrupts: Array<{ target: string; authority: unknown }> = [];
  const subagents = {
    interrupt: (target: string, authority: unknown) => {
      interrupts.push({ target, authority });
    },
  };
  let teardown: (() => unknown) | undefined;
  const context = {
    llm: {
      registerAdapter: (_names: readonly string[], adapter: unknown) => {
        adapters.push(adapter);
      },
    },
    systemPrompt: { section: () => undefined },
    agents: { get: (id: string) => liveAgents.get(id) },
    get: (name: string) => (name === 'subagents' ? subagents : undefined),
    tools: {
      register: (definition: FakeToolDefinition) => {
        registered.set(definition.name, definition);
      },
      schemas: () => schemaViews(registered.values()),
      get: (name: string) => registered.get(name),
      guard: (guard: (exec: unknown) => string | undefined) => {
        guards.push(guard);
      },
    },
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    inject: () => undefined,
    effect: (register: () => unknown) => {
      teardown = register() as () => unknown;
    },
  };
  apply(context as unknown as Context);
  cleanups.push(async () => {
    await teardown?.();
  });

  const rootRestrictions: Array<{ allow: readonly string[] }> = [];
  const rootAgent: FakeAgent = {
    session: { id: 'root-session', header: {} },
    ctx: {
      tools: {
        schemas: () => schemaViews(registered.values()),
        restrict: (filter) => {
          rootRestrictions.push(filter);
        },
      },
    },
  };
  const childRestrictions: Array<{ allow: readonly string[] }> = [];
  const childAgent: FakeAgent = {
    session: {
      id: 'child-1',
      header: { parentSession: 'root-session', delegationDepth: 1, origin: 'subagent' },
    },
    ctx: {
      tools: {
        schemas: () => [
          { name: 'fetch_quote', description: quote.description, parameters: quote.inputSchema },
          { name: 'unlisted_tool', description: 'Not in the approved manifest', parameters: {} },
        ],
        restrict: (filter) => {
          childRestrictions.push(filter);
        },
      },
    },
  };

  liveAgents.set(rootAgent.session.id, rootAgent);
  liveAgents.set(childAgent.session.id, childAgent);
  if (options.allowSubagents === true) {
    // 官方 dsh-tool-subagent 在 Profile 里注册的工具；本 fixture 只验证桥接层的准入与审计。
    registered.set('subagent', {
      name: 'subagent',
      description: 'Delegate the task to a fresh child agent.',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
        additionalProperties: false,
      },
      execute: async () => ({ kind: 'activation', subagentId: 'child-1' }),
    });
  }

  const emit = async (event: string, ...args: unknown[]): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) await handler(...args);
  };
  const exec = (name: string, agent: FakeAgent) => ({
    token: Symbol(name),
    callId: name,
    name,
    arguments: {},
    agent,
    signal: new AbortController().signal,
  });
  const preExecute = async (name: string, agent: FakeAgent) => {
    const handler = handlers.get('tools/pre-execute')?.[0];
    if (handler === undefined) throw new Error('Missing pre-execute handler');
    return handler(exec(name, agent), async () => ({ ok: true }));
  };
  const diagnostics = () =>
    emitted
      .filter((event) => event.type === 'diagnostic')
      .map((event) => event.payload as JsonObject);
  const until = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 1000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Fixture event was not delivered');
      await new Promise<void>((done) => setTimeout(done, 5));
    }
  };

  return {
    emitted,
    diagnostics,
    until,
    rootAgent,
    childAgent,
    rootRestrictions,
    childRestrictions,
    adapters,
    interrupts,
    liveAgents,
    emit,
    preExecute,
    guard: (name: string, agent: FakeAgent) => guards[0]?.(exec(name, agent)),
    result: (name: string, agent: FakeAgent, isError = false) => {
      for (const handler of handlers.get('tools/result') ?? [])
        handler(exec(name, agent), { isError, content: [], value: {} });
    },
  };
};

describe('run bridge subagent guard', () => {
  it('admits the official subagent tool for the root only when the run permits delegation', async () => {
    const disabled = await createAgentFixture();
    await disabled.emit('agent/created', { agent: disabled.rootAgent });
    expect(disabled.guard('subagent', disabled.rootAgent)).toBe(
      'Tool is outside the Agent allowlist',
    );
    await expect(disabled.preExecute('subagent', disabled.rootAgent)).resolves.toEqual({
      kind: 'deny',
      reason: 'Call is outside the active run allowlist',
    });

    const fixture = await createAgentFixture({ allowSubagents: true });
    await fixture.emit('agent/created', { agent: fixture.rootAgent });
    await fixture.emit('agent/created', { agent: fixture.childAgent });
    expect(fixture.rootRestrictions).toEqual([
      { allow: ['fetch_quote', 'write_note', 'subagent'] },
    ]);
    expect(fixture.guard('subagent', fixture.rootAgent)).toBeUndefined();
    await expect(fixture.preExecute('subagent', fixture.rootAgent)).resolves.toEqual({ ok: true });
    // 子 Agent 不因父级能委派而获得委派权，也不占用业务工具预算。
    expect(fixture.guard('subagent', fixture.childAgent)).toBe(
      'Tool is outside the Agent allowlist',
    );
    await fixture.until(() =>
      fixture
        .diagnostics()
        .some((event) => event.code === 'subagent.tool.call' && event.agentId === 'root-session'),
    );
    fixture.result('subagent', fixture.rootAgent);
    await fixture.until(() =>
      fixture
        .diagnostics()
        .some((event) => event.code === 'subagent.tool.result' && event.ok === true),
    );
    expect(fixture.emitted.some((event) => event.type === 'tool.call')).toBe(false);
  });

  it('abandons a child agent at its own deadline through the official interrupt channel', async () => {
    const fixture = await createAgentFixture({ allowSubagents: true, subagentTimeoutMs: 100 });
    await fixture.emit('agent/created', { agent: fixture.rootAgent });
    await fixture.emit('agent/created', { agent: fixture.childAgent });
    await fixture.until(() =>
      fixture.diagnostics().some((event) => event.code === 'subagent.abandoned'),
    );
    expect(fixture.interrupts).toEqual([
      { target: 'child-1', authority: { kind: 'ancestor', agent: fixture.rootAgent } },
    ]);
    expect(
      fixture.diagnostics().find((event) => event.code === 'subagent.abandoned'),
    ).toMatchObject({
      code: 'subagent.abandoned',
      agentId: 'child-1',
      parentAgentId: 'root-session',
      reason: 'deadline',
      budgetMs: 100,
    });
    // 正常情况下子级结算会清掉截止计时器，已结算的子级不再被重复放弃。
    await fixture.emit('agent/disposed', { agent: fixture.childAgent });
    await new Promise<void>((done) => setTimeout(done, 150));
    expect(fixture.interrupts).toHaveLength(1);
  });

  it('rejects subagent creation by default and audits the denied parent link', async () => {
    const fixture = await createAgentFixture();
    await fixture.emit('agent/created', { agent: fixture.rootAgent });
    await expect(fixture.emit('agent/created', { agent: fixture.childAgent })).rejects.toThrow(
      'Subagent creation is not permitted for this run',
    );
    expect(fixture.childRestrictions).toEqual([]);
    expect(fixture.diagnostics().find((event) => event.code === 'subagent.denied')).toMatchObject({
      code: 'subagent.denied',
      agentId: 'child-1',
      parentAgentId: 'root-session',
      reason: 'Subagent creation is disabled for this run',
    });
  });

  it('restricts a subagent to the role ∩ manifest intersection and denies overreach at pre-execute', async () => {
    const fixture = await createAgentFixture({ allowSubagents: true });
    await fixture.emit('agent/created', { agent: fixture.rootAgent });
    await fixture.emit('agent/created', { agent: fixture.childAgent });
    expect(fixture.childRestrictions).toEqual([{ allow: ['fetch_quote'] }]);
    expect(fixture.diagnostics().find((event) => event.code === 'subagent.spawn')).toMatchObject({
      code: 'subagent.spawn',
      agentId: 'child-1',
      parentAgentId: 'root-session',
      depth: 1,
      allowlist: ['fetch_quote'],
    });

    expect(fixture.guard('unlisted_tool', fixture.childAgent)).toBe(
      'Tool is outside the Agent allowlist',
    );
    expect(fixture.guard('fetch_quote', fixture.childAgent)).toBeUndefined();
    await expect(fixture.preExecute('unlisted_tool', fixture.childAgent)).resolves.toEqual({
      kind: 'deny',
      reason: 'Call is outside the active run allowlist',
    });
    await expect(fixture.preExecute('fetch_quote', fixture.childAgent)).resolves.toEqual({
      ok: true,
    });
    // 子 Agent 的工具轨迹不进入根会话投影，只留下带父级关联的审计事件。
    await fixture.until(() =>
      fixture
        .diagnostics()
        .some(
          (event) => event.code === 'subagent.tool.call' && event.parentAgentId === 'root-session',
        ),
    );
    expect(fixture.emitted.some((event) => event.type === 'tool.call')).toBe(false);
  });

  it('shares one tool-call budget across parent and descendants', async () => {
    const fixture = await createAgentFixture({ allowSubagents: true, maxToolCalls: 2 });
    await fixture.emit('agent/created', { agent: fixture.rootAgent });
    await fixture.emit('agent/created', { agent: fixture.childAgent });
    await expect(fixture.preExecute('fetch_quote', fixture.rootAgent)).resolves.toEqual({
      ok: true,
    });
    await expect(fixture.preExecute('fetch_quote', fixture.childAgent)).resolves.toEqual({
      ok: true,
    });
    await expect(fixture.preExecute('write_note', fixture.rootAgent)).resolves.toEqual({
      kind: 'deny',
      reason: 'Tool-call limit exceeded',
    });
  });

  it('meters every agent through the single run model adapter and stops at the shared limit', async () => {
    const fixture = await createAgentFixture({ allowSubagents: true, maxModelCalls: 2 });
    expect(fixture.adapters).toHaveLength(1);
    const adapter = fixture.adapters[0] as unknown as {
      stream: (options: unknown) => AsyncGenerator<unknown>;
    };
    const drain = async () => {
      for await (const _chunk of adapter.stream({
        provider: 'luoome-metered',
        model: 'controlled-stub',
        maxTokens: 32,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'research' }] }],
      })) {
        // consume the metered stream
      }
    };
    await drain();
    await drain();
    await expect(drain()).rejects.toThrow('Run model-call limit exceeded');
  });
});
