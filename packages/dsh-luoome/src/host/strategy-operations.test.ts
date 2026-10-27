// 策略生命周期与 Advice 结果回填的原生确认操作测试（M2b-2）：prepare 冻结参数、独立审批、
// 拒绝/取消/过期/跨账户无写入、create+validate 不隐含 publish、response-loss reconcile
// 只按业务回执核对，以及 record_advice_outcome 必须由用户明确反馈经审批写入。
// 审批层本身（拒绝/晚到/子 Agent）由 dsh-authority.e2e.test.ts 的通用 wrapper/guard 用例覆盖。
import { randomUUID } from 'node:crypto';
import type {
  PluginAuthorityRepository,
  PluginAutomationGrant,
  PluginOperation,
  PluginOperationProof,
  PluginOperationScope,
  RepositoryRegistry,
  StrategyDslV1,
  ToolContext,
  ToolResult,
} from '@luoome/core';
import {
  type ConfirmablePluginTool,
  createPluginOperationService,
  defineTool,
  type PluginPrincipal,
  toolRegistry,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createCreateStrategyOperation,
  createCreateStrategyVersionOperation,
  createPauseStrategyOperation,
  createPublishStrategyVersionOperation,
  createRecordAdviceOutcomeOperation,
  createResumeStrategyOperation,
  createSetStrategyScheduleOperation,
  createStrategyOperationPolicies,
  createSubscribeStrategyOperation,
  createUnsubscribeStrategyOperation,
  createValidateStrategyVersionOperation,
} from './strategy-operations.js';

const NOW = Date.parse('2026-07-02T01:00:00Z'); // 上海 09:00，盘中行动窗口内
const signal = (): AbortSignal => new AbortController().signal;

const validDefinition = (): StrategyDslV1 => ({
  schemaVersion: 1,
  metadata: { horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [
      {
        id: 'positive-price',
        name: '价格有效',
        when: 'quote.close > 0',
        evidence: ['价格有效'],
      },
    ],
  },
  signals: { entry: [], exit: [], risk: [] },
});

const data = <T>(result: ToolResult<unknown>): T => {
  if (!result.ok) throw new Error(`operation failed: ${JSON.stringify(result)}`);
  return result.data as T;
};

type OperationView = {
  readonly operationId: string;
  readonly accountId: string;
  readonly tool: string;
  readonly state: string;
  readonly input: Record<string, unknown>;
  readonly confirmationToken?: string;
  readonly expiresAt: number;
  readonly result: ToolResult<unknown> | null;
};

const prepared = (result: ToolResult<unknown>): OperationView => data<OperationView>(result);

const operationResult = <T>(view: OperationView): T => {
  if (view.result === null || !view.result.ok)
    throw new Error(`operation did not succeed: ${JSON.stringify(view.result)}`);
  return view.result.data as T;
};

