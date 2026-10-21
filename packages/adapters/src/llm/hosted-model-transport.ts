import { createHash, randomUUID } from 'node:crypto';
import {
  HostedLLMError,
  type HostedLLMPricing,
  HostedLLMTokensSchema,
  hostedLLMCost,
  type PlatformLLMRepository,
} from '@luoome/core';
import { z } from 'zod';

const canonical = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
};
export const hostedLLMHash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

const count = z.number().int().nonnegative().safe();
const usageSchema = z.object({
  id: z.string().min(1),
  usage: z.object({
    prompt_tokens: count,
    completion_tokens: count,
    total_tokens: count.optional(),
    prompt_cache_hit_tokens: count.optional(),
    prompt_cache_miss_tokens: count.optional(),
    cache_creation_input_tokens: count.optional(),
    prompt_tokens_details: z
      .object({
        cached_tokens: count.optional(),
        cache_creation_tokens: count.optional(),
        audio_tokens: count.optional(),
      })
      .optional(),
  }),
});
type Usage = {
  readonly receiptId: string;
  readonly tokens: z.infer<typeof HostedLLMTokensSchema>;
};

const parseUsage = (value: unknown, requireCacheUsage: boolean): Usage => {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) throw new HostedLLMError('usage_unknown');
  const { id, usage } = parsed.data;
  const hit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens;
  if (
    (requireCacheUsage && hit === undefined) ||
    (usage.prompt_cache_hit_tokens !== undefined &&
      usage.prompt_tokens_details?.cached_tokens !== undefined &&
      usage.prompt_cache_hit_tokens !== usage.prompt_tokens_details.cached_tokens) ||
    (usage.prompt_cache_miss_tokens !== undefined &&
      (hit === undefined || usage.prompt_cache_miss_tokens + hit !== usage.prompt_tokens)) ||
    (usage.total_tokens !== undefined &&
      usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) ||
    (usage.cache_creation_input_tokens ?? 0) > 0 ||
    (usage.prompt_tokens_details?.cache_creation_tokens ?? 0) > 0 ||
    (usage.prompt_tokens_details?.audio_tokens ?? 0) > 0
  )
    throw new HostedLLMError('usage_unknown');
  const tokens = HostedLLMTokensSchema.safeParse({
    input: usage.prompt_tokens,
    cachedInput: hit ?? 0,
    output: usage.completion_tokens,
  });
  if (!tokens.success) throw new HostedLLMError('usage_unknown');
  return { receiptId: id, tokens: tokens.data };
};

const maxResponseBytes = 16 * 1024 * 1024;
const maxEventChars = 1024 * 1024;
const usageReader = (stream: boolean, requireCacheUsage: boolean) => {
  let buffer = '';
  let data: string[] = [];
  let eventChars = 0;
  let receiptId: string | undefined;
  let latest: Usage | undefined;
  let done = false;
  let invalid = false;
  const frame = (text: string) => {
    if (done) {
      invalid = true;
      return;
    }
    if (text === '[DONE]') {
      done = true;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      invalid = true;
      return;
    }
    if (typeof value !== 'object' || value === null) {
      invalid = true;
      return;
    }
    if ('id' in value && typeof value.id === 'string') {
      if (receiptId !== undefined && receiptId !== value.id) invalid = true;
      receiptId = value.id;
    }
    latest = undefined;
    if ('usage' in value && value.usage !== null) {
      try {
        latest = parseUsage(value, requireCacheUsage);
      } catch {
        latest = undefined;
        invalid = true;
      }
    }
  };
  return {
    push(text: string) {
      buffer += text;
      if (!stream) return;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line === '') {
          if (data.length > 0) frame(data.join('\n'));
          data = [];
          eventChars = 0;
        } else if (line.startsWith('data:')) {
          const part = line.slice(5).replace(/^ /, '');
          eventChars += part.length;
          if (eventChars > maxEventChars) throw new HostedLLMError('usage_unknown');
          data.push(part);
        }
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > maxEventChars) throw new HostedLLMError('usage_unknown');
    },
    finish(): Usage {
      if (!stream) {
        try {
          return parseUsage(JSON.parse(buffer), requireCacheUsage);
        } catch {
          throw new HostedLLMError('usage_unknown');
        }
      }
      if (!done || invalid || !latest || data.length > 0 || buffer.trim() !== '')
        throw new HostedLLMError('usage_unknown');
      return latest;
    },
  };
};

