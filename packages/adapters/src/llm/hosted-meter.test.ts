import type { ToolContext } from '@luoome/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  getHostedLLMCostsTool,
  reconcileHostedLLMUsageTool,
} from '../../../tools/src/platform/llm.js';
import {
  buildPlatformTestContext,
  buildPlatformWorkerTestContext,
  loginPlatformTestUser,
  provisionPlatformTestTenant,
} from '../../../tools/src/platform/testing-context.js';
import { buildTestContext } from '../../../tools/src/testing/context.js';
import type { AISDKAgentRuntime } from './agent-runtime.js';
import { createHostedLLMExecution, hostedDeepSeekPricing } from './hosted-meter.js';
import { createAIStackFromEnv } from './stack.js';

export const fixtureCatalog = {
  version: 1,
  providers: {
    deepseek: {
      type: 'openai-compatible',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: 'https://api.deepseek.com',
      supportsStructuredOutputs: false,
    },
  },
  profiles: {
    generation: { model: 'deepseek:deepseek-flash', maxOutputTokens: 64, timeoutMs: 1000 },
    agent: { model: 'deepseek:deepseek-flash', maxOutputTokens: 64, timeoutMs: 1000 },
  },
};
const response = (value: unknown = { value: 'ok' }, id = 'fixture-receipt') =>
  Response.json({
    id,
    object: 'chat.completion',
    created: 0,
    model: 'deepseek-flash',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(value) },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 1000,
      prompt_cache_hit_tokens: 200,
      completion_tokens: 500,
      total_tokens: 1500,
    },
  });
