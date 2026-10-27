import { createHash } from 'node:crypto';
import type { StrategyEvaluationSession, ToolContext, ToolResult } from '@luoome/core';
import {
  type ConfirmablePluginTool,
  CreateStrictStrategyBacktestInput,
  CreateStrictStrategyBacktestOutput,
  cancelStrategyEvaluationSessionTool,
  createStrictStrategyBacktestTool,
  defineTool,
  errInvalidInput,
  errNotFound,
  getStrategyEvaluationSessionTool,
  getStrategyResearchStateTool,
  getStrategyTool,
  getStrictStrategyBacktestTool,
  PluginOperationScopeError,
  type PluginPrincipal,
  pluginInputJson,
  RunStrategyResearchComparisonInput,
  RunStrategyResearchComparisonOutput,
  resumeStrategyEvaluationSessionTool,
  runStrategyResearchComparisonTool,
  SaveStrategyResearchStateInput,
  StartStrategyEvaluationSessionInput,
  StartStrategyEvaluationSessionOutput,
  saveStrategyResearchStateTool,
  startStrategyEvaluationSessionTool,
  TrialStrategyVersionInput,
  TrialStrategyVersionOutput,
  trialStrategyVersionTool,
} from '@luoome/tools';
import { z } from 'zod';
import type { ResearchJobs } from './research-jobs.js';

const id = z.string().min(1).max(200);

export const StartResearchEvaluationInput = StartStrategyEvaluationSessionInput.extend({
  accountId: id,
  versionId: id,
  requestId: z.uuid(),
})
  .strict()
  .superRefine((input, ctx) => {
    if (input.from > input.to || input.to.getTime() - input.from.getTime() > 366 * 86_400_000)
      ctx.addIssue({
        code: 'custom',
        path: ['from'],
        message: 'Research evaluation range must be ordered and no longer than 366 days',
      });
  });

export const ResearchEvaluationControlInput = z
  .object({ accountId: id, strategyId: id, versionId: id, sessionId: id })
  .strict();

export const operationEvaluationSessionId = (strategyId: string, requestId: string): string =>
  `strategy-evaluation-request:${createHash('sha256').update(`${strategyId}\0${requestId}`).digest('hex')}`;

const bindScope = (
  raw: unknown,
  principal: PluginPrincipal,
  ctx: ToolContext,
  requestId?: string,
) => {
  const input = z.record(z.string(), z.unknown()).parse(raw);
  if (
    principal.userId !== ctx.user.id ||
    principal.accountId !== ctx.user.defaultAccountId ||
    (input.accountId !== undefined && input.accountId !== principal.accountId)
  )
    throw new PluginOperationScopeError('accountId');
  if (requestId !== undefined && input.requestId !== undefined && input.requestId !== requestId)
    throw new PluginOperationScopeError('requestId');
  return {
    ...input,
    accountId: principal.accountId,
    ...(requestId === undefined ? {} : { requestId }),
  };
};

const assertVersions = async (
  strategyId: string,
  versionIds: readonly string[],
  ctx: ToolContext,
  requireValid = false,
) => {
  const strategy = await getStrategyTool.execute({ strategyId }, ctx);
  if (!strategy.ok) throw new Error('Strategy unavailable');
  for (const versionId of versionIds)
    if (
      !strategy.data.versions.some(
        (version) =>
          version.id === versionId &&
          version.strategyId === strategyId &&
          (!requireValid || version.validationStatus === 'valid'),
      )
    )
      throw new Error('Strategy version binding mismatch');
};

const boundSession = async (
  input: { strategyId: string; versionId: string; sessionId: string },
  ctx: ToolContext,
): Promise<ToolResult<{ session: StrategyEvaluationSession }>> => {
  const result = await getStrategyEvaluationSessionTool.execute(
    { sessionId: input.sessionId },
    ctx,
  );
  if (!result.ok) return result;
  if (result.data.session === null)
    return errNotFound('StrategyEvaluationSession', input.sessionId);
  if (
    result.data.session.strategyId !== input.strategyId ||
    result.data.session.strategyVersionId !== input.versionId
  )
    return errInvalidInput('Evaluation session must match the bound strategy version');
  return { ok: true, data: { session: result.data.session } };
};

const sameSessionInput = (
  session: StrategyEvaluationSession,
  input: z.output<typeof StartResearchEvaluationInput>,
) =>
  session.strategyId === input.strategyId &&
  session.strategyVersionId === input.versionId &&
  session.from.getTime() === input.from.getTime() &&
  session.to.getTime() === input.to.getTime() &&
  pluginInputJson(session.stockIds ?? null) ===
    pluginInputJson(input.stockIds === undefined ? null : [...new Set(input.stockIds)].sort());