export const readHostedModelUsage = (body: string, stream: boolean, requireCacheUsage = true) => {
  const reader = usageReader(stream, requireCacheUsage);
  reader.push(body);
  return reader.finish();
};

export interface HostedModelProvider {
  readonly endpoint: string;
  readonly model: string;
  readonly pricing: (now: Date) => HostedLLMPricing;
  readonly reservationPricing?: HostedLLMPricing;
}
export interface HostedModelRequest {
  readonly ordinal: number;
  readonly requestHash: string;
  readonly legacyRequestHash: string;
  readonly stream: boolean;
  readonly endpoint: string;
  readonly model: string;
}
export interface HostedModelResponseReceipt extends HostedModelRequest {
  readonly attemptId: string;
  readonly body: string;
}
export interface HostedModelTransport {
  readonly fetch: typeof fetch;
  readonly requestCount: number;
  /** Stops admission and waits for response consumption and receipt persistence. */
  finish(): Promise<void>;
  /** Stops admission, aborts active HTTP, and drains locally; costs can remain unknown. */
  cancel(): Promise<void>;
}

const requestSchema = z
  .object({
    model: z.string(),
    max_tokens: count.positive(),
    stream: z.boolean().optional(),
    n: z.literal(1).optional(),
    messages: z.array(
      z
        .object({
          role: z.string(),
          content: z
            .union([
              z.string(),
              z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()),
            ])
            .nullable()
            .optional(),
          name: z.string().optional(),
          tool_call_id: z.string().optional(),
          tool_calls: z.array(z.unknown()).optional(),
          reasoning_content: z.string().nullable().optional(),
          prefix: z.boolean().optional(),
        })
        .strict(),
    ),
    tools: z
      .array(z.object({ type: z.literal('function'), function: z.unknown() }).strict())
      .optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    response_format: z.unknown().optional(),
    stream_options: z.unknown().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    frequency_penalty: z.number().optional(),
    presence_penalty: z.number().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    seed: z.number().optional(),
    user: z.string().optional(),
    logit_bias: z.record(z.string(), z.number()).optional(),
    logprobs: z.boolean().optional(),
    top_logprobs: count.optional(),
    reasoning_effort: z.string().optional(),
    thinking: z
      .object({ type: z.enum(['enabled', 'disabled']) })
      .strict()
      .optional(),
  })
  .strict();

