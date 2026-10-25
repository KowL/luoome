// 交互分析 record_* 原生确认操作测试（M2b-1）：prepare 冻结、审批门控、领域复核、
// 幂等/重放、response-loss reconcile 与服务能力门控。审批层本身（拒绝/晚到/子 Agent）
// 由 dsh-authority.e2e.test.ts 的通用 wrapper/guard 用例覆盖，这里覆盖 record 特有语义。
import { randomUUID } from 'node:crypto';
import type {
  AnalysisContext,
  PluginAuthorityRepository,
  PluginAutomationGrant,
  PluginOperation,
  PluginOperationProof,
  PluginOperationScope,
  RepositoryRegistry,
  ToolResult,
} from '@luoome/core';
import {
  analysisHash,
  type ConfirmablePluginTool,
  createPluginOperationService,
  defineTool,
  type PluginPrincipal,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createAnalysisOperationPolicies,
  createRecordAdviceOperation,
  createRecordAnalysisResultOperation,
  type TrustedAnalysisProvenance,
} from './analysis-operations.js';

const NOW = Date.parse('2026-07-02T01:00:00Z'); // 上海 09:00，盘中行动窗口内
const FACT_ID = 'quote:600519.SH';
const TRUSTED: TrustedAnalysisProvenance = {
  generatorKind: 'dsh-chat',
  model: 'acceptance-model',
};
const signal = (): AbortSignal => new AbortController().signal;

const adviceResult = {
  decision: 'watch',
  confidence: 55,
  horizon: 'short',
  reasoning: {
    premise: '等待方向选择',
    evidence: ['日线均线粘合'],
    counterEvidence: ['板块整体回暖'],
  },
  risks: ['大盘系统性下行风险'],
} as const;

const researchResult = {
  kind: 'research_directions',
  question: '接下来关注什么？',
  directions: [],
  limitations: ['样本有限'],
} as const;

const data = <T>(result: ToolResult<unknown>): T => {
  if (!result.ok) throw new Error(`operation failed: ${JSON.stringify(result)}`);
  return result.data as T;
};

type Prepared = {
  readonly operationId: string;
  readonly confirmationToken?: string;
  readonly accountId: string;
  readonly input: Record<string, unknown>;
  readonly state: string;
  readonly result?: unknown;
  readonly expiresAt: number;
};

const adviceInput = (contextId: string, overrides: Record<string, unknown> = {}) => ({
  contextId,
  result: adviceResult,
  provenance: {
    generatorKind: 'legacy-ai',
    model: 'client-model',
    skillVersion: 'client-skill',
    promptHash: 'client-prompt',
    sessionRef: 'client-session',
    evidenceFactIds: [FACT_ID],
  },
  ...overrides,
});

const baseContext = (
  kind: AnalysisContext['kind'],
  subject: AnalysisContext['subject'],
  overrides: Partial<AnalysisContext> = {},
): AnalysisContext => {
  const facts = overrides.facts ?? [
    { id: FACT_ID, label: '合成行情', value: { close: 100 }, evidenceIds: [] },
  ];
  const dataAsOf = overrides.dataAsOf ?? new Date(NOW);
  return {
    id: `ctx-${randomUUID()}`,
    jobId: null,
    kind,
    accountId: overrides.accountId ?? 'owner-account',
    subject,
    dataAsOf,
    facts,
    factIds: facts.map((fact) => fact.id),
    limitations: [],
    contextHash: analysisHash({ facts, dataAsOf }),
    writeUntil: new Date(NOW + 30 * 60_000),
    expiresAt: new Date(NOW + 60 * 60_000),
    createdAt: dataAsOf,
    ...overrides,
  };
};