const setup = async (
  transport: (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
  budgets: Partial<Parameters<typeof createHostedLLMExecution>[0]> = {},
) => {
  let now = new Date('2026-10-10T01:00:00Z');
  const clock = () => now;
  const platform = buildPlatformTestContext({ clock });
  const user = await loginPlatformTestUser(platform);
  const tenant = await provisionPlatformTestTenant(user.ctx);
  await platform.ctx.repos.subscriptions.publishPlan({
    id: 'llm-test-plan',
    code: 'fixture',
    currency: 'CNY',
    priceMinor: 4900,
    durationMonths: 1,
    limits: {
      watchlistStocks: 20,
      enabledRules: 20,
      dailyJobs: 30,
      concurrentJobs: 1,
      queuedJobs: 10,
      researchUnits: 30,
    },
    productPolicyVersion: 'hosted-web-v2',
    publishedAt: now,
  });
  await platform.ctx.repos.subscriptions.grantTrial({
    period: {
      id: 'llm-test-period',
      tenantId: tenant.id,
      planVersionId: 'llm-test-plan',
      startsAt: now,
      endsAt: new Date(now.getTime() + 30 * 86400_000),
      anchorDay: 10,
      sourceOrderId: null,
      status: 'trial',
      createdAt: now,
    },
    now,
  });
  const ctx: ToolContext = {
    ...(await buildTestContext({ clock })),
    identity: {
      mode: 'hosted',
      actor: 'worker',
      tenantId: tenant.id,
      tenantGeneration: tenant.generation,
      userId: tenant.ownerUserId,
      requestId: 'fixture-request',
    },
    llmOperationScope: 'persistent-business-id',
  };
  const fetchImpl = vi.fn(transport);
  const execution = createHostedLLMExecution({
    ledger: platform.ctx.repos.llm,
    budgetMicro: 1_000_000,
    periodBudgetMicro: 20_000_000,
    timeoutMs: 1000,
    ...budgets,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    createStack: (fetchImpl) =>
      createAIStackFromEnv(
        { LUOOME_AI_CONFIG: '/fixture/models.json', DEEPSEEK_API_KEY: 'fixture-only-not-a-secret' },
        {
          fetchImpl,
          readFile: () => JSON.stringify(fixtureCatalog),
          logger: ctx.logger,
          fallback: 'throw',
        },
      ),
  });
  const request = {
    system: 'JSON fixture',
    schema: z.object({ value: z.string() }),
    data: { premise: 'private-investment-marker' },
  };
  const run = (context = ctx) =>
    execution.run('generate_strategy_insight', { strategyId: 'fixture' }, context, (scoped) =>
      scoped.adapters.llm.generate<{ value: string }>(request),
    );
  return {
    platform,
    user,
    tenant,
    ctx,
    execution,
    fetchImpl,
    run,
    request,
    now: () => now,
    advance: () => {
      now = new Date(now.getTime() + 86400_000);
    },
  };
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('hosted metered real AI SDK with fake HTTP', () => {
  it('真实 SDK 输出校验失败修复的两次 HTTP 分别计量，业务额度只扣一次，重建上下文/跨日复用结果', async () => {
    let calls = 0;
    const h = await setup(async () =>
      response(++calls === 1 ? { invalid: true } : { value: 'repaired' }, `receipt-${calls}`),
    );
    expect(await h.run()).toMatchObject({ value: 'repaired' });
    expect(calls).toBe(2);
    const entries = await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.delta).toBe(1);
    h.advance();
    expect(
      await h.run({
        ...h.ctx,
        identity: {
          ...(h.ctx.identity as Extract<NonNullable<ToolContext['identity']>, { mode: 'hosted' }>),
          requestId: 'restarted',
        },
      }),
    ).toMatchObject({ value: 'repaired' });
    expect(calls).toBe(2);
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toEqual(entries);
    const costs = await h.platform.ctx.repos.llm.costs();
    expect(costs).toEqual([
      expect.objectContaining({
        confirmedAttempts: 2,
        confirmedMicro: 5608,
        inputTokens: 2000,
        cachedInputTokens: 400,
        outputTokens: 1000,
        unknownAttempts: 0,
      }),
    ]);
    const reservation = await h.platform.ctx.repos.jobs.findReservation(entries[0]!.operationId);
    expect(JSON.stringify(reservation)).not.toContain('private-investment-marker');
  });
  it('供应商 429 的 SDK 重试每次记录，拒绝成本为零不伪装模型成功', async () => {
    let calls = 0;
    const h = await setup(async () =>
      ++calls === 1
        ? Response.json(
            { error: { message: 'fixture rate limited' } },
            { status: 429, headers: { 'retry-after': '0' } },
          )
        : response(),
    );
    const catalog = {
      ...fixtureCatalog,
      profiles: {
        ...fixtureCatalog.profiles,
        generation: { ...fixtureCatalog.profiles.generation, maxRetries: 1 },
      },
    };
    const execution = createHostedLLMExecution({
      ledger: h.platform.ctx.repos.llm,
      budgetMicro: 1_000_000,
      periodBudgetMicro: 20_000_000,
      timeoutMs: 1000,
      fetchImpl: h.fetchImpl as unknown as typeof fetch,
      createStack: (fetchImpl) =>
        createAIStackFromEnv(
          { LUOOME_AI_CONFIG: '/fixture/models.json', DEEPSEEK_API_KEY: 'fixture-key' },
          {
            fetchImpl,
            readFile: () => JSON.stringify(catalog),
            logger: h.ctx.logger,
            fallback: 'throw',
          },
        ),
    });
    await execution.run('analyze_stock', { stockId: '600519.SH' }, h.ctx, (ctx) =>
      ctx.adapters.llm.generate(h.request),
    );
    expect(calls).toBe(2);
    expect((await h.platform.ctx.repos.llm.costs())[0]).toMatchObject({
      confirmedAttempts: 2,
      confirmedMicro: 2804,
    });
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(1);
  });
  it('超时保留 unknown 和原预占，跨日重试不再次穿透供应商；可信回执核对后可恢复', async () => {
    let fail = true;
    const h = await setup(async () => {
      if (fail) throw new TypeError('fixture network loss');
      return response();
    });
    await expect(h.run()).rejects.toThrow('usage_unknown');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const cost = (await h.platform.ctx.repos.llm.costs())[0];
    expect(cost?.unknownAttempts).toBe(1);
    const privateRuns = await h.ctx.repos.workflowRun.listRecent({ workflowName: 'hosted-llm' });
    const operationId = privateRuns[0]!.id.slice('hosted-llm:'.length);
    expect((await h.platform.ctx.repos.llm.find(operationId))?.state).toBe('held');
    h.advance();
    await expect(h.run()).rejects.toThrow('usage_unknown');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    const attempt = (await h.platform.ctx.repos.llm.attempts(operationId))[0]!;
    await h.platform.ctx.repos.llm.complete({
      operationId,
      id: attempt.id,
      tokens: { input: 1000, cachedInput: 200, output: 500 },
      receiptId: 'trusted-provider-receipt',
      now: h.now(),
    });
    fail = false;
    expect(await h.run()).toMatchObject({ value: 'ok' });
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(1);
    expect((await h.platform.ctx.repos.llm.costs())[0]).toMatchObject({
      unknownAttempts: 0,
      confirmedAttempts: 2,
    });
  });
  it('预算耗尽在 HTTP 前阻断；没有已发生用量的预占释放，不制造 token/cost 零样本', async () => {
    const h = await setup(async () => response(), { budgetMicro: 1, periodBudgetMicro: 1 });
    await expect(h.run()).rejects.toThrow('budget_exhausted');
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(0);
    expect(await h.platform.ctx.repos.llm.costs()).toEqual([]);
  });
  it('领域 facts-only 降级不把预算阻断记成一次成功 LLM 消费', async () => {
    const h = await setup(async () => response(), { budgetMicro: 1, periodBudgetMicro: 1 });
    const result = await h.execution.run(
      'generate_strategy_insight',
      { strategyId: 'fixture' },
      h.ctx,
      async (ctx) => {
        try {
          return await ctx.adapters.llm.generate(h.request);
        } catch {
          return { provider: 'facts-only' };
        }
      },
    );
    expect(result).toEqual({ provider: 'facts-only' });
    const runs = await h.ctx.repos.workflowRun.listRecent({ workflowName: 'hosted-llm' });
    expect(
      (await h.platform.ctx.repos.llm.find(runs[0]!.id.slice('hosted-llm:'.length)))?.state,
    ).toBe('released');
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toEqual([]);
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it('私库结果先提交、平台结算失败后重试只结算，不重复 HTTP 或扣额', async () => {
    const h = await setup(async () => response());
    const settle = vi.spyOn(h.platform.ctx.repos.llm, 'settle');
    settle.mockRejectedValueOnce(new Error('fixture process stopped before settlement'));
    await expect(h.run()).rejects.toThrow('process stopped');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(0);
    expect(await h.run()).toMatchObject({ value: 'ok' });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(1);
  });
  it('已确认 token 缺失时成本保持 unknown，不按零 tokens 结算', async () => {
    const h = await setup(async () =>
      Response.json({
        id: 'no-usage',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"value":"ok"}' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    await expect(h.run()).rejects.toThrow('usage_unknown');
    expect((await h.platform.ctx.repos.llm.costs())[0]).toMatchObject({
      unknownAttempts: 1,
      confirmedAttempts: 0,
    });
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(0);
  });
  it('并发执行不重复发送；暂停后缓存结果也不绕过服务权益', async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = await setup(async () => {
      started();
      await gate;
      return response();
    });
    const first = h.run();
    await start;
    await expect(h.run()).rejects.toThrow('busy');
    release();
    await first;
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    await h.platform.ctx.repos.tenants.suspend({
      id: h.tenant.id,
      generation: h.tenant.generation,
      now: h.now(),
    });
    await expect(h.run()).rejects.toThrow('operation_closed');
  });
  it('未释放租约的旧执行者被 fencing 拒绝，不释放接管者预占；再次重启复用 HTTP 回执只扣一次', async () => {
    const h = await setup(async () => response());
    let ready = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let resume = () => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = h.execution.run(
      'generate_strategy_insight',
      { strategyId: 'fixture' },
      h.ctx,
      async (ctx) => {
        const result = await ctx.adapters.llm.generate(h.request);
        ready();
        await gate;
        return result;
      },
    );
    await started;
    const run = (await h.ctx.repos.workflowRun.listRecent({ workflowName: 'hosted-llm' }))[0]!;
    const operationId = run.id.slice('hosted-llm:'.length);
    h.advance();
    const now = h.now();
    expect(
      await h.ctx.repos.workflowRun.execution({
        id: run.id,
        workflowName: 'hosted-llm',
        action: 'acquire',
        owner: 'successor',
        now,
        leaseUntil: new Date(now.getTime() + 120_000),
        nextRunAt: new Date('9999-01-01'),
      }),
    ).toBe(true);
    expect(
      await h.platform.ctx.repos.llm.execution({
        operationId,
        owner: 'successor',
        action: 'acquire',
        now,
        leaseUntil: new Date(now.getTime() + 120_000),
      }),
    ).toBe(true);
    resume();
    await expect(original).rejects.toThrow('lease_lost');
    expect((await h.platform.ctx.repos.llm.find(operationId))?.state).toBe('held');
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(0);
    h.advance();
    expect(await h.run()).toMatchObject({ value: 'ok' });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(1);
  });
  it('模型结束后撤销权益，Agent 外层不返回结果、不扣成功额度，已发生 token 成本仍保留', async () => {
    const h = await setup(async () => response());
    await expect(
      h.execution.run('agent_run', { message: 'fixture' }, h.ctx, async (ctx) => {
        const result = await ctx.adapters.llm.generate(h.request);
        await h.platform.ctx.repos.tenants.suspend({
          id: h.tenant.id,
          generation: h.tenant.generation,
          now: h.now(),
        });
        return result;
      }),
    ).rejects.toThrow('operation_closed');
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(0);
    expect((await h.platform.ctx.repos.llm.costs())[0]).toMatchObject({
      confirmedMicro: 2804,
      unknownAttempts: 0,
    });
  });
  it('heartbeat 控制库故障停止旧执行者提交，不产生未处理异常；过期后复用回执恢复', async () => {
    vi.useFakeTimers();
    const h = await setup(async () => response());
    let ready = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let resume = () => {};
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = h.execution.run(
      'generate_strategy_insight',
      { strategyId: 'fixture' },
      h.ctx,
      async (ctx) => {
        const result = await ctx.adapters.llm.generate(h.request);
        ready();
        await gate;
        return result;
      },
    );
    await started;
    const execution = h.platform.ctx.repos.llm.execution.bind(h.platform.ctx.repos.llm);
    const fault = vi
      .spyOn(h.platform.ctx.repos.llm, 'execution')
      .mockImplementation(async (input) => {
        if (input.action === 'renew') throw new Error('fixture control storage failure');
        return execution(input);
      });
    await vi.advanceTimersByTimeAsync(30_000);
    fault.mockRestore();
    resume();
    await expect(original).rejects.toThrow('lease_lost');
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(0);
    h.advance();
    expect(await h.run()).toMatchObject({ value: 'ok' });
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(1);
  });
  it('运维成本分布无样本返回 unavailable/null，unknown 不进入完整成本分位数', async () => {
    const h = await setup(async () => {
      throw new Error('offline');
    });
    const platform = buildPlatformWorkerTestContext(h.platform.ctx);
    expect(await getHostedLLMCostsTool.execute({}, platform)).toMatchObject({
      ok: true,
      data: { status: 'unavailable', sampleTenants: 0, p50CostMicro: null, p95CostMicro: null },
    });
    await expect(h.run()).rejects.toThrow('usage_unknown');
    expect(await getHostedLLMCostsTool.execute({}, platform)).toMatchObject({
      ok: true,
      data: {
        status: 'partial',
        completeTenants: 0,
        p50CostMicro: null,
        p95CostMicro: null,
        tenants: [expect.objectContaining({ totalCostMicro: null })],
      },
    });
  });
  it('流式 Agent 每个 HTTP 读取最终 usage，注入 include_usage；结果回放不新增成本', async () => {
    const frames = [
      {
        id: 'stream-receipt',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'deepseek-flash',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'fixture answer' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'stream-receipt',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'deepseek-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      {
        id: 'stream-receipt',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'deepseek-flash',
        choices: [],
        usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 200, completion_tokens: 500 },
      },
    ];
    const h = await setup(async (_url, init) => {
      expect(JSON.parse(String(init?.body)).stream_options).toEqual({ include_usage: true });
      return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const run = () =>
      h.execution.run('hosted_chat_stream', { message: 'fixture' }, h.ctx, async (ctx) => {
        const runtime = ctx.agent as AISDKAgentRuntime;
        const response = await runtime.createUIMessageStreamResponse({
          instructions: 'fixture',
          uiMessages: [
            { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'fixture question' }] },
          ],
          tools: [],
        });
        return response.text();
      });
    expect(await run()).toContain('fixture answer');
    expect(await run()).toContain('fixture answer');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect((await h.platform.ctx.repos.llm.costs())[0]).toMatchObject({
      confirmedAttempts: 1,
      confirmedMicro: 2804,
    });
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toHaveLength(1);
  });
  it('真实 AbortSignal 超时不记零成本，unknown 重试不穿透上游', async () => {
    const timeout = new AbortController();
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = await setup(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
          started();
        }),
      { timeoutSignal: () => timeout.signal },
    );
    const pending = expect(h.run()).rejects.toThrow('usage_unknown');
    await ready;
    timeout.abort(new DOMException('fixture timeout', 'TimeoutError'));
    await pending;
    expect((await h.platform.ctx.repos.llm.costs())[0]?.unknownAttempts).toBe(1);
    await expect(h.run()).rejects.toThrow('usage_unknown');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('运维凭可信 usage 回执幂等释放 unknown；普通租户不能读取全户成本或核销', async () => {
    const h = await setup(async () => {
      throw new Error('offline');
    });
    await expect(h.run()).rejects.toThrow('usage_unknown');
    const runs = await h.ctx.repos.workflowRun.listRecent({ workflowName: 'hosted-llm' });
    const operationId = runs[0]!.id.slice('hosted-llm:'.length);
    const attempt = (await h.platform.ctx.repos.llm.attempts(operationId))[0]!;
    const input = {
      operationId,
      attemptId: attempt.id,
      tokens: { input: 1000, cachedInput: 200, output: 500 },
      receiptId: 'provider-invoice-fixture',
      executionStopped: true as const,
      settlement: 'release' as const,
    };
    expect(await getHostedLLMCostsTool.execute({}, h.user.ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    expect(await reconcileHostedLLMUsageTool.execute(input, h.user.ctx)).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
    const worker = buildPlatformWorkerTestContext(h.platform.ctx);
    expect(await reconcileHostedLLMUsageTool.execute(input, worker)).toMatchObject({
      ok: true,
      data: {
        reservation: { state: 'released' },
        attempt: { usageState: 'confirmed', confirmedCostMicro: 2804 },
      },
    });
    expect((await reconcileHostedLLMUsageTool.execute(input, worker)).ok).toBe(true);
    expect(await h.platform.ctx.repos.jobs.listUsage({ tenantId: h.tenant.id })).toEqual([]);
    expect(await getHostedLLMCostsTool.execute({}, worker)).toMatchObject({
      ok: true,
      data: { status: 'complete', p50CostMicro: 2804 },
    });
  });

  it('官方人民币峰谷单价按实际尝试时间冻结，周末/假日不套用高峰', () => {
    expect(hostedDeepSeekPricing(new Date('2026-10-15T02:00:00Z')).inputMicroPerMillion).toBe(
      2_000_000,
    );
    expect(hostedDeepSeekPricing(new Date('2026-10-15T10:00:00Z')).inputMicroPerMillion).toBe(
      1_000_000,
    );
    expect(hostedDeepSeekPricing(new Date('2026-10-10T02:00:00Z')).inputMicroPerMillion).toBe(
      1_000_000,
    );
  });
});
