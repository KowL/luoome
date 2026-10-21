import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-web';
import { z } from 'zod';
import { postJson } from './http.js';
import { ModelProxyAdapter } from './model-proxy.js';
import {
  canonicalJson,
  type JsonObject,
  JsonObjectSchema,
  JsonValueSchema,
  type RuntimeEvent,
  type ToolReply,
  ToolReplySchema,
} from './protocol.js';
import { PluginConfigSchema } from './runtime-config.js';

export const name = 'luoome-run-bridge';
export const inject = ['tools', 'llm', 'agents', 'systemPrompt'];

const callableOutputSchema = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' as const },
    output: {},
  },
  required: ['ok', 'output'],
};

export function apply(ctx: Context): void {
  const path = process.env.LUOOME_DSH_BRIDGE_CONFIG;
  if (!path) throw new Error('Missing run bridge configuration');
  const config = PluginConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const { run, host, sessionId } = config;
  const lifecycle = new AbortController();
  let sequence = 0;
  let pendingBytes = 0;
  let deliveries: Promise<void> = Promise.resolve();
  let nativeCalls = 0;
  let toolCalls = 0;
  const manifest = new Map(run.manifest.tools.map((tool) => [tool.name, tool]));
  const definitions = new Map<string, unknown>();
  const replies = new Map<ToolExecution['token'], ToolReply>();
  const callIds = new Map<ToolExecution['token'], string>();
  const started = new Map<string, Extract<AssistantStreamFrame, { type: 'start' }>>();
  const nativeAdmissions = new Set<ToolExecution['token']>();

  // Provider call IDs can repeat between steps; Gateway idempotency is per execution.
  const callId = (exec: Readonly<ToolExecution>): string => {
    let id = callIds.get(exec.token);
    if (id === undefined) {
      id = randomUUID();
      callIds.set(exec.token, id);
    }
    return id;
  };

  const publish = (type: RuntimeEvent['type'], payload: JsonObject, eventId?: string): void => {
    const event: RuntimeEvent = {
      protocolVersion: 1,
      runId: run.runId,
      conversationId: run.conversationId,
      agentId: sessionId,
      source: 'plugin',
      sourceEventId: eventId ?? `${sessionId}:bridge:${sequence}`,
      sequence: sequence++,
      timestamp: new Date().toISOString(),
      type,
      payload,
    };
    const size = Buffer.byteLength(JSON.stringify(event));
    pendingBytes += size;
    if (pendingBytes > 4_000_000) {
      lifecycle.abort(new Error('Event bridge backlog exceeded limit'));
      throw new Error('Event bridge backlog exceeded limit');
    }
    deliveries = deliveries
      .then(async () => {
        await postJson(
          config.eventSink,
          JsonValueSchema.parse(event),
          JsonObjectSchema,
          AbortSignal.timeout(3000),
        );
        pendingBytes -= size;
      })
      .catch(() => {
        lifecycle.abort(new Error('Event channel unavailable'));
      });
  };

  const denied = (exec: Readonly<ToolExecution>): string | undefined => {
    if (lifecycle.signal.aborted || Date.now() >= Date.parse(run.expiresAt))
      return 'Run is no longer active';
    if (exec.agent?.session.id !== sessionId) return 'Agent is outside the bound run';
    if (
      !manifest.has(exec.name) ||
      ctx.tools.get(exec.name, exec.agent) !== definitions.get(exec.name)
    ) {
      return 'Tool registration differs from the approved manifest';
    }
    if (
      manifest.get(exec.name)?.executionLocation === 'runtime-native' &&
      !nativeAdmissions.has(exec.token)
    ) {
      return 'Native call lacks server authorization';
    }
    return undefined;
  };

  ctx.llm.registerAdapter(['luoome-metered'], new ModelProxyAdapter(config, lifecycle.signal));
  ctx.systemPrompt.section({
    name: 'luoome:instructions',
    order: -10000,
    text: run.instructions,
    interpolate: false,
  });

  for (const tool of run.manifest.tools) {
    if (tool.executionLocation !== 'bun-gateway') continue;
    if (['settle_chat_draft', 'run_code', 'Shell', 'web_fetch'].includes(tool.name)) {
      throw new Error(`Reserved or forbidden business tool: ${tool.name}`);
    }
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: {
        schema: callableOutputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      timeoutMs: host.limits.toolTimeoutMs,
      execute: async (input, exec) => {
        const reply = await postJson(
          host.gateway,
          {
            protocolVersion: 1,
            runId: run.runId,
            callId: callId(exec),
            toolName: tool.name,
            input: JsonValueSchema.parse(input),
            manifestHash: run.manifestHash,
          },
          ToolReplySchema,
          AbortSignal.any([
            exec.signal,
            lifecycle.signal,
            AbortSignal.timeout(host.limits.toolTimeoutMs),
          ]),
        );
        if (reply.runId !== run.runId || reply.callId !== callId(exec)) {
          throw new Error('Gateway response identity mismatch');
        }
        replies.set(exec.token, reply);
        return { ok: reply.ok, output: reply.output };
      },
    });
  }

  ctx.tools.guard(denied);
  ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = manifest.get(exec.name);
    if (
      !tool ||
      exec.agent?.session.id !== sessionId ||
      lifecycle.signal.aborted ||
      Date.now() >= Date.parse(run.expiresAt)
    ) {
      return { kind: 'deny', reason: 'Call is outside the active run manifest' };
    }
    if (++toolCalls > host.limits.maxToolCalls)
      return { kind: 'deny', reason: 'Tool-call limit exceeded' };
    if (tool.executionLocation === 'runtime-native') {
      const native = host.native;
      if (!native || exec.name !== 'web_fetch' || ++nativeCalls > native.maxCalls) {
        return { kind: 'deny', reason: 'Native capability is not authorized' };
      }
      const input = z.strictObject({ url: z.string().url() }).parse(exec.arguments);
      const url = new URL(input.url);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        !native.allowedOrigins.includes(url.origin)
      ) {
        return { kind: 'deny', reason: 'URL origin is outside run egress policy' };
      }
      const admission = await postJson(
        native.authorization,
        {
          protocolVersion: 1,
          runId: run.runId,
          callId: callId(exec),
          toolName: exec.name,
          input,
          manifestHash: run.manifestHash,
        },
        z.strictObject({ allowed: z.boolean() }),
        AbortSignal.any([
          exec.signal,
          lifecycle.signal,
          AbortSignal.timeout(host.limits.toolTimeoutMs),
        ]),
      );
      if (!admission.allowed) return { kind: 'deny', reason: 'Native call was revoked or denied' };
      nativeAdmissions.add(exec.token);
    }
    publish('tool.call', {
      callId: callId(exec),
      toolName: exec.name,
      input: JsonValueSchema.parse(exec.arguments),
      executionLocation: tool.executionLocation,
      manifestHash: run.manifestHash,
    });
    return next();
  });

  ctx.on('tools/execute', async (exec, next) => {
    const previous = exec.signal;
    exec.signal = AbortSignal.any([
      previous,
      lifecycle.signal,
      AbortSignal.timeout(host.limits.toolTimeoutMs),
    ]);
    try {
      return await next();
    } finally {
      exec.signal = previous;
    }
  });
  ctx.on('tools/post-execute', (exec, _result, next) => {
    const reply = replies.get(exec.token);
    if (reply && !reply.ok) {
      return Promise.resolve({
        kind: 'block' as const,
        feedback: [{ type: 'text' as const, text: JSON.stringify(reply.output) }],
      });
    }
    return next();
  });
  ctx.on('tools/result', (exec, result) => {
    const tool = manifest.get(exec.name);
    if (!tool) return;
    const reply = replies.get(exec.token);
    replies.delete(exec.token);
    nativeAdmissions.delete(exec.token);
    publish(tool.executionLocation === 'runtime-native' ? 'native-tool.result' : 'tool.result', {
      callId: callId(exec),
      toolName: exec.name,
      sourcePlugin: tool.sourcePlugin,
      executionLocation: tool.executionLocation,
      ok: reply ? reply.ok && !result.isError : !result.isError,
      output: reply
        ? reply.output
        : JsonValueSchema.parse(
            result.isError ? { error: result.error, content: result.content } : result.value,
          ),
      ...(reply?.auditRef ? { auditRef: reply.auditRef } : {}),
    });
    callIds.delete(exec.token);
  });

  ctx.on('agent/created', async ({ agent }) => {
    if (agent.session.id !== sessionId) throw new Error('Only the bound root Agent is permitted');
    const globalNames = ctx.tools
      .schemas()
      .map((tool) => tool.name)
      .sort();
    if (canonicalJson(globalNames) !== canonicalJson([...manifest.keys()].sort())) {
      throw new Error('Runtime tool inventory differs from manifest');
    }
    for (const tool of run.manifest.tools) {
      const actual = ctx.tools.get(tool.name);
      if (
        !actual ||
        canonicalJson(JsonObjectSchema.parse(actual.parameters)) !== canonicalJson(tool.inputSchema)
      ) {
        throw new Error(`Registered tool schema mismatch: ${tool.name}`);
      }
      if (
        tool.executionLocation === 'runtime-native' &&
        (tool.name !== 'web_fetch' ||
          tool.sourcePlugin !== '@deepseek-ai/dsh-tool-web' ||
          tool.sideEffect !== 'read' ||
          !host.native ||
          tool.costPolicy !== 'free')
      )
        throw new Error('Unapproved native tool declaration');
      definitions.set(tool.name, actual);
    }
    agent.ctx.tools.restrict({ allow: [...manifest.keys()] });
    const actual = agent.ctx.tools.schemas();
    if (
      canonicalJson(actual.map((tool) => tool.name).sort()) !==
      canonicalJson([...manifest.keys()].sort())
    ) {
      throw new Error('Actual Agent tool inventory differs from manifest');
    }
    publish('diagnostic', {
      code: 'inventory',
      pid: process.pid,
      tools: JsonValueSchema.parse(actual),
    });
    await deliveries;
    lifecycle.signal.throwIfAborted();
  });

  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (agent.session.id !== sessionId) return;
    if (frame.type === 'start') started.set(`${frame.turn}:${frame.step}`, frame);
    if (frame.type !== 'chunk' || frame.chunk.type !== 'text-delta') return;
    const start = [...started.values()].find((value) => value.attemptId === frame.attemptId);
    if (!start) throw new Error('Assistant chunk has no bound attempt start');
    publish(
      'text.delta',
      {
        messageId: String(frame.attemptId),
        attemptId: String(frame.attemptId),
        turnId: `${sessionId}:${start.turn}`,
        step: start.step,
        delta: frame.chunk.text,
        index: frame.index,
      },
      `${frame.attemptId}:chunk:${frame.index}`,
    );
  });
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId || event.type !== 'assistant/message') return;
    const data = event.data;
    const start = started.get(`${data.turn}:${data.step}`);
    if (!start) throw new Error('Durable assistant message has no bound attempt');
    const messageId = String(start.attemptId);
    publish(
      'assistant.message',
      {
        messageId,
        attemptId: messageId,
        durableMessageId: String(data.message.id),
        turnId: `${sessionId}:${data.turn}`,
        step: data.step,
        sessionSequence: Number(event.seq),
        text: data.message.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(''),
      },
      `${sessionId}:durable:${event.seq}`,
    );
  });
  ctx.on('agent/turn-stopping', async () => {
    await deliveries;
    lifecycle.signal.throwIfAborted();
  });

  if (host.native?.fixtures) {
    ctx.inject(['web'], (webCtx) => {
      webCtx.web.registerFetchProvider({
        id: 'luoome-fixture',
        available: () => true,
        async fetch(request, signal) {
          signal?.throwIfAborted();
          const content = host.native?.fixtures?.[request.url];
          if (content === undefined) throw new Error('No controlled webpage fixture for URL');
          return {
            url: request.url,
            statusCode: 200,
            body: { kind: 'html', content },
            truncated: false,
          };
        },
      });
    });
  }

  ctx.effect(() => async () => {
    lifecycle.abort(new Error('Runtime disposed'));
    await deliveries;
  });
}