const setup = async (
  options: {
    readonly trusted?: TrustedAnalysisProvenance;
    readonly capabilities?: readonly ('read' | 'write' | 'external' | 'queue')[];
    readonly policies?: readonly ConfirmablePluginTool[];
    readonly repository?: PluginAuthorityRepository;
  } = {},
) => {
  let nowMs = NOW;
  const base = await buildTestContext({ clock: () => new Date(nowMs) });
  const owner = base.user.defaultAccountId;
  const principal: PluginPrincipal = { userId: 'test-user', accountId: owner };
  const context = base;
  const policies = options.policies ?? createAnalysisOperationPolicies(options.trusted ?? TRUSTED);
  const service = createPluginOperationService({
    repository: options.repository ?? base.repos.pluginAuthority,
    policies,
    capabilities: options.capabilities ?? ['read', 'write', 'external', 'queue'],
    policyVersion: 1,
    now: () => nowMs,
    context: () => context,
  });
  const saveContext = async (
    kind: AnalysisContext['kind'],
    subject: AnalysisContext['subject'],
    overrides: Partial<AnalysisContext> = {},
  ) => {
    const created = baseContext(kind, subject, { accountId: owner, ...overrides });
    await base.repos.analysis.saveContext(created);
    return created;
  };
  const adviceContext = (overrides: Partial<AnalysisContext> = {}) =>
    saveContext(
      'advice_stock',
      { kind: 'stock', id: '600519.SH' },
      {
        facts: [{ id: FACT_ID, label: '合成行情', value: { close: 100 }, evidenceIds: [] }],
        ...overrides,
      },
    );
  const researchContext = () =>
    saveContext(
      'research_directions',
      { kind: 'research', id: 'research-topic' },
      {
        facts: [],
        factIds: [],
        writeUntil: new Date(NOW + 24 * 60 * 60_000),
        expiresAt: new Date(NOW + 24 * 60 * 60_000),
      },
    );
  const advance = (ms: number): void => {
    nowMs += ms;
  };
  return {
    ctx: base,
    context,
    service,
    principal,
    now: () => nowMs,
    advance,
    adviceContext,
    researchContext,
  };
};

const prepare = (
  service: ReturnType<typeof createPluginOperationService>,
  principal: PluginPrincipal,
  tool: string,
  input: unknown,
) => {
  const id = randomUUID();
  return service.prepare(principal, { id, tool, input }).then((result) => ({ id, result }));
};

afterEach(() => {
  delete process.env.LUOOME_EXPOSE_TRADE;
});

