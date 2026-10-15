import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeLLMAdapter, TEST_ACCOUNT } from '@luoome/adapters/testing';
import type { ToolContext } from '@luoome/core';
import { createDrizzlePlatformRepos, createDrizzleRepos, ensurePlatformSchema } from '@luoome/db';
import { buildContext, generateStrategyInsightTool } from '@luoome/tools';
import { getHostedLLMCostsTool } from '@luoome/tools/platform';
import {
  buildPlatformTestContext,
  buildPlatformWorkerTestContext,
  loginPlatformTestUser,
  provisionPlatformTestTenant,
} from '../../../packages/tools/src/platform/testing-context.js';
import { loadHostedConfig } from './hosted-config.js';
import { createHostedProviders } from './hosted-providers.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const setup = async (enabled = true) => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-ds7-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let now = new Date('2026-10-10T01:00:00Z');
  let control = createDrizzlePlatformRepos(join(root, 'control.sqlite'));
  let privateDB = createDrizzleRepos(join(root, 'private.sqlite'));
  cleanup.push(
    () => control.close(),
    () => privateDB.close(),
  );
  const platform = buildPlatformTestContext({ repos: control.repos, clock: () => now });
  const user = await loginPlatformTestUser(platform);
  const tenant = await provisionPlatformTestTenant(user.ctx);
  const plan = {
    id: 'ds7-plan',
    code: 'fixture',
    currency: 'CNY',
    priceMinor: 4900,
    durationMonths: 1,
    productPolicyVersion: 'hosted-web-v2',
    publishedAt: now,
    limits: {
      watchlistStocks: 20,
      enabledRules: 20,
      dailyJobs: 30,
      concurrentJobs: 1,
      queuedJobs: 10,
      researchUnits: 30,
    },
  } as const;
  await control.repos.subscriptions.publishPlan(plan);
  await control.repos.subscriptions.grantTrial({
    period: {
      id: 'ds7-original-period',
      tenantId: tenant.id,
      planVersionId: plan.id,
      startsAt: now,
      endsAt: new Date(now.getTime() + 30 * 86400_000),
      anchorDay: 10,
      sourceOrderId: null,
      status: 'trial',
      createdAt: now,
    },
    now,
  });
  await privateDB.repos.account.save(TEST_ACCOUNT);
  await privateDB.repos.strategy.create({
    id: 'ds7-strategy',
    name: 'private-fixture-strategy',
    description: 'fixture',
    owner: 'user',
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  });
  const planFile = join(root, 'plan.json');
  const modelsFile = join(root, 'models.json');
  writeFileSync(planFile, JSON.stringify(plan));
  writeFileSync(
    modelsFile,
    JSON.stringify({
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
        generation: { model: 'deepseek:deepseek-flash', maxOutputTokens: 2048, timeoutMs: 1000 },
        agent: { model: 'deepseek:deepseek-flash', maxOutputTokens: 2048, timeoutMs: 1000 },
      },
    }),
  );
  const config = loadHostedConfig({
    HOSTED_ENVIRONMENT: 'development',
    HOSTED_PROVIDER_MODE: 'configured',
    HOSTED_DATA_ROOT: join(root, 'hosted'),
    PUBLIC_ORIGIN: 'https://ds7.example.invalid',
    HOSTED_AUTH_SECRET: 'ds7-fixture-auth-secret-32-characters',
    HOSTED_PRODUCT_POLICY: 'hosted-web-v2',
    LUOOME_EXPOSE_WRITE: 'true',
    LUOOME_EXPOSE_EXTERNAL: 'true',
  });
  const env = {
    HOSTED_PLAN_FILE: planFile,
    HOSTED_JOB_BUDGET_MICRO: '1000',
    LUOOME_MARKET_PROVIDER: 'real',
    HOSTED_AI_ENABLED: enabled ? 'true' : 'false',
    LUOOME_AI_CONFIG: modelsFile,
    DEEPSEEK_API_KEY: 'fixture-only-not-a-real-api-key',
  };
  const transport = spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('real network prohibited by fixture');
  }) as unknown as typeof fetch);
  cleanup.push(() => transport.mockRestore());
  const requests: { url: string; headers: Headers }[] = [];
  const fetchImpl = (async (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers) });
    return Response.json({
      id: 'fixture-deepseek-receipt',
      object: 'chat.completion',
      created: 0,
      model: 'deepseek-flash',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify({
              headline: 'fixture',
              summary: '已有事实摘要',
              findings: [],
              risks: [],
              limitations: ['无完整观察样本'],
              disclaimer: '不构成投资建议',
            }),
          },
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
  }) as typeof fetch;
  let providers = createHostedProviders(config, env, { fetchImpl });
  providers.bindPlatform?.(control.repos);
  const context = (): ToolContext => {
    const base = buildContext({
      mode: 'hosted',
      repos: privateDB.repos,
      identity: {
        mode: 'hosted',
        actor: 'worker',
        tenantId: tenant.id,
        tenantGeneration: tenant.generation,
        userId: tenant.ownerUserId,
        requestId: 'request-changes-after-restart',
      },
      adapters: { market: providers.market, llm: new FakeLLMAdapter() },
      user: { id: tenant.ownerUserId, defaultAccountId: TEST_ACCOUNT.id },
      clock: () => now,
    });
    if (!providers.createTenantContext) throw new Error('fixture provider missing');
    return {
      ...providers.createTenantContext({
        ...base,
        llmOperationScope: 'persistent-scheduled-operation',
      }),
      hostedAuthorization: async () => null,
    };
  };
  return {
    requests,
    tenantId: tenant.id,
    transport,
    context,
    ledger: () => control.repos,
    run: () => generateStrategyInsightTool.execute({ strategyId: 'ds7-strategy' }, context()),
    restart: () => {
      control.close();
      privateDB.close();
      now = new Date(now.getTime() + 86400_000);
      control = createDrizzlePlatformRepos(join(root, 'control.sqlite'));
      ensurePlatformSchema(control.db);
      privateDB = createDrizzleRepos(join(root, 'private.sqlite'));
      providers = createHostedProviders(config, env, { fetchImpl });
      providers.bindPlatform?.(control.repos);
    },
    costs: () =>
      getHostedLLMCostsTool.execute(
        {},
        buildPlatformWorkerTestContext(
          buildPlatformTestContext({ repos: control.repos, clock: () => now }).ctx,
        ),
      ),
  };
};

