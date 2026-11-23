import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type JsonValue, ToolCallSchema } from '@luoome/dsh-bridge/protocol';
import type { ModelAttemptUsage, ModelBudgetDecision, ModelBudgetLedger } from './model-budget.js';
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
    /** Transient provider failures are retried before any bytes reach the Host. */
    readonly maxRetries?: number;
  };
  readonly executeTool: (request: unknown) => Promise<GatewayExecutionResult>;
  /** 每次供应商 attempt 都经同一服务端账本准入与结算；缺省不计量。 */
  readonly budget?: {
    readonly ledger: ModelBudgetLedger;
    readonly accountId: string;
  };
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
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2_000;

const waitForRetry = (ms: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
};

/**
 * 从转发的 SSE 里提取供应商尾部 usage；供应商帧对转发路径不透明，只取可核实的 token 数。
 * 解析失败或没有 usage 时不猜测，交由调用方记为 unknown。
 */
const createUsageScanner = () => {
  const decoder = new TextDecoder();
  let buffered = '';
  let usage: ModelAttemptUsage | undefined;
  const accept = (line: string): void => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '' || data === '[DONE]') return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return;
    const raw = (frame as { usage?: unknown }).usage;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
    const prompt = (raw as { prompt_tokens?: unknown }).prompt_tokens;
    const completion = (raw as { completion_tokens?: unknown }).completion_tokens;
    if (typeof prompt !== 'number' || typeof completion !== 'number') return;
    if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return;
    usage = { inputTokens: prompt, outputTokens: completion };
  };
  return {
    push(chunk: Uint8Array): void {
      buffered += decoder.decode(chunk, { stream: true });
      let boundary = buffered.indexOf('\n');
      while (boundary >= 0) {
        accept(buffered.slice(0, boundary).replace(/\r$/, ''));
        buffered = buffered.slice(boundary + 1);
        boundary = buffered.indexOf('\n');
      }
      if (buffered.length > 1_000_000) buffered = '';
    },
    result: (): ModelAttemptUsage | null => usage ?? null,
  };
};

/** A per-run private listener; only the model route receives trusted provider credentials. */
export const createDshRunProxy = (options: DshRunProxyOptions) => {
  const toolToken = randomBytes(32).toString('hex');
  const modelToken = randomBytes(32).toString('hex');
  const nativeToken = randomBytes(32).toString('hex');
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, options.signal]);
  const nativeCalls = new Map<string, { url: string; allowed: boolean }>();
  let budgetDenial: 'tokens' | 'requests' | null = null;
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
          const requestSignal = AbortSignal.any([signal, request.signal]);
          const maxRetries = Math.max(0, Math.min(options.model.maxRetries ?? 0, 5));
          const requestedTokens = body.max_tokens;
          const reserveTokens =
            typeof requestedTokens === 'number' && Number.isFinite(requestedTokens)
              ? Math.trunc(requestedTokens)
              : 1024;
          const admit = (): ModelBudgetDecision | undefined =>
            options.budget === undefined
              ? undefined
              : options.budget.ledger.admit({
                  accountId: options.budget.accountId,
                  runId: options.runId,
                  maxTokens: reserveTokens,
                });
          const settle = (
            decision: ModelBudgetDecision | undefined,
            usage: ModelAttemptUsage | null,
          ): void => {
            if (decision?.kind === 'admitted')
              options.budget?.ledger.settle(decision.attemptId, usage);
          };
          let charged: ModelBudgetDecision | undefined;
          const fetchModel = async (): Promise<Response> => {
            for (let attempt = 0; ; attempt += 1) {
              if (requestSignal.aborted || Date.now() >= options.expiresAt)
                return json({ error: 'run_closed' }, 403);
              const decision = admit();
              if (decision?.kind === 'exhausted') {
                budgetDenial = decision.reason;
                return json({ error: 'budget_exhausted', reason: decision.reason }, 402);
              }
              let response: Response | undefined;
              let failure: unknown;
              try {
                response = await options.model.fetch(options.model.endpoint, {
                  method: 'POST',
                  body: JSON.stringify(body),
                  headers: { ...options.model.headers, 'content-type': 'application/json' },
                  redirect: 'error',
                  signal: requestSignal,
                });
              } catch (error) {
                failure = error;
              }
              if (requestSignal.aborted) {
                // 已经可能发出请求但拿不到 usage：未知成本保留预占，不归零。
                settle(decision, null);
                throw failure ?? requestSignal.reason;
              }
              const retryable = response === undefined || RETRYABLE_STATUS.has(response.status);
              if (!retryable || attempt >= maxRetries) {
                if (response !== undefined) {
                  charged = decision;
                  return response;
                }
                settle(decision, null);
                throw failure ?? new Error('model request failed');
              }
              await response?.body?.cancel().catch(() => {});
              settle(decision, null);
              const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
              console.warn(
                `[dsh] 模型上游${response === undefined ? '连接失败' : `返回 ${response.status}`}，${delay}ms 后重试（${attempt + 1}/${maxRetries}）`,
              );
              await waitForRetry(delay, requestSignal);
            }
          };
          const response = await fetchModel();
          if (response.body === null) {
            settle(charged, null);
            return response;
          }
          // 只在计量开启时扫描尾部 usage：账本按供应商真实 token 结算，而非 DSH 累计值。
          const usage = options.budget === undefined ? undefined : createUsageScanner();
          const reader = response.body.getReader();
          const bodyStream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const chunk = await reader.read();
                if (chunk.done) {
                  reader.releaseLock();
                  settle(charged, usage?.result() ?? null);
                  controller.close();
                } else {
                  usage?.push(chunk.value);
                  controller.enqueue(chunk.value);
                }
              } catch {
                // A truncated stream fails the Host's terminal-receipt check; raw transport errors stay private.
                reader.releaseLock();
                settle(charged, null);
                controller.close();
              }
            },
            async cancel() {
              settle(charged, null);
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
    /** 本次 run 是否因预算耗尽被拒；供上层给出确定失败文案。 */
    budgetDenial: (): 'tokens' | 'requests' | null => budgetDenial,
    async stop() {
      abort.abort();
      await server.stop(true);
    },
  };
};