/** 领域 tool 的 execute 在公开类型上返回 unknown data；测试里按预期输出显式收窄。 */
const readTool = async <T>(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult<T>> => {
  const tool = toolRegistry.get(name);
  if (tool === undefined) throw new Error(`missing tool: ${name}`);
  return (await tool.execute(input, ctx)) as ToolResult<T>;
};

const setup = async (
  options: {
    readonly capabilities?: readonly ('read' | 'write' | 'external' | 'queue')[];
    readonly policies?: readonly ConfirmablePluginTool[];
    readonly repository?: PluginAuthorityRepository;
    readonly repositories?: RepositoryRegistry;
  } = {},
) => {
  let nowMs = NOW;
  const base = await buildTestContext({ clock: () => new Date(nowMs) });
  const principal: PluginPrincipal = { userId: 'test-user', accountId: base.user.defaultAccountId };
  const context =
    options.repositories === undefined ? base : { ...base, repos: options.repositories };
  const service = createPluginOperationService({
    repository: options.repository ?? base.repos.pluginAuthority,
    policies: options.policies ?? createStrategyOperationPolicies(),
    capabilities: options.capabilities ?? ['read', 'write', 'external', 'queue'],
    policyVersion: 1,
    now: () => nowMs,
    context: () => context,
  });
  const adviceId = (await base.repos.advice.query({ includeExpired: true })).find(
    (advice) => advice.subjectId === '600519.SH',
  )?.id;
  if (adviceId === undefined) throw new Error('test advice fixture missing');
  return {
    ctx: base,
    context,
    service,
    principal,
    adviceId,
    now: () => nowMs,
    advance: (ms: number): void => {
      nowMs += ms;
    },
  };
};

const prepare = async (
  service: ReturnType<typeof createPluginOperationService>,
  principal: PluginPrincipal,
  tool: string,
  input: unknown,
) => {
  const id = randomUUID();
  const result = await service.prepare(principal, { id, tool, input });
  return { id, result };
};

/** prepare + confirm 一次完整的人工确认操作。 */
const runOperation = async (
  service: ReturnType<typeof createPluginOperationService>,
  principal: PluginPrincipal,
  tool: string,
  input: unknown,
) => {
  const { id, result } = await prepare(service, principal, tool, input);
  const view = prepared(result);
  if (view.confirmationToken === undefined) throw new Error('missing confirmation token');
  const confirmed = prepared(
    await service.confirm(principal, { id, token: view.confirmationToken }, signal()),
  );
  return { id, view, confirmed };
};

afterEach(() => {
  delete process.env.LUOOME_EXPOSE_TRADE;
});

describe('strategy lifecycle operation policies', () => {
  it('runs create → version → validate → publish as four independent approvals', async () => {
    const { ctx, service, principal } = await setup();

    const created = await runOperation(service, principal, 'create_strategy', {
      name: '我的策略',
      description: '用户创建的趋势策略',
    });
    expect(created.confirmed.state).toBe('succeeded');
    const strategyId = created.view.input.id as string;
    // 没有显式 id 时冻结成 operationId 派生的确定性 id，供 reconcile 核对回执。
    expect(strategyId).toBe(`strategy-${created.id}`);
    const strategy = await ctx.repos.strategy.findById(strategyId);
    expect(strategy).toMatchObject({ name: '我的策略', owner: 'user', status: 'draft' });

    const versioned = await runOperation(service, principal, 'create_strategy_version', {
      strategyId,
      definition: validDefinition(),
      changeSummary: 'initial',
      factReferences: ['quote:600519.SH'],
    });
    const version = operationResult<{ version: { id: string; version: number } }>(
      versioned.confirmed,
    ).version;
    expect(version.version).toBe(1);

    const validated = await runOperation(service, principal, 'validate_strategy_version', {
      versionId: version.id,
      strategyId,
    });
    const validation = operationResult<{
      version: { validationStatus: string };
      referencedFields: string[];
    }>(validated.confirmed);
    expect(validation.version.validationStatus).toBe('valid');
    expect(validation.referencedFields).toEqual(['quote.close']);
    // create + validate 的审批只产生 draft + valid 版本，不会隐含发布。
    expect((await ctx.repos.strategy.findById(strategyId))?.currentVersionId).toBeUndefined();

    const published = await runOperation(service, principal, 'publish_strategy_version', {
      versionId: version.id,
      strategyId,
    });
    const publication = operationResult<{
      strategy: { status: string; currentVersionId?: string };
      version: { id: string; publishedAt?: unknown };
    }>(published.confirmed);
    expect(publication.strategy.currentVersionId).toBe(version.id);
    expect(publication.strategy.status).toBe('active');
    expect(publication.version.publishedAt).toBeDefined();
    expect((await ctx.repos.strategy.findVersionById(version.id))?.publishedAt).toBeInstanceOf(
      Date,
    );

    // 只读面/仓库能回读到同一 Strategy 与版本（M4 面板的读路径）。
    const read = await readTool<{
      strategy: { id: string; currentVersionId?: string };
      versions: { id: string }[];
    }>('get_strategy', { strategyId }, ctx);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data.strategy.id).toBe(strategyId);
    expect(read.data.versions.map((candidate) => candidate.id)).toContain(version.id);
    expect(read.data.strategy.currentVersionId).toBe(version.id);
  });

  it('reconciles receipts from business facts for create/version/validate and copy', async () => {
    const { ctx, service, principal } = await setup();
    const created = await runOperation(service, principal, 'create_strategy', {
      id: 'receipt-strategy',
      name: '回执策略',
      description: '用于核对策略回执',
    });
    const versioned = await runOperation(service, principal, 'create_strategy_version', {
      strategyId: 'receipt-strategy',
      definition: validDefinition(),
      changeSummary: 'v1',
    });
    const version = operationResult<{ version: { id: string } }>(versioned.confirmed).version;
    const validated = await runOperation(service, principal, 'validate_strategy_version', {
      versionId: version.id,
    });

    const createReceipt = await createCreateStrategyOperation().receipt(created.view.input, ctx);
    expect(createReceipt?.ok).toBe(true);
    if (createReceipt?.ok !== true) return;
    expect(createReceipt.data).toMatchObject({
      strategy: { id: 'receipt-strategy' },
      replayed: true,
    });

    const versionReceipt = await createCreateStrategyVersionOperation().receipt(
      versioned.view.input,
      ctx,
    );
    expect(versionReceipt?.ok).toBe(true);
    if (versionReceipt?.ok !== true) return;
    expect(versionReceipt.data).toMatchObject({
      version: { id: version.id, changeSummary: 'v1' },
      replayed: true,
    });

    const validateReceipt = await createValidateStrategyVersionOperation().receipt(
      validated.view.input,
      ctx,
    );
    expect(validateReceipt?.ok).toBe(true);
    if (validateReceipt?.ok !== true) return;
    expect(validateReceipt.data).toMatchObject({
      version: { validationStatus: 'valid' },
      referencedFields: ['quote.close'],
      replayed: true,
    });

    // 复制策略的回执要求新 Strategy 与「复制自 source@version」的版本同时存在。
    await runOperation(service, principal, 'publish_strategy_version', { versionId: version.id });
    const copied = await runOperation(service, principal, 'create_strategy', {
      name: '复制策略',
      description: '从已发布策略复制',
      copyFromStrategyId: 'receipt-strategy',
    });
    const copyReceipt = await createCreateStrategyOperation().receipt(copied.view.input, ctx);
    expect(copyReceipt?.ok).toBe(true);
    if (copyReceipt?.ok !== true) return;
    expect(copyReceipt.data).toMatchObject({
      strategy: { name: '复制策略' },
      copiedVersion: { version: 1 },
      replayed: true,
    });
  });

  it('keeps publish independently authorized: create/validate approvals cannot publish', async () => {
    const { ctx, service, principal } = await setup();
    const created = await runOperation(service, principal, 'create_strategy', {
      id: 'independent-strategy',
      name: '独立审批策略',
      description: '验证 publish 不被隐含批准',
    });
    expect(created.confirmed.state).toBe('succeeded');
    const versioned = await runOperation(service, principal, 'create_strategy_version', {
      strategyId: 'independent-strategy',
      definition: validDefinition(),
    });
    const version = operationResult<{ version: { id: string } }>(versioned.confirmed).version;
    await runOperation(service, principal, 'validate_strategy_version', {
      versionId: version.id,
    });
    expect((await ctx.repos.strategy.findById('independent-strategy'))?.currentVersionId).toBe(
      undefined,
    );

    // 单独 prepare 的 publish 必须有自己的 token；create 操作的 token 不能确认它。
    const publishPrepared = prepared(
      (await prepare(service, principal, 'publish_strategy_version', { versionId: version.id }))
        .result,
    );
    const createToken = created.view.confirmationToken;
    if (createToken === undefined) throw new Error('missing create token');
    const mismatched = await service.confirm(
      principal,
      { id: publishPrepared.operationId, token: createToken },
      signal(),
    );
    expect(mismatched.ok).toBe(false);
    expect((await ctx.repos.strategy.findById('independent-strategy'))?.currentVersionId).toBe(
      undefined,
    );

    // 未通过 validate 的版本即使 prepare 了 publish 也会被领域拒绝，且不写发布状态。
    const unvalidated = await runOperation(service, principal, 'create_strategy_version', {
      strategyId: 'independent-strategy',
      definition: validDefinition(),
      changeSummary: 'second',
    });
    const unvalidatedVersion = operationResult<{ version: { id: string } }>(
      unvalidated.confirmed,
    ).version;
    const rejected = await runOperation(service, principal, 'publish_strategy_version', {
      versionId: unvalidatedVersion.id,
    });
    expect(rejected.confirmed.state).toBe('unknown');
    expect(rejected.confirmed.result?.ok).toBe(false);
    expect((await ctx.repos.strategy.findById('independent-strategy'))?.currentVersionId).toBe(
      undefined,
    );
    expect(
      (await ctx.repos.strategy.findVersionById(unvalidatedVersion.id))?.publishedAt,
    ).toBeUndefined();
  });

  it('freezes prepared input and strips client-reported authority fields', async () => {
    const { service, principal } = await setup();
    const raw = {
      name: '冻结策略',
      description: '验证参数冻结',
      approved: true,
      callId: 'model-reported-call',
      taskId: 'model-reported-task',
    };
    const first = prepared((await prepare(service, principal, 'create_strategy', raw)).result);
    expect(first.input).toMatchObject({
      id: `strategy-${first.operationId}`,
      name: '冻结策略',
      description: '验证参数冻结',
    });
    const serialized = JSON.stringify(first.input);
    for (const forbidden of ['approved', 'model-reported-call', 'model-reported-task'])
      expect(serialized).not.toContain(forbidden);

    // 同 key 不同参数被拒绝；同 key 同参数不换发凭据。
    const conflicting = await service.prepare(principal, {
      id: first.operationId,
      tool: 'create_strategy',
      input: { ...raw, name: '另一个策略' },
    });
    expect(conflicting.ok).toBe(false);
    const repeated = await service.prepare(principal, {
      id: first.operationId,
      tool: 'create_strategy',
      input: raw,
    });
    expect(repeated.ok).toBe(true);
    expect(JSON.stringify(repeated)).not.toContain(first.confirmationToken ?? '');

    // 客户端不能替换账户；账户由 principal 决定。
    const otherAccount = await prepare(service, principal, 'create_strategy', {
      ...raw,
      accountId: 'someone-else',
    });
    expect(otherAccount.result.ok).toBe(false);

    // 版本创建同样冻结定义：同 key 换定义不合法。
    const versioned = await prepare(service, principal, 'create_strategy_version', {
      strategyId: 'frozen-strategy',
      definition: validDefinition(),
      changeSummary: 'v1',
    });
    expect(versioned.result.ok).toBe(true);
    const changedDefinition = validDefinition();
    changedDefinition.metadata = { horizon: 'medium' };
    const changed = await service.prepare(principal, {
      id: versioned.id,
      tool: 'create_strategy_version',
      input: { strategyId: 'frozen-strategy', definition: changedDefinition, changeSummary: 'v1' },
    });
    expect(changed.ok).toBe(false);
  });

  it('writes nothing on cross-account confirm, cancel or expired approval', async () => {
    const { ctx, service, principal, advance } = await setup();

    const crossAccount = prepared(
      (
        await prepare(service, principal, 'create_strategy', {
          name: '跨账户策略',
          description: '不应写入',
        })
      ).result,
    );
    if (crossAccount.confirmationToken === undefined) throw new Error('missing token');
    const denied = await service.confirm(
      { ...principal, accountId: 'other-account' },
      { id: crossAccount.operationId, token: crossAccount.confirmationToken },
      signal(),
    );
    expect(denied.ok).toBe(false);
    expect(await ctx.repos.strategy.findById(crossAccount.input.id as string)).toBeNull();

    const cancelled = prepared(
      (
        await prepare(service, principal, 'create_strategy', {
          name: '取消策略',
          description: '不应写入',
        })
      ).result,
    );
    if (cancelled.confirmationToken === undefined) throw new Error('missing token');
    expect(
      (
        await service.cancel(principal, {
          id: cancelled.operationId,
          token: cancelled.confirmationToken,
        })
      ).ok,
    ).toBe(true);
    const afterCancel = prepared(
      await service.confirm(
        principal,
        { id: cancelled.operationId, token: cancelled.confirmationToken },
        signal(),
      ),
    );
    expect(afterCancel.state).toBe('cancelled');
    expect(await ctx.repos.strategy.findById(cancelled.input.id as string)).toBeNull();

    const late = prepared(
      (
        await prepare(service, principal, 'create_strategy', {
          name: '过期策略',
          description: '不应写入',
        })
      ).result,
    );
    if (late.confirmationToken === undefined) throw new Error('missing token');
    advance(600_000);
    const expired = await service.confirm(
      principal,
      { id: late.operationId, token: late.confirmationToken },
      signal(),
    );
    expect(expired.ok).toBe(false);
    expect(await ctx.repos.strategy.findById(late.input.id as string)).toBeNull();
  });

  it('reconciles a publish response loss from the business receipt without replaying', async () => {
    const nowMs = NOW;
    const base = await buildTestContext({ clock: () => new Date(nowMs) });
    const flaky = new FailOnceSettleRepository(base.repos.pluginAuthority);
    const counters = { publish: 0 };
    const countingStrategy = new Proxy(base.repos.strategy, {
      get(target, property) {
        if (property === 'publishVersion')
          return (...args: Parameters<typeof target.publishVersion>) => {
            counters.publish++;
            return target.publishVersion(...args);
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const repositories = { ...base.repos, strategy: countingStrategy } as RepositoryRegistry;
    const principal: PluginPrincipal = {
      userId: 'test-user',
      accountId: base.user.defaultAccountId,
    };
    const context = { ...base, repos: repositories };
    const service = createPluginOperationService({
      repository: flaky,
      policies: createStrategyOperationPolicies(),
      capabilities: ['read', 'write', 'external', 'queue'],
      policyVersion: 1,
      now: () => nowMs,
      context: () => context,
    });
    const created = await readTool<{ strategy: { id: string } }>(
      'create_strategy',
      { id: 'reconcile-strategy', name: '回执策略', description: '验证响应丢失' },
      context,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const versioned = await readTool<{ version: { id: string } }>(
      'create_strategy_version',
      { strategyId: 'reconcile-strategy', definition: validDefinition() },
      context,
    );
    expect(versioned.ok).toBe(true);
    if (!versioned.ok) return;
    const validated = await readTool<{ version: { validationStatus: string } }>(
      'validate_strategy_version',
      { versionId: versioned.data.version.id },
      context,
    );
    expect(validated.ok).toBe(true);

    const { id, result } = await prepare(service, principal, 'publish_strategy_version', {
      versionId: versioned.data.version.id,
    });
    const view = prepared(result);
    if (view.confirmationToken === undefined) throw new Error('missing token');
    // 业务提交后、operation 回执保存前失败：confirm 返回 internal，operation 留在 executing。
    const failed = await service.confirm(
      principal,
      { id, token: view.confirmationToken },
      signal(),
    );
    expect(failed.ok).toBe(false);
    expect(counters.publish).toBe(1);

    const reconciled = prepared(await service.reconcile(principal, id));
    expect(reconciled.state).toBe('succeeded');
    expect(counters.publish).toBe(1);
    expect((await context.repos.strategy.findById('reconcile-strategy'))?.currentVersionId).toBe(
      versioned.data.version.id,
    );
  });

  it('requires write capability and never accepts trade or queue management policies', async () => {
    const { ctx, service, principal } = await setup({ capabilities: ['read'] });
    // 缺少 write 能力时 policy 仍注册但拒绝 prepare，不会因为名字可猜而执行。
    const denied = await prepare(service, principal, 'create_strategy', {
      name: '无写能力策略',
      description: '不应 prepare',
    });
    expect(denied.result.ok).toBe(false);

    const tradeTool = defineTool({
      name: 'fixture_strategy_trade',
      description: 'must never be a policy',
      sideEffect: 'trade',
      input: z.object({}),
      output: z.object({}),
      handler: () => ({}),
    });
    expect(() =>
      createPluginOperationService({
        repository: ctx.repos.pluginAuthority,
        policies: [
          { tool: tradeTool, scheduled: false, bind: (raw) => raw, receipt: async () => null },
        ],
        capabilities: ['read', 'write'],
        policyVersion: 1,
        now: () => NOW,
        context: () => ctx,
      }),
    ).toThrow('Unsupported operation capability');
  });

  it('exposes only the exact M2b-2 policies, each scheduled=false and write-only', () => {
    const policies = createStrategyOperationPolicies();
    expect(policies.map((policy) => policy.tool.name)).toEqual([
      'create_strategy',
      'create_strategy_version',
      'validate_strategy_version',
      'publish_strategy_version',
      'set_strategy_schedule',
      'pause_strategy',
      'resume_strategy',
      'subscribe_strategy_to_watchlist',
      'unsubscribe_strategy_from_watchlist',
      'record_advice_outcome',
    ]);
    for (const policy of policies) {
      expect(policy.scheduled).toBe(false);
      expect(policy.tool.sideEffect).toBe('write');
      expect(policy.tool.requiredCapabilities).toEqual(['write']);
    }
    expect(createCreateStrategyOperation().tool.name).toBe('create_strategy');
    expect(createCreateStrategyVersionOperation().tool.name).toBe('create_strategy_version');
    expect(createValidateStrategyVersionOperation().tool.name).toBe('validate_strategy_version');
    expect(createPublishStrategyVersionOperation().tool.name).toBe('publish_strategy_version');
    expect(createRecordAdviceOutcomeOperation().tool.name).toBe('record_advice_outcome');
    expect(createSetStrategyScheduleOperation().tool.name).toBe('set_strategy_schedule');
    expect(createPauseStrategyOperation().tool.name).toBe('pause_strategy');
    expect(createResumeStrategyOperation().tool.name).toBe('resume_strategy');
    expect(createSubscribeStrategyOperation().tool.name).toBe('subscribe_strategy_to_watchlist');
    expect(createUnsubscribeStrategyOperation().tool.name).toBe(
      'unsubscribe_strategy_from_watchlist',
    );
    const names = new Set(policies.map((policy) => policy.tool.name));
    for (const forbidden of [
      'record_decision_trade',
      'add_trade',
      'send_notification',
      'claim_analysis_jobs',
      'complete_analysis_job',
      'fail_analysis_job',
      'delete_strategy',
      'archive_strategy',
      'claim_due_strategy_schedules',
      'finish_strategy_schedule_claim',
      'renew_strategy_schedule_claim',
      'sync_strategy_watchlist_subscriptions',
    ])
      expect(names.has(forbidden), `${forbidden} must not be a policy`).toBe(false);
  });
});

/** 经四次独立审批把策略推到 active + 已发布版本，作为调度/暂停/订阅用例的前置。 */
const publishStrategy = async (
  service: ReturnType<typeof createPluginOperationService>,
  principal: PluginPrincipal,
  strategyId: string,
): Promise<void> => {
  const created = await runOperation(service, principal, 'create_strategy', {
    id: strategyId,
    name: `策略-${strategyId}`,
    description: '运行操作用例前置策略',
  });
  expect(created.confirmed.state).toBe('succeeded');
  const versioned = await runOperation(service, principal, 'create_strategy_version', {
    strategyId,
    definition: validDefinition(),
  });
  const version = operationResult<{ version: { id: string } }>(versioned.confirmed).version;
  await runOperation(service, principal, 'validate_strategy_version', { versionId: version.id });
  const published = await runOperation(service, principal, 'publish_strategy_version', {
    versionId: version.id,
  });
  expect(published.confirmed.state).toBe('succeeded');
};

describe('strategy run operation policies', () => {
  it('enables, modifies and disables a schedule through independent approvals', async () => {
    const { ctx, service, principal } = await setup();
    await publishStrategy(service, principal, 'scheduled-strategy');

    // 启用：缺省 timezone/enabled 在 prepare 时被冻结成显式值。
    const enabled = await runOperation(service, principal, 'set_strategy_schedule', {
      strategyId: 'scheduled-strategy',
      cron: '0 18 * * 1-5',
    });
    expect(enabled.confirmed.state).toBe('succeeded');
    expect(enabled.view.input).toMatchObject({
      strategyId: 'scheduled-strategy',
      cron: '0 18 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
    });
    const enabledSchedule = operationResult<{
      schedule: {
        id: string;
        cron: string;
        timezone: string;
        enabled: boolean;
        nextRunAt?: string;
      };
    }>(enabled.confirmed).schedule;
    expect(enabledSchedule).toMatchObject({
      id: 'strategy-schedule:scheduled-strategy',
      cron: '0 18 * * 1-5',
      timezone: 'Asia/Shanghai',
      enabled: true,
    });
    // operation 结果已序列化成 JSON：下一次运行是当天上海 18:00。
    expect(enabledSchedule.nextRunAt).toBe('2026-07-02T10:00:00.000Z');
    const enabledReceipt = await createSetStrategyScheduleOperation().receipt(
      enabled.view.input,
      ctx,
    );
    expect(enabledReceipt?.ok).toBe(true);
    if (enabledReceipt?.ok !== true) return;
    expect(enabledReceipt.data).toMatchObject({
      schedule: { strategyId: 'scheduled-strategy', enabled: true },
      replayed: true,
    });

    // 修改 cron 与验收政策：同一 schedule id，createdAt 保留。
    const acceptancePolicy = {
      policyVersion: 'strategy-run-acceptance-v1',
      minEvaluatedRatio: 0.9,
      maxFailedRatio: 0.05,
      maxIncompleteRatio: 0.05,
    };
    const modified = await runOperation(service, principal, 'set_strategy_schedule', {
      strategyId: 'scheduled-strategy',
      cron: '30 9 * * 1-5',
      acceptancePolicy,
    });
    const modifiedSchedule = operationResult<{
      schedule: { id: string; cron: string; acceptancePolicy?: unknown; enabled: boolean };
    }>(modified.confirmed).schedule;
    expect(modifiedSchedule).toMatchObject({
      id: enabledSchedule.id,
      cron: '30 9 * * 1-5',
      enabled: true,
      acceptancePolicy,
    });
    const modifiedReceipt = await createSetStrategyScheduleOperation().receipt(
      modified.view.input,
      ctx,
    );
    expect(modifiedReceipt?.ok).toBe(true);

    // 停用：enabled=false 清除 nextRunAt；省略 acceptancePolicy 保留原值且不影响回执恢复。
    const disabled = await runOperation(service, principal, 'set_strategy_schedule', {
      strategyId: 'scheduled-strategy',
      cron: '30 9 * * 1-5',
      enabled: false,
    });
    const disabledSchedule = operationResult<{
      schedule: { enabled: boolean; nextRunAt?: Date };
    }>(disabled.confirmed).schedule;
    expect(disabledSchedule.enabled).toBe(false);
    expect(disabledSchedule.nextRunAt).toBeUndefined();
    const persisted = await ctx.repos.strategySchedule.findByStrategyId('scheduled-strategy');
    expect(persisted?.enabled).toBe(false);
    expect(persisted?.nextRunAt).toBeUndefined();
    const disabledReceipt = await createSetStrategyScheduleOperation().receipt(
      disabled.view.input,
      ctx,
    );
    expect(disabledReceipt?.ok).toBe(true);

    // 只读面能回读到同一配置（M4 面板读路径）。
    const read = await readTool<{ schedule: { enabled: boolean; cron: string } | null }>(
      'get_strategy_schedule',
      { strategyId: 'scheduled-strategy' },
      ctx,
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.data.schedule).toMatchObject({ enabled: false, cron: '30 9 * * 1-5' });
  });

  it('rejects recommendationPolicy, invalid cron and enabling a schedule for an unpublished strategy', async () => {
    const { ctx, service, principal } = await setup();
    await publishStrategy(service, principal, 'schedule-guard-strategy');

    // 自动推荐政策不允许由本 operation 写入：strict 输入在 prepare 阶段直接拒绝。
    const withRecommendation = await prepare(service, principal, 'set_strategy_schedule', {
      strategyId: 'schedule-guard-strategy',
      cron: '0 18 * * 1-5',
      recommendationPolicy: { enabled: true, notify: false },
    });
    expect(withRecommendation.result.ok).toBe(false);
    expect(await ctx.repos.strategySchedule.findByStrategyId('schedule-guard-strategy')).toBeNull();

    // 非法 cron 通过输入校验，但领域不变量拒绝；operation 不落成功回执。
    const invalidCron = await runOperation(service, principal, 'set_strategy_schedule', {
      strategyId: 'schedule-guard-strategy',
      cron: '99 18 * * 1-5',
    });
    expect(invalidCron.confirmed.state).toBe('unknown');
    expect(invalidCron.confirmed.result?.ok).toBe(false);
    expect(await ctx.repos.strategySchedule.findByStrategyId('schedule-guard-strategy')).toBeNull();

    // 未发布的 draft Strategy 不能启用调度。
    await runOperation(service, principal, 'create_strategy', {
      id: 'draft-strategy',
      name: '草稿策略',
      description: '不应启用调度',
    });
    const draft = await runOperation(service, principal, 'set_strategy_schedule', {
      strategyId: 'draft-strategy',
      cron: '0 18 * * 1-5',
    });
    expect(draft.confirmed.state).toBe('unknown');
    expect(draft.confirmed.result?.ok).toBe(false);
    expect(await ctx.repos.strategySchedule.findByStrategyId('draft-strategy')).toBeNull();
    // 对 draft 停用（不启用）同样要求 Strategy 存在，但不会产生 nextRunAt。
    expect(
      await createSetStrategyScheduleOperation().receipt(
        {
          strategyId: 'draft-strategy',
          cron: '0 18 * * 1-5',
          timezone: 'Asia/Shanghai',
          enabled: true,
        },
        ctx,
      ),
    ).toBeNull();
  });

  it('pauses and resumes with independent approvals and usable receipts', async () => {
    const { ctx, service, principal } = await setup();
    await publishStrategy(service, principal, 'run-strategy');

    // active 策略不能 resume；领域拒绝且不写状态。
    const prematureResume = await runOperation(service, principal, 'resume_strategy', {
      strategyId: 'run-strategy',
    });
    expect(prematureResume.confirmed.state).toBe('unknown');
    expect(prematureResume.confirmed.result?.ok).toBe(false);
    expect((await ctx.repos.strategy.findById('run-strategy'))?.status).toBe('active');

    const paused = await runOperation(service, principal, 'pause_strategy', {
      strategyId: 'run-strategy',
    });
    expect(paused.confirmed.state).toBe('succeeded');
    expect(
      operationResult<{ strategy: { status: string } }>(paused.confirmed).strategy.status,
    ).toBe('paused');
    const pauseReceipt = await createPauseStrategyOperation().receipt(paused.view.input, ctx);
    expect(pauseReceipt?.ok).toBe(true);
    if (pauseReceipt?.ok !== true) return;
    expect(pauseReceipt.data).toMatchObject({
      strategy: { id: 'run-strategy', status: 'paused' },
      replayed: true,
    });

    // 重复 pause 被领域拒绝；pause 的 token 也不能确认 resume。
    const repause = await runOperation(service, principal, 'pause_strategy', {
      strategyId: 'run-strategy',
    });
    expect(repause.confirmed.state).toBe('unknown');
    expect(repause.confirmed.result?.ok).toBe(false);
    const resumePrepared = prepared(
      (await prepare(service, principal, 'resume_strategy', { strategyId: 'run-strategy' })).result,
    );
    const pauseToken = paused.view.confirmationToken;
    if (pauseToken === undefined) throw new Error('missing pause token');
    const mismatched = await service.confirm(
      principal,
      { id: resumePrepared.operationId, token: pauseToken },
      signal(),
    );
    expect(mismatched.ok).toBe(false);
    expect((await ctx.repos.strategy.findById('run-strategy'))?.status).toBe('paused');

    if (resumePrepared.confirmationToken === undefined) throw new Error('missing resume token');
    const resumed = prepared(
      await service.confirm(
        principal,
        { id: resumePrepared.operationId, token: resumePrepared.confirmationToken },
        signal(),
      ),
    );
    expect(resumed.state).toBe('succeeded');
    expect(operationResult<{ strategy: { status: string } }>(resumed).strategy.status).toBe(
      'active',
    );
    const resumeReceipt = await createResumeStrategyOperation().receipt(resumePrepared.input, ctx);
    expect(resumeReceipt?.ok).toBe(true);
    if (resumeReceipt?.ok !== true) return;
    expect(resumeReceipt.data).toMatchObject({
      strategy: { id: 'run-strategy', status: 'active' },
      replayed: true,
    });

    // scheduled:false 的 policy 永不由定时授权面执行。
    const scheduled = await service.executeScheduled(
      { userId: principal.userId, sessionId: 's', taskId: 't' } as never,
      {
        grantId: 'grant',
        grantVersion: 1,
        occurrenceId: 'occurrence',
        tool: 'pause_strategy',
        accountId: principal.accountId,
        input: { strategyId: 'run-strategy' },
      },
      signal(),
    );
    expect(scheduled.ok).toBe(false);
  });

  it('subscribes idempotently, cancels with an audit receipt and resubscribes', async () => {
    const { ctx, service, principal } = await setup();
    await publishStrategy(service, principal, 'subscribed-strategy');
    const now = new Date(NOW);
    await ctx.repos.watchlist.save({
      id: 'wl-target',
      name: '订阅目标',
      kind: 'personal',
      membershipPolicy: 'manual',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });

    const subscribed = await runOperation(service, principal, 'subscribe_strategy_to_watchlist', {
      strategyId: 'subscribed-strategy',
      watchlistId: 'wl-target',
    });
    expect(subscribed.confirmed.state).toBe('succeeded');
    const first = operationResult<{
      subscription: { id: string; status: string; strategyId: string; watchlistId: string };
      idempotent: boolean;
    }>(subscribed.confirmed);
    expect(first.idempotent).toBe(false);
    expect(first.subscription).toMatchObject({
      strategyId: 'subscribed-strategy',
      watchlistId: 'wl-target',
      status: 'active',
    });

    // 重复订阅幂等返回同一契约，不产生第二条记录。
    const duplicate = await runOperation(service, principal, 'subscribe_strategy_to_watchlist', {
      strategyId: 'subscribed-strategy',
      watchlistId: 'wl-target',
    });
    const second = operationResult<{
      subscription: { id: string };
      idempotent: boolean;
    }>(duplicate.confirmed);
    expect(second.idempotent).toBe(true);
    expect(second.subscription.id).toBe(first.subscription.id);
    expect(
      await ctx.repos.strategyWatchlistSubscription.list({ strategyId: 'subscribed-strategy' }),
    ).toHaveLength(1);
    const subscribeReceipt = await createSubscribeStrategyOperation().receipt(
      subscribed.view.input,
      ctx,
    );
    expect(subscribeReceipt?.ok).toBe(true);
    if (subscribeReceipt?.ok !== true) return;
    expect(subscribeReceipt.data).toMatchObject({
      subscription: { id: first.subscription.id, status: 'active' },
      idempotent: true,
      replayed: true,
    });

    // 取消保留审计记录；重复取消幂等。
    const cancelled = await runOperation(
      service,
      principal,
      'unsubscribe_strategy_from_watchlist',
      { strategyId: 'subscribed-strategy', watchlistId: 'wl-target' },
    );
    const cancellation = operationResult<{
      subscription: { id: string; status: string; cancelledAt?: string };
      idempotent: boolean;
    }>(cancelled.confirmed);
    expect(cancellation.idempotent).toBe(false);
    expect(cancellation.subscription.status).toBe('cancelled');
    expect(cancellation.subscription.cancelledAt).toBe(new Date(NOW).toISOString());
    const unsubscribeReceipt = await createUnsubscribeStrategyOperation().receipt(
      cancelled.view.input,
      ctx,
    );
    expect(unsubscribeReceipt?.ok).toBe(true);
    if (unsubscribeReceipt?.ok !== true) return;
    expect(unsubscribeReceipt.data).toMatchObject({
      subscription: { id: first.subscription.id, status: 'cancelled' },
      idempotent: true,
      replayed: true,
    });

    // 按 strategyId+watchlistId 重复取消时活动订阅已不存在：领域返回 not_found。
    const recancel = await runOperation(service, principal, 'unsubscribe_strategy_from_watchlist', {
      strategyId: 'subscribed-strategy',
      watchlistId: 'wl-target',
    });
    expect(recancel.confirmed.state).toBe('unknown');
    expect(recancel.confirmed.result?.ok).toBe(false);
    // 按 subscriptionId 重复取消才是幂等路径，返回同一取消记录。
    const recancelById = await runOperation(
      service,
      principal,
      'unsubscribe_strategy_from_watchlist',
      { subscriptionId: first.subscription.id },
    );
    const recancelResult = operationResult<{
      subscription: { id: string; status: string };
      idempotent: boolean;
    }>(recancelById.confirmed);
    expect(recancelResult.idempotent).toBe(true);
    expect(recancelResult.subscription).toMatchObject({
      id: first.subscription.id,
      status: 'cancelled',
    });
    expect(
      await ctx.repos.strategyWatchlistSubscription.list({ strategyId: 'subscribed-strategy' }),
    ).toHaveLength(1);

    // 取消后可重新订阅新契约，并可按 subscriptionId 取消。
    const resubscribed = await runOperation(service, principal, 'subscribe_strategy_to_watchlist', {
      strategyId: 'subscribed-strategy',
      watchlistId: 'wl-target',
    });
    const third = operationResult<{
      subscription: { id: string; status: string };
      idempotent: boolean;
    }>(resubscribed.confirmed);
    expect(third.idempotent).toBe(false);
    expect(third.subscription.id).not.toBe(first.subscription.id);
    const byId = await runOperation(service, principal, 'unsubscribe_strategy_from_watchlist', {
      subscriptionId: third.subscription.id,
    });
    const byIdResult = operationResult<{
      subscription: { id: string; status: string };
    }>(byId.confirmed);
    expect(byIdResult.subscription).toMatchObject({
      id: third.subscription.id,
      status: 'cancelled',
    });
    const byIdReceipt = await createUnsubscribeStrategyOperation().receipt(byId.view.input, ctx);
    expect(byIdReceipt?.ok).toBe(true);
  });

  it('publish does not imply schedule, pause or subscription authorization', async () => {
    const { ctx, service, principal } = await setup();
    await publishStrategy(service, principal, 'plain-strategy');

    // 发布只切换 currentVersion/状态：不创建调度、不创建订阅。
    expect(await ctx.repos.strategySchedule.findByStrategyId('plain-strategy')).toBeNull();
    expect(
      await ctx.repos.strategyWatchlistSubscription.list({ strategyId: 'plain-strategy' }),
    ).toEqual([]);

    // publish 的审批 token 不能确认调度或暂停操作。
    const publishedAgain = await runOperation(service, principal, 'create_strategy_version', {
      strategyId: 'plain-strategy',
      definition: validDefinition(),
      changeSummary: 'v2',
    });
    const version = operationResult<{ version: { id: string } }>(publishedAgain.confirmed).version;
    await runOperation(service, principal, 'validate_strategy_version', { versionId: version.id });
    const publish = prepared(
      (
        await prepare(service, principal, 'publish_strategy_version', {
          versionId: version.id,
        })
      ).result,
    );
    if (publish.confirmationToken === undefined) throw new Error('missing publish token');

    const schedulePrepared = prepared(
      (
        await prepare(service, principal, 'set_strategy_schedule', {
          strategyId: 'plain-strategy',
          cron: '0 18 * * 1-5',
        })
      ).result,
    );
    const scheduleWithPublishToken = await service.confirm(
      principal,
      { id: schedulePrepared.operationId, token: publish.confirmationToken },
      signal(),
    );
    expect(scheduleWithPublishToken.ok).toBe(false);
    expect(await ctx.repos.strategySchedule.findByStrategyId('plain-strategy')).toBeNull();

    const pausePrepared = prepared(
      (await prepare(service, principal, 'pause_strategy', { strategyId: 'plain-strategy' }))
        .result,
    );
    const pauseWithPublishToken = await service.confirm(
      principal,
      { id: pausePrepared.operationId, token: publish.confirmationToken },
      signal(),
    );
    expect(pauseWithPublishToken.ok).toBe(false);
    expect((await ctx.repos.strategy.findById('plain-strategy'))?.status).toBe('active');
  });
});

describe('record_advice_outcome operation policy', () => {
  it('requires the user outcome explicitly and strips model-reported authority fields', async () => {
    const { service, principal, adviceId } = await setup();

    // 没有 outcome 的调用无法 prepare：模型不能省略字段再让工具自动推断。
    const missingOutcome = await prepare(service, principal, 'record_advice_outcome', {
      adviceId,
    });
    expect(missingOutcome.result.ok).toBe(false);

    const explicit = await prepare(service, principal, 'record_advice_outcome', {
      adviceId,
      outcome: 'followed',
      pnl: 120.5,
      holdingHours: 26,
      notes: '按计划跟随',
      changeNote: '用户复盘',
      approved: true,
      callId: 'model-reported-call',
      taskId: 'model-reported-task',
    });
    const view = prepared(explicit.result);
    expect(view.input).toMatchObject({
      adviceId,
      accountId: principal.accountId,
      requestId: explicit.id,
      outcome: 'followed',
      pnl: 120.5,
      holdingHours: 26,
      notes: '按计划跟随',
    });
    const serialized = JSON.stringify(view.input);
    for (const forbidden of ['approved', 'model-reported-call', 'model-reported-task'])
      expect(serialized).not.toContain(forbidden);

    // 账户与 requestId 都由 operation 冻结，客户端不能替换。
    const otherAccount = await prepare(service, principal, 'record_advice_outcome', {
      adviceId,
      outcome: 'followed',
      accountId: 'someone-else',
    });
    expect(otherAccount.result.ok).toBe(false);
    const otherRequest = await prepare(service, principal, 'record_advice_outcome', {
      adviceId,
      outcome: 'followed',
      requestId: randomUUID(),
    });
    expect(otherRequest.result.ok).toBe(false);
  });

  it('writes a user feedback revision only after confirmation and replays without duplication', async () => {
    const { ctx, service, principal, adviceId } = await setup();
    const run = await runOperation(service, principal, 'record_advice_outcome', {
      adviceId,
      outcome: 'partially_followed',
      tradeIds: [],
      pnl: -80,
      benchmarkPnl: -30,
      comments: '不在 schema 内的字段应被剥离',
      notes: '只跟随了一部分',
      changeNote: '用户明确反馈',
    });
    expect(run.confirmed.state).toBe('succeeded');
    const result = operationResult<{
      outcome: {
        adviceId: string;
        outcome: string;
        pnl: number;
        benchmarkPnl: number;
        recordedAt: Date;
      };
    }>(run.confirmed);
    expect(result.outcome).toMatchObject({
      adviceId,
      outcome: 'partially_followed',
      pnl: -80,
      benchmarkPnl: -30,
    });
    expect(JSON.stringify(result.outcome)).not.toContain('comments');

    const review = await ctx.repos.decisionReview.findBySubject({
      accountId: principal.accountId,
      subject: { kind: 'advice', id: adviceId },
    });
    expect(review?.revision.content.adviceFeedback).toMatchObject({
      outcome: 'partially_followed',
      pnl: -80,
      benchmarkPnl: -30,
    });
    expect(review?.revision.content.note).toBe('只跟随了一部分');
    expect(review?.revision.changeNote).toBe('用户明确反馈');
    if (review === null) throw new Error('decision review missing');
    const revisions = await ctx.repos.decisionReview.listRevisions({
      accountId: principal.accountId,
      reviewId: review.review.id,
    });
    expect(revisions).toHaveLength(1);

    // 重复 confirm 走 operation 回执，不重复写 revision。
    const token = run.view.confirmationToken;
    if (token === undefined) throw new Error('missing token');
    const replay = prepared(await service.confirm(principal, { id: run.id, token }, signal()));
    expect(replay.state).toBe('succeeded');
    expect(
      await ctx.repos.decisionReview.listRevisions({
        accountId: principal.accountId,
        reviewId: review.review.id,
      }),
    ).toHaveLength(1);
  });

  it('writes nothing without a valid confirmation and never runs as a scheduled policy', async () => {
    const { ctx, service, principal, adviceId } = await setup();
    const pending = prepared(
      (
        await prepare(service, principal, 'record_advice_outcome', {
          adviceId,
          outcome: 'followed',
        })
      ).result,
    );
    const denied = await service.confirm(
      principal,
      { id: pending.operationId, token: 'not-the-token' },
      signal(),
    );
    expect(denied.ok).toBe(false);
    expect(
      await ctx.repos.decisionReview.findBySubject({
        accountId: principal.accountId,
        subject: { kind: 'advice', id: adviceId },
      }),
    ).toBeNull();

    const scheduled = await service.executeScheduled(
      { userId: principal.userId, sessionId: 's', taskId: 't' } as never,
      {
        grantId: 'grant',
        grantVersion: 1,
        occurrenceId: 'occurrence',
        tool: 'record_advice_outcome',
        accountId: principal.accountId,
        input: { adviceId, outcome: 'followed' },
      },
      signal(),
    );
    expect(scheduled.ok).toBe(false);
  });

  it('reconciles a user-feedback response loss from the decision review receipt', async () => {
    const nowMs = NOW;
    const base = await buildTestContext({ clock: () => new Date(nowMs) });
    const flaky = new FailOnceSettleRepository(base.repos.pluginAuthority);
    const counters = { commits: 0 };
    const countingDecisionReview = new Proxy(base.repos.decisionReview, {
      get(target, property) {
        if (property === 'commit')
          return (...args: Parameters<typeof target.commit>) => {
            counters.commits++;
            return target.commit(...args);
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const repositories = {
      ...base.repos,
      decisionReview: countingDecisionReview,
    } as RepositoryRegistry;
    const principal: PluginPrincipal = {
      userId: 'test-user',
      accountId: base.user.defaultAccountId,
    };
    const context = { ...base, repos: repositories };
    const service = createPluginOperationService({
      repository: flaky,
      policies: createStrategyOperationPolicies(),
      capabilities: ['read', 'write', 'external', 'queue'],
      policyVersion: 1,
      now: () => nowMs,
      context: () => context,
    });
    const adviceId = (await context.repos.advice.query({ includeExpired: true })).find(
      (advice) => advice.subjectId === '600519.SH',
    )?.id;
    if (adviceId === undefined) throw new Error('test advice fixture missing');
    const { id, result } = await prepare(service, principal, 'record_advice_outcome', {
      adviceId,
      outcome: 'ignored',
      notes: '用户明确未跟随',
    });
    const view = prepared(result);
    if (view.confirmationToken === undefined) throw new Error('missing token');
    const failed = await service.confirm(
      principal,
      { id, token: view.confirmationToken },
      signal(),
    );
    expect(failed.ok).toBe(false);
    expect(counters.commits).toBe(1);

    const reconciled = prepared(await service.reconcile(principal, id));
    expect(reconciled.state).toBe('succeeded');
    expect(counters.commits).toBe(1);
    const review = await context.repos.decisionReview.findBySubject({
      accountId: principal.accountId,
      subject: { kind: 'advice', id: adviceId },
    });
    expect(review?.revision.content.adviceFeedback).toMatchObject({ outcome: 'ignored' });
  });
});

/** settleOperation 第一次调用抛错，模拟「业务已提交、operation 回执未保存」。 */
class FailOnceSettleRepository implements PluginAuthorityRepository {
  private failed = false;
  constructor(private readonly inner: PluginAuthorityRepository) {}
  private delegate(): PluginAuthorityRepository {
    return this.inner;
  }
  insertOperation(operation: PluginOperation): Promise<boolean> {
    return this.delegate().insertOperation(operation);
  }
  findOperation(scope: PluginOperationScope): Promise<PluginOperation | null> {
    return this.delegate().findOperation(scope);
  }
  claimOperation(
    proof: PluginOperationProof & { readonly claimToken: string },
  ): Promise<PluginOperation | null> {
    return this.delegate().claimOperation(proof);
  }
  cancelOperation(proof: PluginOperationProof): Promise<boolean> {
    return this.delegate().cancelOperation(proof);
  }
  async settleOperation(
    input: Parameters<PluginAuthorityRepository['settleOperation']>[0],
  ): Promise<boolean> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('simulated operation receipt failure');
    }
    return this.delegate().settleOperation(input);
  }
  findGrant(id: string, userId: string): Promise<PluginAutomationGrant | null> {
    return this.delegate().findGrant(id, userId);
  }
  saveGrant(grant: PluginAutomationGrant, expectedVersion: number | null): Promise<boolean> {
    return this.delegate().saveGrant(grant, expectedVersion);
  }
}