test('配置装配真实 DeepSeek SDK，密钥只在传输头；SQLite 双库重启/跨日复用回执及原期扣额', async () => {
  const h = await setup();
  const first = await h.run();
  expect(first).toMatchObject({ ok: true, data: { provider: 'deepseek:deepseek-flash' } });
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]?.url).toBe('https://api.deepseek.com/chat/completions');
  expect(h.requests[0]?.headers.get('authorization')).toBe(
    'Bearer fixture-only-not-a-real-api-key',
  );
  expect(JSON.stringify(first)).not.toContain('fixture-only-not-a-real-api-key');
  const tenantId = h.tenantId;
  const before = await h.ledger().jobs.listUsage({ tenantId });
  expect(before).toHaveLength(1);
  expect(before[0]?.periodId).toBe('ds7-original-period');
  h.restart();
  expect(await h.run()).toEqual(first);
  expect(h.requests).toHaveLength(1);
  expect(await h.ledger().jobs.listUsage({ tenantId })).toEqual(before);
  expect(await h.costs()).toMatchObject({
    ok: true,
    data: { status: 'complete', sampleTenants: 1, p50CostMicro: 2804, p95CostMicro: 2804 },
  });
  expect(h.transport).not.toHaveBeenCalled();
});
test('业务回执已提交但控制库结算中断，重开后只补结算，不再请求模型', async () => {
  const h = await setup();
  const settle = spyOn(h.ledger().llm, 'settle').mockRejectedValueOnce(
    new Error('fixture crash before settlement'),
  );
  const result = await h.run();
  expect(result.ok).toBe(false);
  expect(h.requests).toHaveLength(1);
  settle.mockRestore();
  h.restart();
  expect(await h.run()).toMatchObject({ ok: true, data: { provider: 'deepseek:deepseek-flash' } });
  expect(h.requests).toHaveLength(1);
  expect(await h.ledger().jobs.listUsage({ tenantId: h.tenantId })).toHaveLength(1);
});
test('未装配 AI 时明确 adapter_error/unconfigured，覆盖传入的 fake，绝不返回 mock 或规则建议', async () => {
  const h = await setup(false);
  const ctx = h.context();
  expect(ctx.adapters.llm.name).toBe('ai-unconfigured');
  expect(ctx.agent).toBeUndefined();
  await expect(ctx.adapters.llm.generate({ system: 'fixture', data: {} })).rejects.toThrow(
    'unconfigured',
  );
  expect(await h.run()).toMatchObject({
    ok: false,
    error: { kind: 'adapter_error', adapter: 'hosted-llm', cause: 'unconfigured' },
  });
  expect(h.requests).toHaveLength(0);
  expect(h.transport).not.toHaveBeenCalled();
  expect(await h.costs()).toMatchObject({
    ok: true,
    data: { status: 'unavailable', sampleTenants: 0, p50CostMicro: null },
  });
});
