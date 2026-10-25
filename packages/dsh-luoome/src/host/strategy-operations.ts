// 策略生命周期与 Advice 结果回填的原生确认操作策略（M2b-2，需求 §3.1/§3.2/§3.3/§4.4/§5-5）。
//
// 这五个写工具不直接注册成 agent 工具；它们只作为 luoome_confirmed_operation 的 policy 执行。
// prepare 冻结输入（策略定义/CAS/账户/过期），confirm 前必须获得宿主原生审批；publish 是
// 独立 policy，create/validate 的审批不会隐含发布授权。reconcile 只按业务回执核对既有结果，
// 不重新执行 handler，也不把失败包装成成功。
import {
  type AdviceOutcome,
  AdviceOutcomeSchema,
  inspectStrategyDefinitionReferences,
  money,
  strategyDefinitionHash,
} from '@luoome/core';
import {
  type ConfirmablePluginTool,
  CreateStrategyInput,
  CreateStrategyVersionInput,
  createStrategyTool,
  createStrategyVersionTool,
  PluginOperationScopeError,
  type PluginPrincipal,
  PublishStrategyVersionInput,
  pluginInputJson,
  publishStrategyVersionTool,
  RecordAdviceOutcomeInput,
  recordAdviceOutcomeTool,
  ValidateStrategyVersionInput,
  validateStrategyVersionTool,
} from '@luoome/tools';
import { z } from 'zod';

/**
 * 客户端自报的账户与授权字段不属于这些策略的输入：账户由 principal 决定，approved /
 * callId / taskId 是模型可伪造的字段，解析时一律剥离，不参与授权或冻结参数。
 */
const clientScope = (raw: unknown, principal: PluginPrincipal): Record<string, unknown> => {
  const parsed = z.record(z.string(), z.unknown()).parse(raw);
  if (parsed.accountId !== undefined && parsed.accountId !== principal.accountId)
    throw new PluginOperationScopeError('accountId');
  return parsed;
};

/** 可选字段比较：undefined 与缺省视为同一语义，数组按元素顺序比较。 */
const jsonEqual = (left: unknown, right: unknown): boolean =>
  pluginInputJson(left ?? null) === pluginInputJson(right ?? null);

/**
 * create_strategy 没有业务幂等键：prepare 时把没有显式 id 的调用冻结成
 * `strategy-<operationId>`，让 response loss 后的 reconcile 能按同一 id 核对回执。
 */
export const operationStrategyId = (operationId: string): string => `strategy-${operationId}`;

const createStrategyOperation: ConfirmablePluginTool = {
  tool: createStrategyTool,
  // 只能由单次人工审批执行；不进入定时授权面。
  scheduled: false,
  bind(raw, principal, operationId) {
    const parsed = clientScope(raw, principal);
    return CreateStrategyInput.parse({
      ...parsed,
      id: parsed.id === undefined ? operationStrategyId(operationId) : parsed.id,
    });
  },
  async receipt(raw, ctx) {
    const input = CreateStrategyInput.parse(raw);
    if (input.id === undefined) return null;
    const strategy = await ctx.repos.strategy.findById(input.id);
    if (strategy === null || strategy.owner !== 'user') return null;
    if (strategy.name !== input.name || strategy.description !== input.description) return null;
    if (input.copyFromStrategyId === undefined)
      return { ok: true, data: { strategy, replayed: true } };
    const sourceVersions = await ctx.repos.strategy.listVersions(input.copyFromStrategyId);
    for (const version of await ctx.repos.strategy.listVersions(strategy.id)) {
      const prefix = `复制自 ${input.copyFromStrategyId}@`;
      const summary = version.changeSummary;
      if (summary === undefined || !summary.startsWith(prefix)) continue;
      const rawNumber = summary.slice(prefix.length);
      if (!/^\d+$/.test(rawNumber)) continue;
      const source = sourceVersions.find((candidate) => candidate.version === Number(rawNumber));
      if (source !== undefined && source.definitionHash === version.definitionHash)
        return { ok: true, data: { strategy, copiedVersion: version, replayed: true } };
    }
    return null;
  },
};

const createStrategyVersionOperation: ConfirmablePluginTool = {
  tool: createStrategyVersionTool,
  scheduled: false,
  bind(raw, principal) {
    return CreateStrategyVersionInput.parse(clientScope(raw, principal));
  },
  async receipt(raw, ctx) {
    const input = CreateStrategyVersionInput.parse(raw);
    const versions = await ctx.repos.strategy.listVersions(input.strategyId);
    const definitionHash = strategyDefinitionHash(input.definition);
    const match = [...versions]
      .reverse()
      .find(
        (version) =>
          version.definitionHash === definitionHash &&
          (input.parentVersionId === undefined ||
            version.parentVersionId === input.parentVersionId) &&
          (input.changeSummary === undefined || version.changeSummary === input.changeSummary) &&
          jsonEqual(version.factReferences, input.factReferences) &&
          jsonEqual(version.agentTrace, input.agentTrace),
      );
    return match === undefined ? null : { ok: true, data: { version: match, replayed: true } };
  },
};

const validateStrategyVersionOperation: ConfirmablePluginTool = {
  tool: validateStrategyVersionTool,
  scheduled: false,
  bind(raw, principal) {
    return ValidateStrategyVersionInput.parse(clientScope(raw, principal));
  },
  async receipt(raw, ctx) {
    const input = ValidateStrategyVersionInput.parse(raw);
    const version = await ctx.repos.strategy.findVersionById(input.versionId);
    if (version === null) return null;
    if (input.strategyId !== undefined && version.strategyId !== input.strategyId) return null;
    // pending 说明校验写入尚未发生；published 版本不可能再被本工具校验修改。
    if (version.validationStatus === 'pending' || version.publishedAt !== undefined) return null;
    const inspected = inspectStrategyDefinitionReferences(version.definition);
    return {
      ok: true,
      data: {
        version,
        referencedFields: inspected.paths,
        requiredLookback: inspected.requiredLookback,
        replayed: true,
      },
    };
  },
};

