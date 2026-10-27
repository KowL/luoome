import { randomUUID } from 'node:crypto';
import {
  type PluginAuthorityRepository,
  type StrategyDslV1,
  strategyDefinitionHash,
  type ToolResult,
} from '@luoome/core';
import {
  createPluginOperationService,
  getStrategyEvaluationSessionTool,
  getStrategyResearchStateTool,
  type PluginPrincipal,
} from '@luoome/tools';
import { buildTestContext, seedTestStockUniverse } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { createResearchJobs } from './research-jobs.js';
import {
  createResearchOperationPolicies,
  operationEvaluationSessionId,
} from './research-operations.js';

const now = new Date('2026-10-27T09:00:00.000Z');
const signal = () => new AbortController().signal;
const definition: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: { horizon: 'short' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'positive', name: '正价格', when: 'quote.close > 0', evidence: ['收盘价'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
};
type View = {
  operationId: string;
  accountId: string;
  state: string;
  input: Record<string, unknown>;
  confirmationToken?: string;
  result: ToolResult<{
    session?: { id: string; status: string; error?: string };
    worker?: string;
    run?: { resultAvailability: string; metrics?: unknown };
  }> | null;
};
const data = <T>(result: ToolResult<T>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.data;
};
const view = (result: ToolResult<unknown>) => data(result) as View;

const setup = async (options: Parameters<typeof createResearchJobs>[0] = {}) => {
  const ctx = await buildTestContext({ clock: () => now });
  await seedTestStockUniverse(ctx, { limit: 1, observedAt: new Date('2026-10-26T08:00:00.000Z') });
  const principal: PluginPrincipal = { userId: ctx.user.id, accountId: ctx.user.defaultAccountId };
  for (const strategyId of ['research-a', 'research-b']) {
    await ctx.repos.strategy.create({
      id: strategyId,
      name: '合成研究',
      description: '测试',
      owner: 'user',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });
    for (const version of [1, 2])
      await ctx.repos.strategy.createVersion({
        id: `${strategyId}-v${version}`,
        strategyId,
        version,
        definition,
        definitionHash: strategyDefinitionHash(definition),
        validationStatus: 'valid',
        validationErrors: [],
        createdAt: now,
      });
  }
  const jobs = createResearchJobs(options);
  const serviceFor = (repository = ctx.repos.pluginAuthority, runtime = jobs) =>
    createPluginOperationService({
      repository,
      policies: createResearchOperationPolicies(runtime),
      capabilities: ['read', 'write', 'external', 'queue'],
      policyVersion: 1,
      now: () => now.getTime(),
      context: () => ctx,
    });
  const service = serviceFor();
  const prepare = async (tool: string, input: unknown, target = service) => {
    const operationId = randomUUID();
    return view(await target.prepare(principal, { id: operationId, tool, input }));
  };
  const confirm = async (operation: View, target = service) => {
    if (operation.confirmationToken === undefined) throw new Error('Missing confirmation token');
    return view(
      await target.confirm(
        principal,
        { id: operation.operationId, token: operation.confirmationToken },
        signal(),
      ),
    );
  };
  const startInput = {
    strategyId: 'research-a',
    versionId: 'research-a-v1',
    from: '2026-10-23',
    to: '2026-10-26',
    stockIds: ['600519.SH'],
  };
  return { ctx, principal, jobs, service, serviceFor, prepare, confirm, startInput };
};

describe('research operation binding and task lifecycle', () => {
  it('freezes account, immutable version and idempotent request before independent approval', async () => {
    const { service, principal, prepare, ctx, startInput } = await setup();
    for (const input of [
      { ...startInput, accountId: 'foreign' },
      { ...startInput, requestId: randomUUID() },
      { ...startInput, versionId: 'research-b-v1' },
      { ...startInput, versionId: undefined },
      { ...startInput, approved: true },
    ])
      expect(
        (
          await service.prepare(principal, {
            id: randomUUID(),
            tool: 'start_strategy_evaluation_session',
            input,
          })
        ).ok,
      ).toBe(false);
    const pending = await prepare('start_strategy_evaluation_session', startInput);
    expect(pending.input.accountId).toBe(principal.accountId);
    expect(pending.input.requestId).toBe(pending.operationId);
    const sessionId = operationEvaluationSessionId('research-a', pending.operationId);
    expect(
      data(await getStrategyEvaluationSessionTool.execute({ sessionId }, ctx)).session,
    ).toBeNull();
    expect(
      (
        await service.confirm(
          { ...principal, accountId: 'foreign' },
          { id: pending.operationId, token: pending.confirmationToken as string },
          signal(),
        )
      ).ok,
    ).toBe(false);
    expect(
      (await service.confirm(principal, { id: pending.operationId, token: 'wrong' }, signal())).ok,
    ).toBe(false);
    expect(
      data(await getStrategyEvaluationSessionTool.execute({ sessionId }, ctx)).session,
    ).toBeNull();
    expect(service.descriptors().map((item) => item.name)).not.toContain(
      'record_strategy_evaluation_day',
    );
    expect(service.descriptors().map((item) => item.name)).not.toContain(
      'finish_strategy_evaluation_session',
    );
  });

  it('returns acceptance immediately and keeps light reads responsive during work', async () => {
    let release: (() => void) | undefined;
    const replay = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ok: false as const,
        error: { kind: 'invalid_input' as const, message: 'synthetic missing PIT', issues: [] },
      };
    });
    const { prepare, confirm, jobs, ctx, startInput } = await setup({ replay });
    const pending = await prepare('start_strategy_evaluation_session', startInput);
    const accepted = await confirm(pending);
    const result = data(accepted.result as NonNullable<View['result']>);
    expect(accepted.state).toBe('succeeded');
    expect(result.worker).toBe('running');
    const sessionId = result.session?.id as string;
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(1));
    const read = await Promise.race([
      getStrategyEvaluationSessionTool.execute({ sessionId }, ctx),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('light read blocked')), 100),
      ),
    ]);
    expect(data(read).session?.status).toBe('running');
    expect((await confirm(pending)).state).toBe('succeeded');
    expect(replay).toHaveBeenCalledTimes(1);
    release?.();
    await jobs.settled();
    expect(
      data(await getStrategyEvaluationSessionTool.execute({ sessionId }, ctx)).session?.status,
    ).toBe('failed');
    expect(jobs.status(sessionId)).toBe('idle');
  });

  it('cancels the exact session without deleting checkpoints and resumes only after another approval', async () => {
    const { prepare, confirm, jobs, ctx, startInput, service, principal } = await setup();
    const pending = await prepare('start_strategy_evaluation_session', startInput);
    const sessionId = operationEvaluationSessionId('research-a', pending.operationId);
    await confirm(pending);
    const control = { strategyId: 'research-a', versionId: 'research-a-v1', sessionId };
    expect(
      (
        await service.prepare(principal, {
          id: randomUUID(),
          tool: 'cancel_strategy_evaluation_session',
          input: { ...control, strategyId: 'research-b' },
        })
      ).ok,
    ).toBe(false);
    const cancelled = await confirm(await prepare('cancel_strategy_evaluation_session', control));
    expect(data(cancelled.result as NonNullable<View['result']>).session?.error).toBe(
      'evaluation_cancelled',
    );
    await jobs.settled();
    expect(
      data(await getStrategyEvaluationSessionTool.execute({ sessionId }, ctx)).session?.error,
    ).toBe('evaluation_cancelled');
    const resume = await prepare('resume_strategy_evaluation_session', control);
    expect(
      data(await getStrategyEvaluationSessionTool.execute({ sessionId }, ctx)).session?.status,
    ).toBe('failed');
    await confirm(resume);
    await jobs.settled();
    expect(
      data(await getStrategyEvaluationSessionTool.execute({ sessionId }, ctx)).session?.id,
    ).toBe(sessionId);
  });

  it('reconciles response loss by exact request identity without starting another job', async () => {
    const replay = vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'invalid_input' as const, message: 'no historical data', issues: [] },
    }));
    const { ctx, principal, serviceFor, prepare, jobs, startInput } = await setup({ replay });
    let fail = true;
    const repository = new Proxy(ctx.repos.pluginAuthority, {
      get(target, key) {
        if (key === 'settleOperation')
          return async (...args: Parameters<PluginAuthorityRepository['settleOperation']>) => {
            if (fail) {
              fail = false;
              throw new Error('synthetic response loss');
            }
            return target.settleOperation(...args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const service = serviceFor(repository);
    const pending = await prepare('start_strategy_evaluation_session', startInput, service);
    expect(
      (
        await service.confirm(
          principal,
          { id: pending.operationId, token: pending.confirmationToken as string },
          signal(),
        )
      ).ok,
    ).toBe(false);
    const reconciled = view(await service.reconcile(principal, pending.operationId));
    expect(reconciled.state).toBe('succeeded');
    expect(data(reconciled.result as NonNullable<View['result']>).session?.id).toBe(
      operationEvaluationSessionId('research-a', pending.operationId),
    );
    await jobs.settled();
    expect(replay).toHaveBeenCalledTimes(1);
    await service.reconcile(principal, pending.operationId);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('keeps a cold recovered session idle until an explicit resume', async () => {
    const first = await setup();
    const pending = await first.prepare('start_strategy_evaluation_session', first.startInput);
    const sessionId = operationEvaluationSessionId('research-a', pending.operationId);
    await first.confirm(pending);
    first.jobs.dispose();
    await first.jobs.settled();
    const replay = vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'invalid_input' as const, message: 'missing PIT', issues: [] },
    }));
    const recovered = createResearchJobs({ replay });
    const service = first.serviceFor(first.ctx.repos.pluginAuthority, recovered);
    expect(recovered.status(sessionId)).toBe('idle');
    expect(
      data(await getStrategyEvaluationSessionTool.execute({ sessionId }, first.ctx)).session
        ?.status,
    ).toBe('running');
    expect(replay).not.toHaveBeenCalled();
    await first.confirm(
      await first.prepare(
        'resume_strategy_evaluation_session',
        { strategyId: 'research-a', versionId: 'research-a-v1', sessionId },
        service,
      ),
      service,
    );
    await recovered.settled();
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('preserves strict backtest gaps instead of fabricating metrics', async () => {
    const { prepare, confirm, jobs, startInput } = await setup();
    const pending = await prepare('start_strategy_evaluation_session', startInput);
    const sessionId = operationEvaluationSessionId('research-a', pending.operationId);
    await confirm(pending);
    await jobs.settled();
    const result = await confirm(
      await prepare('create_strict_strategy_backtest', {
        strategyId: 'research-a',
        versionId: 'research-a-v1',
        evaluationSessionId: sessionId,
        costs: {
          commissionBps: 3,
          minimumCommission: 5,
          sellStampDutyBps: 5,
          buySlippageBps: 10,
          sellSlippageBps: 10,
        },
      }),
    );
    const output = data(result.result as NonNullable<View['result']>);
    expect(['partial', 'unavailable']).toContain(output.run?.resultAvailability);
    expect(output.run?.metrics).toBeUndefined();
  });

  it('keeps scan time live, binds all comparison versions and stores the shared snapshot receipt', async () => {
    const { prepare, confirm, service, principal } = await setup();
    const input = {
      strategyId: 'research-a',
      baseVersionId: 'research-a-v1',
      draftVersionId: 'research-a-v2',
      stockIds: ['600519.SH'],
      mode: 'scan',
    };
    for (const bad of [
      { ...input, asOf: now.toISOString() },
      { ...input, mode: 'replay' },
      { ...input, draftVersionId: 'research-b-v1' },
    ])
      expect(
        (
          await service.prepare(principal, {
            id: randomUUID(),
            tool: 'trial_strategy_version',
            input: bad,
          })
        ).ok,
      ).toBe(false);
    const pending = await prepare('trial_strategy_version', input);
    expect(pending.input.asOf).toBeUndefined();
    const trial = await confirm(pending);
    data(trial.result as NonNullable<View['result']>);
    expect(trial.result).toMatchObject({
      ok: true,
      data: { persisted: false, inputIdentity: { persisted: false, mode: 'scan' } },
    });
    const comparison = await confirm(
      await prepare('run_strategy_research_comparison', {
        strategyId: 'research-a',
        baseVersionId: 'research-a-v1',
        candidateVersionIds: ['research-a-v2'],
        stockIds: ['600519.SH'],
        mode: 'scan',
      }),
    );
    expect(comparison.result).toMatchObject({
      ok: true,
      data: {
        persisted: false,
        candidates: [{ candidateVersionId: 'research-a-v2', status: 'complete' }],
      },
    });
  });

  it('saves account-bound research with CAS and exact response-loss reconciliation', async () => {
    const fixture = await setup();
    const { ctx, serviceFor, principal, prepare } = fixture;
    let fail = true;
    const repository = new Proxy(ctx.repos.pluginAuthority, {
      get(target, key) {
        if (key === 'settleOperation')
          return async (...args: Parameters<PluginAuthorityRepository['settleOperation']>) => {
            if (fail) {
              fail = false;
              throw new Error('synthetic save receipt loss');
            }
            return target.settleOperation(...args);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const service = serviceFor(repository);
    const input = {
      strategyId: 'research-a',
      expectedRevision: 0,
      state: {
        question: '提高门槛是否减少临界结果？',
        baseVersionId: 'research-a-v1',
        candidateVersionId: 'research-a-v2',
        stockIds: ['600519.SH'],
        nextStep: '等待同快照对照',
        conclusion: {
          summary: '数据不足，保持待定。',
          outcome: 'inconclusive',
          limitations: ['只保存问题，尚无验证证据。'],
          evidenceReferences: [],
        },
      },
    };
    const pending = await prepare('save_strategy_research_state', input, service);
    expect(pending.input.requestId).toBe(pending.operationId);
    expect(
      (
        await service.confirm(
          principal,
          { id: pending.operationId, token: pending.confirmationToken as string },
          signal(),
        )
      ).ok,
    ).toBe(false);
    expect(view(await service.reconcile(principal, pending.operationId)).state).toBe('succeeded');
    const saved = data(
      await getStrategyResearchStateTool.execute(
        { strategyId: 'research-a', accountId: principal.accountId },
        ctx,
      ),
    );
    expect(saved.state?.revision).toBe(1);
    expect(saved.state?.conclusions).toHaveLength(1);
    expect(saved.state?.state.question).toBe(input.state.question);
    const conflict = await fixture.confirm(
      await fixture.prepare('save_strategy_research_state', {
        ...input,
        state: { ...input.state, question: '过期页面不能覆盖' },
      }),
    );
    expect(conflict.result).toMatchObject({ ok: false, error: { kind: 'invalid_input' } });
    expect(
      data(await getStrategyResearchStateTool.execute({ strategyId: 'research-a' }, ctx)).state
        ?.state.question,
    ).toBe(input.state.question);
  });
});
