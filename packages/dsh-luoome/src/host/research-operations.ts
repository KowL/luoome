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

/**
 * dsh 研究任务（本轨）创建 evaluation session 时声明的 provenance。
 *
 * 为什么是 backfill：本轨把用户给的历史区间**当场逐日 replay 完**（research-jobs 立即推进，
 * 不等待未来行情），因此每一天的评分横截面与次日收益在计算时都已存在——任何观察都只能是
 * 「事后用回溯数据补算」的 restated。反过来标成 prospective 就是把回溯补算写成前瞻样本，
 * 正是 H8 明令禁止的方向。
 *
 * 边界：区间 `to` 允许落在今天之后，但未来交易日的 replay 必然失败（无 PIT universe / 无日线），
 * 不会产出样本；若将来本轨改成「创建后逐日等行情推进」，就必须改回 prospective——那时
 * `create_strategy_observation_candidates` 会因 backfill 守卫直接拒绝 pit 写入，改动不会静默。
 */
const RESEARCH_EVALUATION_ORIGIN = 'backfill' as const;

export const StartResearchEvaluationInput = StartStrategyEvaluationSessionInput.omit({
  // provenance 是本轨的事实，不由调用方（模型）自报：模型把回溯补算标成 prospective
  // 就是 H8 禁止的方向，所以这个字段干脆不进插件入参，由 handler 按轨显式声明。
  origin: true,
})
  .extend({
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
      const started = await startStrategyEvaluationSessionTool.execute(
        { ...input, origin: RESEARCH_EVALUATION_ORIGIN },
        ctx,
      );
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
        '为绑定的历史评估创建隔离的组合回测运行（门禁审计）；缺少历史可交易性、公司行动或基准数据时只保存缺口审计，不生成任何收益指标。',
      sideEffect: 'write',
      // 本 policy 全程只读写本地库：创建时 assembleBacktest 读 strategyEvaluation/strategyRun/
      // strategyBacktest/dailyBar 四张本地表；门禁完备后排的 `execute_strict_strategy_backtest`
      // 同样只读本地事实。外部取数发生在更早的 evaluation replay（`prepare_strategy_data`），
      // 不在这条操作的链路里，所以不声明 external（T06 判定：registry 本体写得对，是 policy 多声明）。
      requiredCapabilities: ['write'],
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

/**
 * 插件暴露的写面 policy 全集。
 *
 * `execute_strict_strategy_backtest` **不在这里**（REQ-M1-05 §2）：它的对外入口名不副实
 * （门禁恒 partial 时永远拿不到 metrics），已降为内部工具——域内实现进 registry（一份实现），
 * 插件侧副本删除。执行仍由本文件的 create policy 在门禁完备后通过 `jobs.startStrict` 触发；
 * 重复调用 create 是幂等的（同输入返回同 id 的 run），所以恢复一条 queued run 仍有路径，
 * 不需要第二条对外入口。
 */
export const createResearchOperationPolicies = (
  jobs: ResearchJobs,
): readonly ConfirmablePluginTool[] => [
  ...createResearchEvaluationOperationPolicies(jobs),
  createResearchTrialOperationPolicy(),
  createResearchComparisonOperationPolicy(),
  createSaveResearchStateOperationPolicy(),
  createResearchStrictBacktestOperationPolicy(jobs),
];