export const createResearchEvaluationOperationPolicies = (
  jobs: ResearchJobs,
): readonly ConfirmablePluginTool[] => {
  const output = StartStrategyEvaluationSessionOutput.extend({
    worker: z.enum(['running', 'idle']),
  });
  const start = defineTool({
    name: 'start_strategy_evaluation_session',
    description:
      '创建并在后台推进当前账户、策略及不可变版本的历史选股评估；只读本地 PIT，保留 checkpoint，不发布当前股票池。操作成功只代表任务已受理。',
    sideEffect: 'write',
    requiredCapabilities: ['write', 'external'],
    input: StartResearchEvaluationInput,
    output,
    handler: async (input, ctx) => {
      if (input.accountId !== ctx.user.defaultAccountId)
        return errInvalidInput('Account binding changed');
      const sessionId = operationEvaluationSessionId(input.strategyId, input.requestId);
      if (!jobs.canStart(sessionId))
        return errInvalidInput('Research task capacity reached; wait or cancel an active task');
      const started = await startStrategyEvaluationSessionTool.execute(input, ctx);
      if (!started.ok) return started;
      if (started.data.session.status === 'running' && !ctx.abortSignal?.aborted)
        jobs.startEvaluation(started.data.session, ctx);
      return { ...started.data, worker: jobs.status(started.data.session.id) };
    },
  });
  const control = (action: 'resume' | 'cancel'): ConfirmablePluginTool => ({
    scheduled: false,
    hostBoundFields: ['accountId'],
    tool: defineTool({
      name: `${action}_strategy_evaluation_session`,
      description:
        action === 'resume'
          ? '按原策略版本、区间和样本恢复历史选股评估；跳过已完成日期，不重建实验或发布。'
          : '取消绑定策略版本的历史选股评估，保留已完成日期和事实；不回滚已提交的运行。',
      sideEffect: 'write',
      requiredCapabilities: action === 'resume' ? ['write', 'external'] : ['write'],
      input: ResearchEvaluationControlInput,
      output,
      handler: async (input, ctx) => {
        if (input.accountId !== ctx.user.defaultAccountId)
          return errInvalidInput('Account binding changed');
        const current = await boundSession(input, ctx);
        if (!current.ok) return current;
        if (action === 'resume') {
          if (!jobs.canStart(input.sessionId))
            return errInvalidInput('Research task capacity reached; wait or cancel an active task');
          const resumed = await resumeStrategyEvaluationSessionTool.execute(input, ctx);
          if (!resumed.ok) return resumed;
          if (!ctx.abortSignal?.aborted) jobs.startEvaluation(resumed.data.session, ctx);
          return { ...resumed.data, worker: jobs.status(input.sessionId) };
        }
        const cancelled = await cancelStrategyEvaluationSessionTool.execute(input, ctx);
        if (!cancelled.ok) return cancelled;
        jobs.cancel(input.sessionId);
        return { ...cancelled.data, worker: jobs.status(input.sessionId) };
      },
    }),
    async bind(raw, principal, _operationId, ctx) {
      const input = ResearchEvaluationControlInput.parse(bindScope(raw, principal, ctx));
      const current = await boundSession(input, ctx);
      if (!current.ok) throw new Error('Evaluation scope mismatch');
      if (action === 'resume') await assertVersions(input.strategyId, [input.versionId], ctx, true);
      return input;
    },
    async receipt(raw, ctx) {
      const input = ResearchEvaluationControlInput.parse(raw);
      const result = await boundSession(input, ctx);
      if (!result.ok || (action === 'cancel' && result.data.session.status === 'running'))
        return null;
      if (
        action === 'resume' &&
        (result.data.session.status !== 'running' || jobs.status(input.sessionId) !== 'running')
      )
        return null;
      return { ok: true, data: { ...result.data, worker: jobs.status(input.sessionId) } };
    },
  });
  return [
    {
      tool: start,
      scheduled: false,
      hostBoundFields: ['accountId', 'requestId'],
      async bind(raw, principal, operationId, ctx) {
        const input = StartResearchEvaluationInput.parse(
          bindScope(raw, principal, ctx, operationId),
        );
        await assertVersions(input.strategyId, [input.versionId], ctx, true);
        return input;
      },
      async receipt(raw, ctx) {
        const input = StartResearchEvaluationInput.parse(raw);
        const result = await getStrategyEvaluationSessionTool.execute(
          { sessionId: operationEvaluationSessionId(input.strategyId, input.requestId) },
          ctx,
        );
        return result.ok &&
          result.data.session !== null &&
          sameSessionInput(result.data.session, input)
          ? {
              ok: true,
              data: { session: result.data.session, worker: jobs.status(result.data.session.id) },
            }
          : null;
      },
    },
    control('resume'),
    control('cancel'),
  ];
};

