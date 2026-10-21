import { randomUUID } from 'node:crypto';
import {
  dateInShanghai,
  HostedLLMError,
  type HostedLLMPricing,
  isHoliday,
  isWeekend,
  type PlatformLLMRepository,
  type ToolContext,
} from '@luoome/core';
import {
  createHostedModelTransport,
  type HostedModelProvider,
  hostedLLMHash as hash,
  readHostedModelUsage as readUsage,
} from './hosted-model-transport.js';
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
export const createHostedLLMExecution = (options: {
  readonly provider?: HostedModelProvider;
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
              usage = readUsage(
                cached.body,
                cached.stream === true,
                attempt.pricing?.inputMicroPerMillion !==
                  attempt.pricing?.cachedInputMicroPerMillion,
              );
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
    let committed = false;
    const transport = createHostedModelTransport({
      ledger: options.ledger,
      scope: {
        operationId,
        tenantId: identity.tenantId,
        generation: identity.tenantGeneration,
        inputHash,
        owner,
      },
      provider: options.provider ?? {
        endpoint: 'https://api.deepseek.com/chat/completions',
        model: 'deepseek-flash',
        pricing: hostedDeepSeekPricing,
        reservationPricing: {
          ...hostedDeepSeekPricing(ctx.clock()),
          inputMicroPerMillion: 2_000_000,
          outputMicroPerMillion: 8_000_000,
        },
      },
      budgetMicro: options.budgetMicro,
      periodBudgetMicro: options.periodBudgetMicro,
      timeoutMs: options.timeoutMs,
      clock: ctx.clock,
      renew,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutSignal ? { timeoutSignal: options.timeoutSignal } : {}),
      receipts: {
        async read(request) {
          const cached = (await repository.findById(`${id}:http:${request.ordinal}`))
            ?.outputSummary;
          if (cached?.requestHash === undefined) return null;
          const legacy =
            cached.endpoint === undefined && cached.requestHash === request.legacyRequestHash;
          if (cached.requestHash !== request.requestHash && !legacy)
            throw new HostedLLMError('operation_closed');
          if (typeof cached.body !== 'string' || typeof cached.attemptId !== 'string')
            throw new HostedLLMError('usage_unknown');
          return { ...request, body: cached.body, attemptId: cached.attemptId };
        },
        async save(receipt) {
          const cacheId = `${id}:http:${receipt.ordinal}`;
          const cacheOwner = randomUUID();
          if (
            !(await repository.execution({
              id: cacheId,
              workflowName: 'hosted-llm-http',
              action: 'acquire',
              owner: cacheOwner,
              now: ctx.clock(),
              leaseUntil: new Date(ctx.clock().getTime() + 120_000),
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
              output: {
                requestHash: receipt.requestHash,
                endpoint: receipt.endpoint,
                model: receipt.model,
                body: receipt.body,
                attemptId: receipt.attemptId,
                stream: receipt.stream,
              },
            }))
          )
            throw new HostedLLMError('lease_lost');
        },
      },
    });
    try {
      const stack = options.createStack(transport.fetch);
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
      await transport.finish();
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
          httpCount: transport.requestCount,
        }))
      )
        throw new HostedLLMError('lease_lost');
      committed = true;
      await settle(capture);
      return result;
    } catch (error) {
      await transport.cancel();
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
