// 交互分析写回的个人直接执行策略（M2b-1，需求 §4.3/§5-5）。
//
// record_advice / record_analysis_result 不直接注册成 agent 工具；它们只作为
// luoome_confirmed_operation 的 policy 执行。prepare 冻结账户、contextId、结论、来源与
// requestId；confirm 时领域 record 工具再次读取 context，自行校验 contextHash、证据引用、
// 时效与不变量。reconcile 只核对 context.recordedResult 与业务回执，不重新推理或写库。
import type { AnalysisProvenance, ToolContext } from '@luoome/core';
import {
  analysisHash,
  type ConfirmablePluginTool,
  PluginOperationScopeError,
  RecordAdviceInput,
  RecordAnalysisResultInput,
  recordAdviceTool,
  recordAnalysisResultTool,
} from '@luoome/tools';
import { z } from 'zod';

/**
 * 受信任装配提供的 provenance 身份。
 *
 * generatorKind 由部署代码决定（本插件运行在 DSH 会话内，固定为 `dsh-chat`）；model /
 * skillVersion / promptHash / sessionRef 只有宿主能可靠提供时才设置。未知字段保持未知，
 * 绝不把模型自报的来源写进事实。
 */
export interface TrustedAnalysisProvenance {
  readonly generatorKind: AnalysisProvenance['generatorKind'];
  readonly model?: string;
  readonly skillVersion?: string;
  readonly promptHash?: string;
  readonly sessionRef?: string;
}

type ProvenanceInput = Omit<AnalysisProvenance, 'contextId' | 'jobId' | 'generatedAt'>;

/** 丢弃客户端自报的来源身份，只保留受信任装配注入的字段；generatorKind 强制覆盖。 */
const trustedProvenance = (
  input: ProvenanceInput,
  trusted: TrustedAnalysisProvenance,
): ProvenanceInput => {
  const {
    generatorKind: _generatorKind,
    model: _model,
    skillVersion: _skillVersion,
    promptHash: _promptHash,
    sessionRef: _sessionRef,
    ...rest
  } = input;
  return {
    ...rest,
    generatorKind: trusted.generatorKind,
    ...(trusted.model === undefined ? {} : { model: trusted.model }),
    ...(trusted.skillVersion === undefined ? {} : { skillVersion: trusted.skillVersion }),
    ...(trusted.promptHash === undefined ? {} : { promptHash: trusted.promptHash }),
    ...(trusted.sessionRef === undefined ? {} : { sessionRef: trusted.sessionRef }),
  };
};

/** 客户端不得替换账户或 requestId；两者都由 principal 与 operationId 决定。 */
const assertFrozenEnvelope = (
  input: { readonly accountId?: string; readonly requestId?: string },
  principal: { readonly accountId: string },
  operationId: string,
): void => {
  if (input.accountId !== undefined && input.accountId !== principal.accountId)
    throw new PluginOperationScopeError('accountId');
  if (input.requestId !== undefined && input.requestId !== operationId)
    throw new PluginOperationScopeError('requestId');
};

const receiptContext = async (
  ctx: ToolContext,
  accountId: string,
  contextId: string,
): Promise<{ readonly recordedResult: { readonly hash: string; readonly ref: string } } | null> => {
  const context = await ctx.repos.analysis.findContext(accountId, contextId);
  return context?.recordedResult === undefined ? null : { recordedResult: context.recordedResult };
};

export const createRecordAdviceOperation = (
  trusted: TrustedAnalysisProvenance,
): ConfirmablePluginTool => ({
  tool: recordAdviceTool,
  scheduled: false,
  hostBoundFields: ['accountId', 'requestId'],
  bind(raw, principal, operationId) {
    const parsed = z.record(z.string(), z.unknown()).parse(raw);
    assertFrozenEnvelope(parsed, principal, operationId);
    const input = RecordAdviceInput.parse({
      ...parsed,
      accountId: principal.accountId,
      requestId: operationId,
    });
    return {
      ...input,
      accountId: principal.accountId,
      requestId: operationId,
      provenance: trustedProvenance(input.provenance, trusted),
    };
  },
  async receipt(raw, ctx) {
    const input = RecordAdviceInput.parse(raw);
    if (input.accountId === undefined) return null;
    const receipt = await receiptContext(ctx, input.accountId, input.contextId);
    if (receipt === null) return null;
    if (
      receipt.recordedResult.hash !==
      analysisHash({ result: input.result, provenance: input.provenance })
    )
      return null;
    const advice = await ctx.repos.advice.findById(receipt.recordedResult.ref);
    if (advice === null) return null;
    return { ok: true, data: { advice, replayed: true } };
  },
});

export const createRecordAnalysisResultOperation = (
  trusted: TrustedAnalysisProvenance,
): ConfirmablePluginTool => ({
  tool: recordAnalysisResultTool,
  scheduled: false,
  hostBoundFields: ['accountId', 'requestId'],
  bind(raw, principal, operationId) {
    const parsed = z.record(z.string(), z.unknown()).parse(raw);
    assertFrozenEnvelope(parsed, principal, operationId);
    const input = RecordAnalysisResultInput.parse({
      ...parsed,
      accountId: principal.accountId,
      requestId: operationId,
    });
    return {
      ...input,
      accountId: principal.accountId,
      requestId: operationId,
      provenance: trustedProvenance(input.provenance, trusted),
    };
  },
  async receipt(raw, ctx) {
    const input = RecordAnalysisResultInput.parse(raw);
    if (input.accountId === undefined) return null;
    const receipt = await receiptContext(ctx, input.accountId, input.contextId);
    if (receipt === null) return null;
    if (
      receipt.recordedResult.hash !==
      analysisHash({ result: input.result, provenance: input.provenance })
    )
      return null;
    return {
      ok: true,
      data: { resultRef: receipt.recordedResult.ref, replayed: true },
    };
  },
});

/** 生产装配使用的一组精确分析写回 policy：不包含 queue 管理、settings、batch 或 trade。 */
export const createAnalysisOperationPolicies = (
  trusted: TrustedAnalysisProvenance,
): readonly ConfirmablePluginTool[] => [
  createRecordAdviceOperation(trusted),
  createRecordAnalysisResultOperation(trusted),
];