export const createResearchTrialOperationPolicy = (): ConfirmablePluginTool => {
  const input = TrialStrategyVersionInput.extend({ accountId: id }).strict();
  return {
    tool: defineTool({
      name: trialStrategyVersionTool.name,
      description:
        '在冻结的同一事实快照中对照绑定策略的基线与候选；结果仅内存试算与本操作回执，不发布、不交易。',
      sideEffect: 'external',
      input,
      output: TrialStrategyVersionOutput,
      handler: async (args, ctx) => {
        if (args.accountId !== ctx.user.defaultAccountId)
          return errInvalidInput('Account binding changed');
        const result = await trialStrategyVersionTool.execute(args, ctx);
        return result.ok ? result.data : result;
      },
    }),
    scheduled: false,
    hostBoundFields: ['accountId'],
    async bind(raw, principal, _operationId, ctx) {
      const bound = input.parse(bindScope(raw, principal, ctx));
      await assertVersions(
        bound.strategyId,
        [bound.baseVersionId, bound.draftVersionId],
        ctx,
        true,
      );
      if (bound.mode === 'replay' && bound.asOf === undefined)
        throw new Error('Replay requires an explicit asOf');
      if (bound.mode === 'scan' && (bound.asOf !== undefined || bound.revisionCutoff !== undefined))
        throw new Error('Scan cannot replace its live fact time');
      return bound;
    },
    // An in-memory trial has no independent business receipt. Unknown stays unknown.
    receipt: async () => null,
  };
};

export const createResearchComparisonOperationPolicy = (): ConfirmablePluginTool => {
  const input = RunStrategyResearchComparisonInput.extend({ accountId: id }).strict();
  return {
    tool: defineTool({
      name: runStrategyResearchComparisonTool.name,
      description:
        '在同一输入快照中对照最多八个绑定候选，保留全部成功、失败与限制；不自动挑选最优收益，不发布或交易。',
      sideEffect: 'external',
      input,
      output: RunStrategyResearchComparisonOutput,
      handler: async (args, ctx) => {
        if (args.accountId !== ctx.user.defaultAccountId)
          return errInvalidInput('Account binding changed');
        const result = await runStrategyResearchComparisonTool.execute(args, ctx);
        return result.ok ? result.data : result;
      },
    }),
    scheduled: false,
    hostBoundFields: ['accountId'],
    async bind(raw, principal, _operationId, ctx) {
      const bound = input.parse(bindScope(raw, principal, ctx));
      await assertVersions(
        bound.strategyId,
        [bound.baseVersionId, ...bound.candidateVersionIds],
        ctx,
        true,
      );
      if (bound.mode === 'replay' && bound.asOf === undefined)
        throw new Error('Replay requires an explicit asOf');
      if (bound.mode === 'scan' && (bound.asOf !== undefined || bound.revisionCutoff !== undefined))
        throw new Error('Scan cannot replace its live fact time');
      return bound;
    },
    receipt: async () => null,
  };
};

export const createSaveResearchStateOperationPolicy = (): ConfirmablePluginTool => ({
  tool: saveStrategyResearchStateTool,
  scheduled: false,
  hostBoundFields: ['accountId', 'requestId'],
  async bind(raw, principal, operationId, ctx) {
    const input = SaveStrategyResearchStateInput.strict().parse(
      bindScope(raw, principal, ctx, operationId),
    );
    await assertVersions(
      input.strategyId,
      [
        input.state.baseVersionId,
        ...(input.state.candidateVersionId === undefined ? [] : [input.state.candidateVersionId]),
      ],
      ctx,
    );
    return input;
  },
  async receipt(raw, ctx) {
    const input = SaveStrategyResearchStateInput.parse(raw);
    const result = await getStrategyResearchStateTool.execute(
      { strategyId: input.strategyId, accountId: input.accountId },
      ctx,
    );
    if (!result.ok || result.data.state === null) return null;
    const state = result.data.state;
    return state.requestId === input.requestId &&
      state.accountId === input.accountId &&
      state.strategyId === input.strategyId &&
      state.revision === input.expectedRevision + 1
      ? { ok: true, data: { state, replayed: true } }
      : null;
  },
});

