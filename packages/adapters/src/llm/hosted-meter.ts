import { createHash, randomUUID } from 'node:crypto';
import {
  dateInShanghai,
  HostedLLMError,
  type HostedLLMPricing,
  HostedLLMTokensSchema,
  hostedLLMCost,
  isHoliday,
  isWeekend,
  type PlatformLLMRepository,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';
import type { AIStack } from './stack.js';

export const hostedDeepSeekPricing = (now: Date): HostedLLMPricing => {
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  const peak =
    !isWeekend(now) && !isHoliday(now) && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  return {
    version: `deepseek-flash-cny-2026-10-15:${peak ? 'peak' : 'off-peak'}`,
    provider: 'deepseek',
    model: 'deepseek-flash',
    currency: 'CNY',
    inputMicroPerMillion: peak ? 2_000_000 : 1_000_000,
    cachedInputMicroPerMillion: peak ? 40_000 : 20_000,
    outputMicroPerMillion: peak ? 8_000_000 : 4_000_000,
  };
};
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
const hash = (input: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(input)))
    .digest('hex');
export const hostedLLMToolNames: ReadonlySet<string> = new Set([
  'research_investment_directions',
  'analyze_stock',
  'analyze_position',
  'analyze_strategy_candidate',
  'market_outlook',
  'generate_strategy_insight',
  'generate_strategy_version_proposal',
  'agent_run',
  'hosted_chat_stream',
]);
const forever = new Date('9999-01-01T00:00:00Z');
const usageSchema = z.object({
  id: z.string().min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().safe(),
    completion_tokens: z.number().int().nonnegative().safe(),
    prompt_cache_hit_tokens: z.number().int().nonnegative().safe().optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().int().nonnegative().safe().optional() })
      .optional(),
  }),
});
const readUsage = (body: string, stream: boolean) => {
  const frames: unknown[] = stream
    ? body
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
        .map((line) => JSON.parse(line.slice(6)))
    : [JSON.parse(body)];
  for (const value of frames.reverse()) {
    const parsed = usageSchema.safeParse(value);
    if (!parsed.success) continue;
    if (
      parsed.data.usage.prompt_cache_hit_tokens === undefined &&
      parsed.data.usage.prompt_tokens_details?.cached_tokens === undefined
    )
      throw new HostedLLMError('usage_unknown');
    return {
      receiptId: parsed.data.id,
      tokens: HostedLLMTokensSchema.parse({
        input: parsed.data.usage.prompt_tokens,
        cachedInput:
          parsed.data.usage.prompt_cache_hit_tokens ??
          parsed.data.usage.prompt_tokens_details?.cached_tokens ??
          0,
        output: parsed.data.usage.completion_tokens,
      }),
    };
  }
  throw new HostedLLMError('usage_unknown');
};

