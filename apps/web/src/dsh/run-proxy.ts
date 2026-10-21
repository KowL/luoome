import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type JsonValue, ToolCallSchema } from '@luoome/dsh-bridge/protocol';
import type { GatewayExecutionResult } from './tool-gateway.js';

export interface DshRunProxyOptions {
  readonly runId: string;
  readonly manifestHash: string;
  readonly expiresAt: number;
  readonly signal: AbortSignal;
  readonly model: {
    readonly endpoint: string;
    readonly model: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly fetch: typeof fetch;
  };
  readonly executeTool: (request: unknown) => Promise<GatewayExecutionResult>;
  readonly authorizeNative?: (call: {
    readonly callId: string;
    readonly url: string;
  }) => Promise<boolean>;
}

const bearerMatches = (request: Request, token: string): boolean => {
  const supplied = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};
const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A per-run private listener; only the model route receives trusted provider credentials. */
export const createDshRunProxy = (options: DshRunProxyOptions) => {
  const toolToken = randomBytes(32).toString('hex');
  const modelToken = randomBytes(32).toString('hex');
  const nativeToken = randomBytes(32).toString('hex');
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, options.signal]);
  const nativeCalls = new Map<string, { url: string; allowed: boolean }>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    idleTimeout: 255,
    maxRequestBodySize: 1_048_576,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'POST') return json({ error: 'method_denied' }, 405);
      if (signal.aborted || Date.now() >= options.expiresAt)
        return json({ error: 'run_closed' }, 403);
      try {
        if (url.pathname === '/tools' && bearerMatches(request, toolToken)) {
          const result = await options.executeTool(await request.json());
          return result.kind === 'reply' ? json(result.reply) : json(result.error, 403);
        }
        if (url.pathname === '/native' && bearerMatches(request, nativeToken)) {
          const call = ToolCallSchema.parse(await request.json());
          if (
            call.runId !== options.runId ||
            call.manifestHash !== options.manifestHash ||
            call.toolName !== 'web_fetch' ||
            call.input === null ||
            typeof call.input !== 'object' ||
            Array.isArray(call.input) ||
            typeof call.input.url !== 'string'
          )
            return json({ allowed: false });
          const previous = nativeCalls.get(call.callId);
          if (previous !== undefined)
            return json({ allowed: previous.url === call.input.url && previous.allowed });
          const allowed =
            (await options.authorizeNative?.({ callId: call.callId, url: call.input.url })) ===
            true;
          nativeCalls.set(call.callId, { url: call.input.url, allowed });
          return json({ allowed });
        }
        if (url.pathname === '/model/chat/completions' && bearerMatches(request, modelToken)) {
          if (request.headers.get('x-luoome-run-id') !== options.runId)
            return json({ error: 'run_binding' }, 403);
          const body = (await request.json()) as Record<string, JsonValue>;
          if (body.model !== options.model.model) return json({ error: 'model_denied' }, 403);
          const response = await options.model.fetch(options.model.endpoint, {
            method: 'POST',
            body: JSON.stringify(body),
            headers: { ...options.model.headers, 'content-type': 'application/json' },
            redirect: 'error',
            signal: AbortSignal.any([signal, request.signal]),
          });
          if (response.body === null) return response;
          const reader = response.body.getReader();
          const bodyStream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) {
                  reader.releaseLock();
                  controller.close();
                } else controller.enqueue(chunk.value);
              } catch {
                // A truncated stream fails the Host's terminal-receipt check; raw transport errors stay private.
                reader.releaseLock();
                controller.close();
              }
            },
            async cancel() {
              await reader.cancel().catch(() => {});
              reader.releaseLock();
            },
          });
          return new Response(bodyStream, { status: response.status, headers: response.headers });
        }
        return json({ error: 'unauthorized' }, 403);
      } catch {
        return json({ error: 'request_failed' }, 502);
      }
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    gateway: { endpoint: `${origin}/tools`, token: toolToken },
    model: { endpoint: `${origin}/model/chat/completions`, token: modelToken },
    native: { endpoint: `${origin}/native`, token: nativeToken },
    async stop() {
      abort.abort();
      await server.stop(true);
    },
  };
};