export const createResearchStrictBacktestOperationPolicy = (
  jobs: ResearchJobs,
): ConfirmablePluginTool => {
  const input = CreateStrictStrategyBacktestInput.extend({ accountId: id, versionId: id }).strict();
  return {
    tool: defineTool({
      name: createStrictStrategyBacktestTool.name,
      description:
        '为绑定的历史评估创建严格组合回测；先执行完整事实门禁，缺少历史可交易性、公司行动或基准数据时只保存缺口审计，不生成收益。',
      sideEffect: 'write',
      requiredCapabilities: ['write', 'external'],
      input,
      output: CreateStrictStrategyBacktestOutput,
      handler: async (args, ctx) => {
        if (args.accountId !== ctx.user.defaultAccountId)
          return errInvalidInput('Account binding changed');
        const session = await boundSession({ ...args, sessionId: args.evaluationSessionId }, ctx);
        if (!session.ok) return session;
        if (!jobs.canStart())
          return errInvalidInput('Research task capacity reached; wait or cancel an active task');
        const result = await createStrictStrategyBacktestTool.execute(args, ctx);
        if (!result.ok) return result;
        if (result.data.run.status === 'queued' && !ctx.abortSignal?.aborted)
          jobs.startStrict(result.data.run.id, ctx);
        return result.data;
      },
    }),
    scheduled: false,
    hostBoundFields: ['accountId'],
    async bind(raw, principal, _operationId, ctx) {
      const bound = input.parse(bindScope(raw, principal, ctx));
      const session = await boundSession({ ...bound, sessionId: bound.evaluationSessionId }, ctx);
      if (!session.ok) throw new Error('Evaluation scope mismatch');
      return bound;
    },
    receipt: async () => null,
  };
};

export const createExecuteResearchStrictBacktestOperationPolicy = (
  jobs: ResearchJobs,
): ConfirmablePluginTool => {
  const input = z
    .object({ accountId: id, strategyId: id, versionId: id, backtestRunId: id })
    .strict();
  const load = async (args: z.output<typeof input>, ctx: ToolContext) => {
    const result = await getStrictStrategyBacktestTool.execute(args, ctx);
    if (!result.ok) return result;
    if (result.data.run === null) return errNotFound('StrictStrategyBacktest', args.backtestRunId);
    if (
      result.data.run.spec.strategyId !== args.strategyId ||
      result.data.run.spec.strategyVersionId !== args.versionId
    )
      return errInvalidInput('Strict backtest must match the bound strategy version');
    return { ok: true as const, data: { run: result.data.run } };
  };
  return {
    scheduled: false,
    hostBoundFields: ['accountId'],
    tool: defineTool({
      name: 'execute_strict_strategy_backtest',
      description:
        '显式恢复已有严格回测运行；只使用原模型、事实指纹与完整门禁，不重建输入、不发布或交易。',
      sideEffect: 'write',
      requiredCapabilities: ['write', 'external'],
      input,
      output: CreateStrictStrategyBacktestOutput,
      handler: async (args, ctx) => {
        if (args.accountId !== ctx.user.defaultAccountId)
          return errInvalidInput('Account binding changed');
        const current = await load(args, ctx);
        if (!current.ok) return current;
        if (current.data.run.status === 'queued' || current.data.run.status === 'running') {
          if (!jobs.canStart(`strict:${args.backtestRunId}`))
            return errInvalidInput('Research task capacity reached; wait for an active task');
          if (!ctx.abortSignal?.aborted) jobs.startStrict(args.backtestRunId, ctx);
        }
        return current.data;
      },
    }),
    async bind(raw, principal, _operationId, ctx) {
      const args = input.parse(bindScope(raw, principal, ctx));
      const current = await load(args, ctx);
      if (!current.ok) throw new Error('Strict backtest scope mismatch');
      return args;
    },
    async receipt(raw, ctx) {
      const args = input.parse(raw);
      const result = await load(args, ctx);
      return result.ok &&
        (result.data.run.status === 'complete' ||
          result.data.run.status === 'failed' ||
          jobs.status(`strict:${args.backtestRunId}`) === 'running')
        ? result
        : null;
    },
  };
};

export const createResearchOperationPolicies = (
  jobs: ResearchJobs,
): readonly ConfirmablePluginTool[] => [
  ...createResearchEvaluationOperationPolicies(jobs),
  createResearchTrialOperationPolicy(),
  createResearchComparisonOperationPolicy(),
  createSaveResearchStateOperationPolicy(),
  createResearchStrictBacktestOperationPolicy(jobs),
  createExecuteResearchStrictBacktestOperationPolicy(jobs),
];