export const createHostedLLMExecution = (options: {
  readonly ledger: PlatformLLMRepository;
  readonly createStack: (fetchImpl: typeof fetch) => AIStack;
  readonly fetchImpl?: typeof fetch;
  readonly budgetMicro: number;
  readonly periodBudgetMicro: number;
  readonly timeoutMs: number;
  readonly timeoutSignal?: (ms: number) => AbortSignal;
}): NonNullable<ToolContext['llmExecution']> => ({
  async run<T>(
    name: string,
    input: unknown,
    ctx: ToolContext,
    work: (scoped: ToolContext) => Promise<T>,
  ): Promise<T> {
    if (!hostedLLMToolNames.has(name)) return work(ctx);
    const identity = ctx.identity;
    if (identity?.mode !== 'hosted') throw new HostedLLMError('operation_closed');
    if (
      !(await options.ledger.authorized(identity.tenantId, identity.tenantGeneration, ctx.clock()))
    )
      throw new HostedLLMError('operation_closed');
    const inputHash = hash(input);
    const runId =
      typeof input === 'object' &&
      input !== null &&
      'runId' in input &&
      typeof input.runId === 'string'
        ? input.runId
        : undefined;
    const scope =
      ctx.llmOperationScope ??
      identity.operationId ??
      runId ??
      (identity.actor === 'worker'
        ? `${dateInShanghai(ctx.clock())}:${inputHash}`
        : identity.requestId);
    const operationId = `llm-${hash([identity.tenantId, identity.tenantGeneration, scope, name, inputHash])}`;
    const repository = ctx.repos.workflowRun;
    const id = `hosted-llm:${operationId}`;
    const previous = await repository.findById(id);
    const output = previous?.outputSummary;
    if (output?.inputHash !== undefined && output.inputHash !== inputHash)
      throw new HostedLLMError('operation_closed');
    const settle = async (capture: boolean, owner?: string) => {
      const held = await options.ledger.find(operationId);
      if (held?.state !== 'held') return;
      let attempts = await options.ledger.attempts(operationId);
      if (attempts.some((attempt) => attempt.usageState !== 'confirmed')) {
        const count = (await repository.findById(id))?.outputSummary?.httpCount;
        if (typeof count === 'number')
          for (let index = 0; index < count; index++) {
            const cached = (await repository.findById(`${id}:http:${index}`))?.outputSummary;
            if (typeof cached?.body !== 'string' || typeof cached.attemptId !== 'string') continue;
            const attempt = attempts.find((row) => row.id === cached.attemptId);
            if (attempt?.usageState !== 'unknown') continue;
            let usage: ReturnType<typeof readUsage>;
            try {
              usage = readUsage(cached.body, cached.stream === true);
            } catch {
              continue;
            }
            await options.ledger.complete({
              operationId,
              id: attempt.id,
              ...usage,
              now: ctx.clock(),
            });
          }
        attempts = await options.ledger.attempts(operationId);
      }
      if (attempts.some((attempt) => attempt.usageState !== 'confirmed')) return;
      await options.ledger.settle({
        operationId,
        capture,
        now: ctx.clock(),
        ...(owner === undefined ? { executionStopped: true as const } : { owner }),
      });
    };
    if (output?.completed === true) {
      await settle(output.capture === true);
      return output.result as T;
    }
    const owner = randomUUID();
    const lease = async (
      action: 'acquire' | 'renew' | 'release',
      data?: Record<string, unknown>,
      nextRunAt = forever,
    ) =>
      repository.execution({
        id,
        workflowName: 'hosted-llm',
        action,
        owner,
        now: ctx.clock(),
        leaseUntil: new Date(ctx.clock().getTime() + 120_000),
        nextRunAt,
        ...(data === undefined ? {} : { output: data }),
      });
    if (!(await lease('acquire'))) throw new HostedLLMError('busy');
    const controlLease = (action: 'acquire' | 'renew' | 'release') =>
      options.ledger.execution({
        operationId,
        owner,
        action,
        now: ctx.clock(),
        leaseUntil: new Date(ctx.clock().getTime() + 120_000),
      });
    if (!(await controlLease('acquire'))) {
      await lease('release', { inputHash }, ctx.clock());
      throw new HostedLLMError('busy');
    }
    let lost = false;
    const renew = async () => {
      if (lost) return false;
      lost ||= !(await lease('renew')) || !(await controlLease('renew'));
      return !lost;
    };
    const timer = setInterval(() => {
      void renew().catch(() => {
        lost = true;
      });
    }, 30_000);
    let ordinal = 0;
    let committed = false;
    const meteredFetch = (async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      if (!(await renew())) throw new HostedLLMError('lease_lost');
      if (
        !(await options.ledger.authorized(
          identity.tenantId,
          identity.tenantGeneration,
          ctx.clock(),
        ))
      )
        throw new HostedLLMError('operation_closed');
      const address = new URL(url instanceof Request ? url.url : String(url));
      if (address.origin !== 'https://api.deepseek.com' || address.pathname !== '/chat/completions')
        throw new HostedLLMError('provider_failed');
      if (typeof init?.body !== 'string') throw new HostedLLMError('provider_failed');
      const body = JSON.parse(init.body) as {
        model?: string;
        max_tokens?: number;
        stream?: boolean;
        stream_options?: unknown;
      };
      if (
        body.model !== 'deepseek-flash' ||
        !Number.isSafeInteger(body.max_tokens) ||
        (body.max_tokens ?? 0) <= 0
      )
        throw new HostedLLMError('provider_failed');
      if (body.stream) body.stream_options = { include_usage: true };
      const requestHash = hash(body);
      const cacheId = `${id}:http:${ordinal++}`;
      const cached = (await repository.findById(cacheId))?.outputSummary;
      const complete = async (attemptId: string, responseBody: string) => {
        let usage: ReturnType<typeof readUsage>;
        try {
          usage = readUsage(responseBody, body.stream === true);
        } catch {
          if (
            (await options.ledger.attempts(operationId)).some(
              (row) => row.id === attemptId && row.usageState === 'confirmed',
            )
          )
            return;
          throw new HostedLLMError('usage_unknown');
        }
        await options.ledger.complete({ id: attemptId, operationId, ...usage, now: ctx.clock() });
      };
      if (cached?.requestHash !== undefined && cached.requestHash !== requestHash)
        throw new HostedLLMError('operation_closed');
      if (
        cached?.requestHash === requestHash &&
        typeof cached.body === 'string' &&
        typeof cached.attemptId === 'string'
      ) {
        await complete(cached.attemptId, cached.body);
        return new Response(cached.body, {
          status: 200,
          headers: { 'content-type': body.stream ? 'text/event-stream' : 'application/json' },
        });
      }
      const pricing = hostedDeepSeekPricing(ctx.clock());
      await options.ledger.reserve({
        operationId,
        tenantId: identity.tenantId,
        generation: identity.tenantGeneration,
        inputHash,
        owner,
        leaseUntil: new Date(ctx.clock().getTime() + 120_000),
        pricing,
        budgetMicro: options.budgetMicro,
        periodBudgetMicro: options.periodBudgetMicro,
        now: ctx.clock(),
      });
      const rows = await options.ledger.attempts(operationId);
      const attemptId = `${operationId}:${rows.length + 1}`;
      // HTTP JSON 的字节数加 framing 余量是保守输入上界；输出由实际请求的 max_tokens 限定。
      const reservedCostMicro = hostedLLMCost(
        {
          input: new TextEncoder().encode(JSON.stringify(body)).length + 1024,
          cachedInput: 0,
          output: body.max_tokens!,
        },
        { ...pricing, inputMicroPerMillion: 2_000_000, outputMicroPerMillion: 8_000_000 },
      );
      await options.ledger.begin({
        operationId,
        owner,
        id: attemptId,
        requestHash,
        reservedCostMicro,
        pricing,
        now: ctx.clock(),
      });
      let response: Response;
      let responseBody: string;
      try {
        response = await (options.fetchImpl ?? globalThis.fetch)(url, {
          ...init,
          body: JSON.stringify(body),
          signal: AbortSignal.any([
            ...(init.signal ? [init.signal] : []),
            (options.timeoutSignal ?? AbortSignal.timeout)(options.timeoutMs),
          ]),
        });
        responseBody = await response.text();
      } catch {
        throw new HostedLLMError('usage_unknown');
      }
      if ([400, 401, 403, 404, 429].includes(response.status)) {
        await options.ledger.complete({
          id: attemptId,
          operationId,
          tokens: { input: 0, cachedInput: 0, output: 0 },
          receiptId: `http-rejected:${response.status}:${attemptId}`,
          now: ctx.clock(),
        });
        return new Response('{"error":{"message":"provider_request_rejected"}}', {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (!response.ok) throw new HostedLLMError('usage_unknown');
      if (!(await renew())) throw new HostedLLMError('lease_lost');
      const cacheOwner = randomUUID();
      const now = ctx.clock();
      if (
        !(await repository.execution({
          id: cacheId,
          workflowName: 'hosted-llm-http',
          action: 'acquire',
          owner: cacheOwner,
          now,
          leaseUntil: new Date(now.getTime() + 120_000),
          nextRunAt: forever,
        }))
      )
        throw new HostedLLMError('busy');
      if (
        !(await repository.execution({
          id: cacheId,
          workflowName: 'hosted-llm-http',
          action: 'release',
          owner: cacheOwner,
          now: ctx.clock(),
          leaseUntil: new Date(ctx.clock().getTime() + 120_000),
          nextRunAt: forever,
          output: { requestHash, body: responseBody, attemptId, stream: body.stream === true },
        }))
      )
        throw new HostedLLMError('lease_lost');
      await complete(attemptId, responseBody);
      return new Response(responseBody, {
        status: response.status,
        headers: { 'content-type': body.stream ? 'text/event-stream' : 'application/json' },
      });
    }) as typeof fetch;
    try {
      const stack = options.createStack(meteredFetch);
      const { llmExecution: _execution, ...base } = ctx;
      const guardedLLM = {
        name: stack.llm.name,
        generate: async <R>(request: import('@luoome/core').LLMGenerateRequest): Promise<R> => {
          let value: R;
          try {
            value = await stack.llm.generate<R>(request);
          } catch (error) {
            throw error instanceof HostedLLMError ? error : new HostedLLMError('provider_failed');
          }
          if (!(await renew())) throw new HostedLLMError('lease_lost');
          if (
            !(await options.ledger.authorized(
              identity.tenantId,
              identity.tenantGeneration,
              ctx.clock(),
            ))
          )
            throw new HostedLLMError('operation_closed');
          return value;
        },
      };
      const result = await work({
        ...base,
        adapters: { ...base.adapters, llm: guardedLLM },
        agent: stack.agent,
      });
      if (
        !(await options.ledger.authorized(
          identity.tenantId,
          identity.tenantGeneration,
          ctx.clock(),
        ))
      )
        throw new HostedLLMError('operation_closed');
      const actual = await options.ledger.attempts(operationId);
      const capture =
        !(typeof result === 'object' && result !== null && 'ok' in result && result.ok === false) &&
        actual.some(
          (attempt) =>
            attempt.usageState === 'confirmed' &&
            attempt.tokens !== undefined &&
            attempt.tokens.input + attempt.tokens.output > 0,
        );
      if (!(await renew())) throw new HostedLLMError('lease_lost');
      if (
        !(await lease('release', {
          completed: true,
          inputHash,
          capture,
          result,
          httpCount: ordinal,
        }))
      )
        throw new HostedLLMError('lease_lost');
      committed = true;
      await settle(capture);
      return result;
    } catch (error) {
      if (committed || lost || !(await renew())) throw error;
      await settle(false, owner);
      await lease('release', { inputHash }, ctx.clock());
      await controlLease('release');
      throw error;
    } finally {
      clearInterval(timer);
    }
  },
});