export const createHostedModelTransport = (options: {
  readonly ledger: PlatformLLMRepository;
  readonly scope: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly generation: number;
    readonly inputHash: string;
    readonly owner: string;
  };
  readonly provider: HostedModelProvider;
  readonly budgetMicro: number;
  readonly periodBudgetMicro: number;
  readonly timeoutMs: number;
  readonly clock: () => Date;
  readonly renew: () => Promise<boolean>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutSignal?: (ms: number) => AbortSignal;
  readonly signal?: AbortSignal;
  readonly receipts?: {
    readonly read: (request: HostedModelRequest) => Promise<HostedModelResponseReceipt | null>;
    readonly save: (receipt: HostedModelResponseReceipt) => Promise<void>;
  };
}): HostedModelTransport => {
  const scope = { ...options.scope };
  const provider = {
    ...options.provider,
    ...(options.provider.reservationPricing
      ? { reservationPricing: { ...options.provider.reservationPricing } }
      : {}),
  };
  const endpoint = new URL(provider.endpoint).href;
  const abort = new AbortController();
  const active = new Set<Promise<void>>();
  const errors: unknown[] = [];
  let closed = false;
  let ordinal = 0;
  const admit = async () => {
    if (closed || abort.signal.aborted || options.signal?.aborted)
      throw new HostedLLMError('operation_closed');
    if (!(await options.renew())) throw new HostedLLMError('lease_lost');
    if (!(await options.ledger.authorized(scope.tenantId, scope.generation, options.clock())))
      throw new HostedLLMError('operation_closed');
  };
  const fetchImpl = (async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    let resolve = () => {};
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    active.add(pending);
    let transferred = false;
    let finished = false;
    let sent = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      if (error !== undefined) errors.push(error);
      active.delete(pending);
      resolve();
    };
    try {
      await admit();
      let address: URL;
      try {
        address = new URL(url instanceof Request ? url.url : String(url));
      } catch {
        throw new HostedLLMError('provider_failed');
      }
      if (
        address.href !== endpoint ||
        init?.method?.toUpperCase() !== 'POST' ||
        typeof init.body !== 'string'
      )
        throw new HostedLLMError('provider_failed');
      if (init.signal?.aborted) throw new HostedLLMError('operation_closed');
      let parsed: z.infer<typeof requestSchema>;
      try {
        parsed = requestSchema.parse(JSON.parse(init.body));
      } catch {
        throw new HostedLLMError('provider_failed');
      }
      if (parsed.model !== provider.model) throw new HostedLLMError('provider_failed');
      const body = {
        ...parsed,
        ...(parsed.stream ? { stream_options: { include_usage: true } } : {}),
      };
      const request: HostedModelRequest = {
        ordinal: ordinal++,
        requestHash: hostedLLMHash({ endpoint, body }),
        legacyRequestHash: hostedLLMHash(body),
        endpoint,
        model: provider.model,
        stream: parsed.stream === true,
      };
      const cached = await options.receipts?.read(request);
      if (cached) {
        if (
          cached.requestHash !== request.requestHash ||
          cached.endpoint !== endpoint ||
          cached.model !== provider.model ||
          cached.stream !== request.stream
        )
          throw new HostedLLMError('operation_closed');
        const attempt = (await options.ledger.attempts(scope.operationId)).find(
          (row) => row.id === cached.attemptId,
        );
        if (!attempt?.pricing) throw new HostedLLMError('usage_unknown');
        const usage = readHostedModelUsage(
          cached.body,
          cached.stream,
          attempt.pricing.inputMicroPerMillion !== attempt.pricing.cachedInputMicroPerMillion,
        );
        await options.ledger.complete({
          operationId: scope.operationId,
          id: cached.attemptId,
          ...usage,
          now: options.clock(),
        });
        return new Response(cached.body, {
          headers: { 'content-type': request.stream ? 'text/event-stream' : 'application/json' },
        });
      }
      const pricing = { ...provider.pricing(options.clock()) };
      if (pricing.model !== provider.model) throw new HostedLLMError('provider_failed');
      await options.ledger.reserve({
        ...scope,
        leaseUntil: new Date(options.clock().getTime() + 120_000),
        pricing,
        budgetMicro: options.budgetMicro,
        periodBudgetMicro: options.periodBudgetMicro,
        now: options.clock(),
      });
      const serialized = JSON.stringify(body);
      const reservedCostMicro = hostedLLMCost(
        {
          // Text-only JSON bytes plus framing bound input; no remote media or provider tools.
          input: new TextEncoder().encode(serialized).length + 1024,
          cachedInput: 0,
          output: parsed.max_tokens,
        },
        {
          ...pricing,
          inputMicroPerMillion: Math.max(
            pricing.inputMicroPerMillion,
            pricing.cachedInputMicroPerMillion,
            provider.reservationPricing?.inputMicroPerMillion ?? 0,
            provider.reservationPricing?.cachedInputMicroPerMillion ?? 0,
          ),
          outputMicroPerMillion: Math.max(
            pricing.outputMicroPerMillion,
            provider.reservationPricing?.outputMicroPerMillion ?? 0,
          ),
        },
      );
      const attemptId = `${scope.operationId}:${randomUUID()}`;
      await options.ledger.begin({
        operationId: scope.operationId,
        owner: scope.owner,
        id: attemptId,
        requestHash: request.requestHash,
        reservedCostMicro,
        pricing,
        now: options.clock(),
      });
      const requestAbort = new AbortController();
      const signal = AbortSignal.any([
        abort.signal,
        requestAbort.signal,
        ...(options.signal ? [options.signal] : []),
        ...(init.signal ? [init.signal] : []),
        (options.timeoutSignal ?? AbortSignal.timeout)(options.timeoutMs),
      ]);
      let admissionError: unknown;
      try {
        if (signal.aborted) throw new HostedLLMError('operation_closed');
        await admit();
        if (closed || signal.aborted) throw new HostedLLMError('operation_closed');
      } catch (error) {
        admissionError = error;
      }
      if (admissionError !== undefined) {
        await options.ledger.complete({
          operationId: scope.operationId,
          id: attemptId,
          tokens: { input: 0, cachedInput: 0, output: 0 },
          receiptId: `not-sent:${attemptId}`,
          now: options.clock(),
        });
        throw admissionError;
      }
      let response: Response;
      sent = true;
      try {
        response = await (options.fetchImpl ?? globalThis.fetch)(endpoint, {
          ...init,
          redirect: 'error',
          body: serialized,
          signal,
        });
      } catch {
        throw new HostedLLMError('usage_unknown');
      }
      if ([400, 401, 403, 404, 429].includes(response.status)) {
        await response.body?.cancel();
        await options.ledger.complete({
          operationId: scope.operationId,
          id: attemptId,
          tokens: { input: 0, cachedInput: 0, output: 0 },
          receiptId: `http-rejected:${response.status}:${attemptId}`,
          now: options.clock(),
        });
        return new Response('{"error":{"message":"provider_request_rejected"}}', {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (!response.ok || !response.body || signal.aborted) {
        await response.body?.cancel();
        throw new HostedLLMError('usage_unknown');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const usage = usageReader(
        request.stream,
        pricing.inputMicroPerMillion !== pricing.cachedInputMicroPerMillion,
      );
      let transcript = '';
      let bytes = 0;
      let terminal: Promise<void> | undefined;
      let consumerCancelled = false;
      let downstream: ReadableStreamDefaultController<Uint8Array>;
      const consume = (text: string) => {
        usage.push(text);
        if (options.receipts) transcript += text;
      };
      const stop = (cancelled: boolean) => {
        terminal ??= Promise.resolve().then(async () => {
          signal.removeEventListener('abort', onAbort);
          let failure: unknown;
          try {
            const cancellation = reader.cancel();
            requestAbort.abort();
            // Aborting native fetch can reject cancel after its final receipt was already read.
            await cancellation.catch(() => undefined);
            reader.releaseLock();
            consume(decoder.decode());
            const receipt = usage.finish();
            if (!(await options.renew())) throw new HostedLLMError('lease_lost');
            await options.receipts?.save({ ...request, attemptId, body: transcript });
            await options.ledger.complete({
              operationId: scope.operationId,
              id: attemptId,
              ...receipt,
              now: options.clock(),
            });
          } catch (error) {
            failure = error instanceof HostedLLMError ? error : new HostedLLMError('usage_unknown');
          } finally {
            if (!cancelled && !consumerCancelled) {
              if (failure === undefined) downstream.close();
              else downstream.error(failure);
            }
            finish(failure);
          }
        });
        return terminal;
      };
      const onAbort = () => {
        if (terminal) return;
        downstream.error(new HostedLLMError('usage_unknown'));
        void stop(true);
      };
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            downstream = controller;
            signal.addEventListener('abort', onAbort, { once: true });
          },
          async pull(controller) {
            try {
              const chunk = await reader.read();
              if (terminal) return;
              if (chunk.done) {
                await stop(false);
                return;
              }
              bytes += chunk.value.byteLength;
              if (bytes > maxResponseBytes) throw new HostedLLMError('usage_unknown');
              consume(decoder.decode(chunk.value, { stream: true }));
              controller.enqueue(chunk.value);
            } catch {
              if (terminal) return;
              controller.error(new HostedLLMError('usage_unknown'));
              await stop(true);
            }
          },
          cancel() {
            consumerCancelled = true;
            return stop(true);
          },
        },
        { highWaterMark: 0 },
      );
      transferred = true;
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (sent) finish(error);
      throw error;
    } finally {
      if (!transferred) finish();
    }
  }) as typeof fetch;
  return {
    fetch: fetchImpl,
    get requestCount() {
      return ordinal;
    },
    async finish() {
      closed = true;
      await Promise.all(active);
      if (errors.length > 0) throw errors[0];
    },
    async cancel() {
      closed = true;
      abort.abort();
      await Promise.all(active);
    },
  };
};