const publishStrategyVersionOperation: ConfirmablePluginTool = {
  tool: publishStrategyVersionTool,
  // 发布必须单独审批：create/validate 的 policy 不会复用或隐含本 policy。
  scheduled: false,
  bind(raw, principal) {
    return PublishStrategyVersionInput.parse(clientScope(raw, principal));
  },
  async receipt(raw, ctx) {
    const input = PublishStrategyVersionInput.parse(raw);
    const version = await ctx.repos.strategy.findVersionById(input.versionId);
    if (version === null || version.publishedAt === undefined) return null;
    if (input.strategyId !== undefined && version.strategyId !== input.strategyId) return null;
    const strategy = await ctx.repos.strategy.findById(version.strategyId);
    if (strategy === null || strategy.currentVersionId !== version.id) return null;
    return { ok: true, data: { strategy, version, replayed: true } };
  },
};

/** 与 record_advice_outcome 落库时相同的 content 映射，用于核对业务回执。 */
const adviceOutcomeContent = (input: z.output<typeof RecordAdviceOutcomeInput>) => ({
  tradeIds: [...new Set(input.tradeIds)].sort(),
  adviceFeedback: {
    outcome: input.outcome,
    ...(input.pnl === undefined ? {} : { pnl: input.pnl }),
    ...(input.benchmarkPnl === undefined ? {} : { benchmarkPnl: input.benchmarkPnl }),
    ...(input.holdingHours === undefined ? {} : { holdingHours: input.holdingHours }),
  },
  triggerFeedback: null,
  note: input.notes ?? null,
});

const recordAdviceOutcomeOperation: ConfirmablePluginTool = {
  tool: recordAdviceOutcomeTool,
  hostBoundFields: ['accountId', 'requestId'],
  // 用户反馈只经一次性人工审批写入；定时授权/自动执行永不包含本 policy。
  scheduled: false,
  bind(raw, principal, operationId) {
    const parsed = clientScope(raw, principal);
    // requestId 与账户一样由 operationId/principal 决定，客户端不能替换。
    if (parsed.requestId !== undefined && parsed.requestId !== operationId)
      throw new PluginOperationScopeError('requestId');
    const input = RecordAdviceOutcomeInput.parse({
      ...parsed,
      accountId: principal.accountId,
      requestId: operationId,
    });
    return { ...input, accountId: principal.accountId, requestId: operationId };
  },
  async receipt(raw, ctx) {
    const input = RecordAdviceOutcomeInput.parse(raw);
    if (input.accountId === undefined || input.requestId === undefined) return null;
    const receipt = await ctx.repos.decisionReview.findWriteReceipt({
      accountId: input.accountId,
      requestId: input.requestId,
    });
    if (receipt === null) return null;
    const { review, revision } = receipt.result;
    if (
      review.accountId !== input.accountId ||
      review.subject.kind !== 'advice' ||
      review.subject.id !== input.adviceId
    )
      return null;
    if (!jsonEqual(revision.content, adviceOutcomeContent(input))) return null;
    if (revision.changeNote !== (input.changeNote ?? null)) return null;
    const outcome: AdviceOutcome = {
      adviceId: input.adviceId,
      tradeIds: input.tradeIds,
      outcome: input.outcome,
      ...(input.pnl === undefined ? {} : { pnl: money(input.pnl) }),
      ...(input.benchmarkPnl === undefined ? {} : { benchmarkPnl: money(input.benchmarkPnl) }),
      ...(input.holdingHours === undefined ? {} : { holdingHours: input.holdingHours }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
      recordedAt: revision.recordedAt,
    };
    return { ok: true, data: { outcome: AdviceOutcomeSchema.parse(outcome), replayed: true } };
  },
};

/** 四个策略生命周期 policy：create / create-version / validate / publish，各自独立审批。 */
export const createStrategyLifecycleOperationPolicies = (): readonly ConfirmablePluginTool[] => [
  createStrategyOperation,
  createStrategyVersionOperation,
  validateStrategyVersionOperation,
  publishStrategyVersionOperation,
];

/**
 * Advice 结果回填 policy：outcome/pnl/notes 等字段必须由调用方显式给出并经宿主原生审批。
 * 这里不提供任何「模型推断值」入口，也不接受客户端自报 approved/callId/taskId；没有用户
 * 批准的一次性授权，prepare 出的操作不会被执行。
 */
export const createAdviceOutcomeOperationPolicies = (): readonly ConfirmablePluginTool[] => [
  recordAdviceOutcomeOperation,
];

/** 生产装配使用的 M2b-2 精确写回 policy：不含删除/归档/调度、settings、batch 或 trade。 */
export const createStrategyOperationPolicies = (): readonly ConfirmablePluginTool[] => [
  ...createStrategyLifecycleOperationPolicies(),
  ...createAdviceOutcomeOperationPolicies(),
];

export const createCreateStrategyOperation = (): ConfirmablePluginTool => createStrategyOperation;
export const createCreateStrategyVersionOperation = (): ConfirmablePluginTool =>
  createStrategyVersionOperation;
export const createValidateStrategyVersionOperation = (): ConfirmablePluginTool =>
  validateStrategyVersionOperation;
export const createPublishStrategyVersionOperation = (): ConfirmablePluginTool =>
  publishStrategyVersionOperation;
export const createRecordAdviceOutcomeOperation = (): ConfirmablePluginTool =>
  recordAdviceOutcomeOperation;