describe('analysis operation policies', () => {
  it('prepares an advice operation with frozen account/context/result and trusted provenance', async () => {
    const { service, principal, adviceContext } = await setup();
    const context = await adviceContext();
    const { id, result } = await prepare(service, principal, 'record_advice', {
      ...adviceInput(context.id),
      approved: true,
      callId: 'model-reported-call',
      taskId: 'model-reported-task',
    });
    const prepared = data<Prepared>(result);
    expect(prepared.operationId).toBe(id);
    expect(prepared.confirmationToken).toBeTruthy();
    expect(prepared.accountId).toBe(principal.accountId);
    expect(prepared.input).toMatchObject({
      accountId: principal.accountId,
      requestId: id,
      contextId: context.id,
      result: adviceResult,
    });
    // 客户端自报的 provenance 身份全部丢弃，只保留受信任装配置入的值。
    expect(prepared.input.provenance).toEqual({
      generatorKind: 'dsh-chat',
      model: 'acceptance-model',
      evidenceFactIds: [FACT_ID],
    });
    const serialized = JSON.stringify(prepared.input);
    expect(serialized).not.toContain('approved');
    expect(serialized).not.toContain('model-reported');
    expect(serialized).not.toContain('client-model');
    expect(serialized).not.toContain('client-session');
  });

  it('rejects a client-supplied account or requestId instead of letting it replace the frozen envelope', async () => {
    const { service, principal, adviceContext } = await setup();
    const context = await adviceContext();
    const otherAccount = await prepare(service, principal, 'record_advice', {
      ...adviceInput(context.id),
      accountId: 'someone-else',
    });
    expect(otherAccount.result.ok).toBe(false);
    const otherRequest = await prepare(service, principal, 'record_advice', {
      ...adviceInput(context.id),
      requestId: 'model-chosen-request',
    });
    expect(otherRequest.result.ok).toBe(false);
  });

  it('does not rotate credentials on repeated prepare and rejects same-key different input', async () => {
    const { service, principal, adviceContext } = await setup();
    const context = await adviceContext();
    const id = randomUUID();
    const input = adviceInput(context.id);
    const first = data<Prepared>(
      await service.prepare(principal, { id, tool: 'record_advice', input }),
    );
    const token = first.confirmationToken;
    if (token === undefined) throw new Error('first prepare did not issue a token');
    const repeated = await service.prepare(principal, { id, tool: 'record_advice', input });
    expect(repeated.ok).toBe(true);
    expect(JSON.stringify(repeated)).not.toContain(token);
    const conflicting = await service.prepare(principal, {
      id,
      tool: 'record_advice',
      input: { ...adviceInput(context.id), result: { ...adviceResult, confidence: 99 } },
    });
    expect(conflicting.ok).toBe(false);
    // 首次凭据仍有效：重复 prepare 没有换发新凭据。
    const confirmed = await service.confirm(principal, { id, token }, signal());
    expect(data<{ state: string }>(confirmed).state).toBe('succeeded');
  });

  it('executes the domain record once and keeps replay/reconcile free of duplicate writes', async () => {
    const { ctx, service, principal, adviceContext } = await setup();
    const context = await adviceContext();
    const { id, result } = await prepare(
      service,
      principal,
      'record_advice',
      adviceInput(context.id),
    );
    const token = data<Prepared>(result).confirmationToken;
    if (token === undefined) throw new Error('missing token');
    const confirmed = data<{ state: string; result: { ok: boolean } }>(
      await service.confirm(principal, { id, token }, signal()),
    );
    expect(confirmed.state).toBe('succeeded');
    expect(confirmed.result.ok).toBe(true);
    const advice = await ctx.repos.advice.findById(`analysis:${context.id}`);
    expect(advice?.decision).toBe('watch');
    const storedContext = await ctx.repos.analysis.findContext(principal.accountId, context.id);
    expect(storedContext?.recordedResult?.ref).toBe(`analysis:${context.id}`);

    const replay = data<{ state: string }>(
      await service.confirm(principal, { id, token }, signal()),
    );
    expect(replay.state).toBe('succeeded');
    const reconciled = data<{ state: string; result: unknown }>(
      await service.reconcile(principal, id),
    );
    expect(reconciled.state).toBe('succeeded');
    expect(
      (await ctx.repos.advice.query({ includeExpired: true })).filter(
        (item) => item.id === `analysis:${context.id}`,
      ),
    ).toHaveLength(1);
  });

  it('writes nothing when the domain rejects an expired context', async () => {
    const { ctx, service, principal, adviceContext } = await setup();
    const context = await adviceContext({
      writeUntil: new Date(NOW - 60_000),
      expiresAt: new Date(NOW + 60_000),
    });
    const { id, result } = await prepare(
      service,
      principal,
      'record_advice',
      adviceInput(context.id),
    );
    const token = data<Prepared>(result).confirmationToken;
    if (token === undefined) throw new Error('missing token');
    const confirmed = data<{ state: string; result: { ok: boolean; error?: unknown } }>(
      await service.confirm(principal, { id, token }, signal()),
    );
    expect(confirmed.state).toBe('unknown');
    expect(confirmed.result.ok).toBe(false);
    expect(await ctx.repos.advice.findById(`analysis:${context.id}`)).toBeNull();
    const reconciled = data<{ state: string }>(await service.reconcile(principal, id));
    expect(reconciled.state).toBe('unknown');
    expect(await ctx.repos.advice.findById(`analysis:${context.id}`)).toBeNull();
  });

  it('does not write on cancel, cross-account confirm or expired operation', async () => {
    const { ctx, service, principal, adviceContext } = await setup();
    const context = await adviceContext();
    const cancelled = data<Prepared>(
      await prepare(service, principal, 'record_advice', adviceInput(context.id)).then(
        (r) => r.result,
      ),
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
    const afterCancel = data<{ state: string }>(
      await service.confirm(
        principal,
        { id: cancelled.operationId, token: cancelled.confirmationToken },
        signal(),
      ),
    );
    expect(afterCancel.state).toBe('cancelled');

    const crossAccount = data<Prepared>(
      await prepare(service, principal, 'record_advice', adviceInput(context.id)).then(
        (r) => r.result,
      ),
    );
    if (crossAccount.confirmationToken === undefined) throw new Error('missing token');
    const denied = await service.confirm(
      { ...principal, accountId: 'other-account' },
      { id: crossAccount.operationId, token: crossAccount.confirmationToken },
      signal(),
    );
    expect(denied.ok).toBe(false);

    const {
      service: lateService,
      advance,
      principal: latePrincipal,
      adviceContext: lateContext,
    } = await setup();
    const otherContext = await lateContext();
    const late = data<Prepared>(
      await prepare(lateService, latePrincipal, 'record_advice', adviceInput(otherContext.id)).then(
        (r) => r.result,
      ),
    );
    if (late.confirmationToken === undefined) throw new Error('missing token');
    advance(600_000);
    const expiredConfirm = await lateService.confirm(
      latePrincipal,
      { id: late.operationId, token: late.confirmationToken },
      signal(),
    );
    expect(expiredConfirm.ok).toBe(false);
    expect(await ctx.repos.advice.findById(`analysis:${context.id}`)).toBeNull();
  });

  it('reconciles a response loss from the recorded business result without replaying the handler', async () => {
    const counters = { advice: 0, publication: 0 };
    const nowMs = NOW;
    const base = await buildTestContext({ clock: () => new Date(nowMs) });
    const flaky = new FailOnceSettleRepository(base.repos.pluginAuthority);
    const owner = base.user.defaultAccountId;
    const principal: PluginPrincipal = { userId: 'test-user', accountId: owner };
    const countingAnalysis = new Proxy(base.repos.analysis, {
      get(target, property) {
        if (property === 'recordAdvice')
          return (input: Parameters<typeof target.recordAdvice>[0]) => {
            counters.advice++;
            return target.recordAdvice(input);
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const repositories = { ...base.repos, analysis: countingAnalysis } as RepositoryRegistry;
    const service = createPluginOperationService({
      repository: flaky,
      policies: createAnalysisOperationPolicies(TRUSTED),
      capabilities: ['read', 'write', 'external', 'queue'],
      policyVersion: 1,
      now: () => nowMs,
      context: () => ({ ...base, repos: repositories }),
    });
    const context = baseContext(
      'advice_stock',
      { kind: 'stock', id: '600519.SH' },
      { accountId: owner },
    );
    await base.repos.analysis.saveContext(context);
    const { id, result } = await prepare(
      service,
      principal,
      'record_advice',
      adviceInput(context.id),
    );
    const token = data<Prepared>(result).confirmationToken;
    if (token === undefined) throw new Error('missing token');
    // 业务提交后、operation 回执保存前失败：confirm 返回 internal，operation 留在 executing。
    const failed = await service.confirm(principal, { id, token }, signal());
    expect(failed.ok).toBe(false);
    expect(counters.advice).toBe(1);
    const executing = await flaky.findOperation({ ...principal, id });
    expect(executing?.state).toBe('executing');
    // reconcile 只读取 context.recordedResult 恢复回执，不再执行 handler。
    const reconciled = data<{ state: string; result: unknown }>(
      await service.reconcile(principal, id),
    );
    expect(reconciled.state).toBe('succeeded');
    expect(counters.advice).toBe(1);
  });

  it('records research publications and never turns domain failures into success', async () => {
    const counters = { publications: 0 };
    const nowMs = NOW;
    const base = await buildTestContext({ clock: () => new Date(nowMs) });
    const owner = base.user.defaultAccountId;
    const principal: PluginPrincipal = { userId: 'test-user', accountId: owner };
    const countingAnalysis = new Proxy(base.repos.analysis, {
      get(target, property) {
        if (property === 'recordPublication')
          return (input: Parameters<typeof target.recordPublication>[0]) => {
            counters.publications++;
            return target.recordPublication(input);
          };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const repositories = { ...base.repos, analysis: countingAnalysis } as RepositoryRegistry;
    const service = createPluginOperationService({
      repository: base.repos.pluginAuthority,
      policies: createAnalysisOperationPolicies(TRUSTED),
      capabilities: ['read', 'write', 'external', 'queue'],
      policyVersion: 1,
      now: () => nowMs,
      context: () => ({ ...base, repos: repositories }),
    });
    const research = baseContext(
      'research_directions',
      { kind: 'research', id: 'research-topic' },
      {
        accountId: owner,
        facts: [],
        factIds: [],
        writeUntil: new Date(NOW + 24 * 60 * 60_000),
        expiresAt: new Date(NOW + 24 * 60 * 60_000),
      },
    );
    await base.repos.analysis.saveContext(research);
    const publicationInput = {
      contextId: research.id,
      result: researchResult,
      provenance: { generatorKind: 'legacy-ai', evidenceFactIds: [] },
    };
    const { id, result } = await prepare(
      service,
      principal,
      'record_analysis_result',
      publicationInput,
    );
    const token = data<Prepared>(result).confirmationToken;
    if (token === undefined) throw new Error('missing token');
    const confirmed = data<{
      state: string;
      result: { ok: boolean; data?: { replayed?: boolean } };
    }>(await service.confirm(principal, { id, token }, signal()));
    expect(confirmed.state).toBe('succeeded');
    expect(confirmed.result.ok).toBe(true);
    expect(counters.publications).toBe(1);
    const replay = data<{ state: string }>(
      await service.confirm(principal, { id, token }, signal()),
    );
    expect(replay.state).toBe('succeeded');
    expect(counters.publications).toBe(1);
    const receipt = await service.reconcile(principal, id);
    expect(data<{ state: string }>(receipt).state).toBe('succeeded');

    // 把 advice context 交给 research publication policy：领域返回 context_mismatch，不写成功。
    const advice = baseContext(
      'advice_stock',
      { kind: 'stock', id: '600519.SH' },
      { accountId: owner },
    );
    await base.repos.analysis.saveContext(advice);
    const mismatched = await prepare(service, principal, 'record_analysis_result', {
      ...publicationInput,
      contextId: advice.id,
    });
    const mismatchedToken = data<Prepared>(mismatched.result).confirmationToken;
    if (mismatchedToken === undefined) throw new Error('missing token');
    const rejected = data<{ state: string; result: { ok: boolean } }>(
      await service.confirm(principal, { id: mismatched.id, token: mismatchedToken }, signal()),
    );
    expect(rejected.state).toBe('unknown');
    expect(rejected.result.ok).toBe(false);
    const storedAdvice = await base.repos.analysis.findContext(owner, advice.id);
    expect(storedAdvice?.recordedResult).toBeUndefined();
    expect(
      (
        await base.repos.investmentWorkspace.listResearch({
          ownerUserId: 'test-user',
          accountId: owner,
          limit: 10,
        })
      ).length,
    ).toBe(1);
    expect(
      await base.repos.investmentWorkspace.findResearch({
        ownerUserId: 'test-user',
        accountId: owner,
        requestId: `analysis:${advice.id}`,
      }),
    ).toBeNull();
  });

  it('requires explicit queue capability and never allows trade policies', async () => {
    const { ctx, principal, adviceContext } = await setup();
    const context = await adviceContext();
    expect(() =>
      createPluginOperationService({
        repository: ctx.repos.pluginAuthority,
        policies: createAnalysisOperationPolicies(TRUSTED),
        capabilities: ['read', 'write', 'external'],
        policyVersion: 1,
        now: () => NOW,
        context: () => ctx,
      }),
    ).toThrow('Unsupported operation capability');
    const tradeTool = defineTool({
      name: 'fixture_trade_operation',
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
        capabilities: ['read', 'write', 'external', 'queue'],
        policyVersion: 1,
        now: () => NOW,
        context: () => ctx,
      }),
    ).toThrow('Unsupported operation capability');
    // queue 开启后仍只对精确 policy 生效；prepare 未注册的工具被拒绝。
    const unknown = await prepare(
      createPluginOperationService({
        repository: ctx.repos.pluginAuthority,
        policies: createAnalysisOperationPolicies(TRUSTED),
        capabilities: ['read', 'write', 'external', 'queue'],
        policyVersion: 1,
        now: () => NOW,
        context: () => ctx,
      }),
      principal,
      'claim_analysis_jobs',
      {},
    );
    expect(unknown.result.ok).toBe(false);
    const advice = await prepare(
      createPluginOperationService({
        repository: ctx.repos.pluginAuthority,
        policies: createAnalysisOperationPolicies(TRUSTED),
        capabilities: ['read', 'write', 'external', 'queue'],
        policyVersion: 1,
        now: () => NOW,
        context: () => ctx,
      }),
      principal,
      'record_advice',
      adviceInput(context.id),
    );
    expect(advice.result.ok).toBe(true);
  });

  it('exposes only the exact record policies in the production bundle', () => {
    const policies = createAnalysisOperationPolicies(TRUSTED);
    expect(policies.map((policy) => policy.tool.name)).toEqual([
      'record_advice',
      'record_analysis_result',
    ]);
    for (const policy of policies) {
      expect(policy.scheduled).toBe(false);
      expect(policy.tool.sideEffect).toBe('queue');
      expect(policy.tool.requiredCapabilities).toEqual(['queue']);
    }
    expect(createRecordAdviceOperation(TRUSTED).tool.name).toBe('record_advice');
    expect(createRecordAnalysisResultOperation(TRUSTED).tool.name).toBe('record_analysis_result');
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
