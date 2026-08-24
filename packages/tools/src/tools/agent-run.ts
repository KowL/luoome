import { STANDARD_DISCLAIMERS } from '@luoome/core';
import { z } from 'zod';
import { DraftDisplaySchema, summarizeDraft } from '../agent/draft-display.js';
import {
  AGENT_SCENARIOS,
  AgentDraftKindSchema,
  AgentScenarioIdSchema,
  BASE_INSTRUCTIONS,
} from '../agent/scenarios.js';
import { buildAgentCallableTools } from '../agent-whitelist.js';
import { defineTool } from '../define-tool.js';

export const AgentDraftSchema = z.object({
  kind: AgentDraftKindSchema,
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  summary: z.string().min(1).max(500),
  display: DraftDisplaySchema.optional(),
});

const AgentPartialFailureSchema = z.object({
  dimension: z.string().min(1),
  tool: z.string().min(1).optional(),
  reason: z.string().min(1),
  retryable: z.boolean(),
});

const AgentModelOutputSchema = z.object({
  conclusion: z.string().min(1).max(8_000),
  evidence: z.array(z.string().min(1)).max(50),
  counterEvidence: z.array(z.string().min(1)).max(50),
  risks: z.array(z.string().min(1)).max(50),
  disclaimers: z.array(z.string().min(1)).min(1).max(20),
  drafts: z.array(AgentDraftSchema).max(5),
  unknowns: z.array(z.string().min(1)).max(50).default([]),
  partialFailures: z.array(AgentPartialFailureSchema).max(20).default([]),
});

export const AgentRunInput = z.object({
  message: z.string().min(1).max(2_000),
  scenario: AgentScenarioIdSchema.optional(),
});

const AgentToolTraceSchema = z.object({
  toolName: z.string().min(1),
  input: z.unknown(),
  output: z.unknown(),
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
});

const AgentTokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

export const AgentRunOutput = AgentModelOutputSchema.extend({
  usedTools: z.array(z.string().min(1)),
  trace: z.array(AgentToolTraceSchema),
  totalUsage: AgentTokenUsageSchema,
});

// agent_run 特有的结构化输出规则，追加在 BASE_INSTRUCTIONS + 场景覆写之后。
const AGENT_RUN_OUTPUT_RULES = `输出必须是结构化结果：结论必须明确列出 evidence、counterEvidence、risks 和 disclaimers；不能把 confidence 或推测表达为确定事实。
创建或修改 Strategy、发布版本、正式运行并持久化、创建或修改 Watchlist/AlertPlan 都只能在 drafts 中生成待确认草案，不能假装已经执行。
unknowns 必须如实列出数据缺失导致的未知项，不允许留空伪装完整答案；partialFailures 必须如实披露受影响维度与失败工具，隐瞒会被系统按工具轨迹强制补正。
至少保留这些标准免责声明：${STANDARD_DISCLAIMERS.join('；')}。`;

// 明确不可重试的 error kind；其余（含无法识别）按可重试保守处理。
const NON_RETRYABLE_ERROR_KINDS: ReadonlySet<string> = new Set([
  'invalid_input',
  'not_found',
  'invariant_violation',
  'permission_denied',
]);

interface TraceErrorInfo {
  readonly kind?: string;
  readonly detail?: string;
  readonly recoverable?: boolean;
}

const readTraceError = (output: unknown): TraceErrorInfo => {
  if (typeof output !== 'object' || output === null) return {};
  const error = (output as { readonly error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return {};
  const record = error as Record<string, unknown>;
  const detail = ['message', 'cause', 'required']
    .map((key) => record[key])
    .find((value): value is string => typeof value === 'string');
  const retryFlag = ['recoverable', 'retryable']
    .map((key) => record[key])
    .find((value): value is boolean => typeof value === 'boolean');
  return {
    ...(typeof record.kind === 'string' ? { kind: record.kind } : {}),
    ...(detail === undefined ? {} : { detail }),
    ...(retryFlag === undefined ? {} : { recoverable: retryFlag }),
  };
};

/** trace 失败条目 → 强制补入的 partialFailure；模型已披露同一 tool 时跳过。 */
const forcedPartialFailures = (
  trace: readonly { toolName: string; output: unknown; ok: boolean }[],
  disclosed: readonly { tool?: string | undefined; dimension: string }[],
): z.infer<typeof AgentPartialFailureSchema>[] => {
  const disclosedTools = new Set(disclosed.map((item) => item.tool ?? item.dimension));
  const forced: z.infer<typeof AgentPartialFailureSchema>[] = [];
  for (const entry of trace) {
    if (entry.ok) continue;
    if (disclosedTools.has(entry.toolName)) continue;
    if (forced.some((item) => item.tool === entry.toolName)) continue;
    const error = readTraceError(entry.output);
    forced.push({
      dimension: entry.toolName,
      tool: entry.toolName,
      reason:
        error.kind === undefined
          ? '工具调用失败（未返回结构化错误）'
          : `${error.kind}${error.detail === undefined ? '' : `：${error.detail}`}`,
      // adapter_error/llm_error 自带 recoverable/retryable 标志时优先采用；
      // 无法判断时按可重试保守披露，避免把暂时性失败标成永久失败。
      retryable: error.recoverable ?? !NON_RETRYABLE_ERROR_KINDS.has(error.kind ?? ''),
    });
  }
  return forced;
};

export const agentRunTool = defineTool({
  name: 'agent_run',
  description: '在受控查询白名单内执行多步研究，返回证据、反证、风险、草案与实际工具轨迹',
  sideEffect: 'external',
  input: AgentRunInput,
  output: AgentRunOutput,
  handler: async (input, ctx) => {
    if (ctx.agent === undefined) {
      return {
        ok: false,
        error: { kind: 'permission_denied', required: 'agent runtime 未配置' },
      };
    }

    const scenarioConfig = AGENT_SCENARIOS[input.scenario ?? 'general'];
    const instructions = [
      BASE_INSTRUCTIONS,
      scenarioConfig.instructionOverlay,
      AGENT_RUN_OUTPUT_RULES,
    ]
      .filter((part) => part.length > 0)
      .join('\n');

    // 延迟读取 registry，避免 registry 静态导入 agentRunTool 时形成初始化环。
    const { toolRegistry } = await import('../registry.js');
    const runtimeResult = await ctx.agent.run({
      instructions,
      prompt: input.message,
      outputSchema: AgentModelOutputSchema,
      tools: buildAgentCallableTools(toolRegistry, ctx, scenarioConfig.readToolNames),
    });
    const modelOutput = AgentModelOutputSchema.parse(runtimeResult.output);
    const drafts: z.infer<typeof AgentDraftSchema>[] = [];
    let droppedDrafts = 0;
    for (const draft of modelOutput.drafts) {
      const expectedKind = scenarioConfig.draftToolKinds[draft.tool];
      const target = expectedKind === undefined ? undefined : toolRegistry.get(draft.tool);
      const parsedInput = target?.inputSchema.safeParse(draft.input);
      if (
        expectedKind === undefined ||
        expectedKind !== draft.kind ||
        target === undefined ||
        parsedInput === undefined ||
        !parsedInput.success
      ) {
        droppedDrafts += 1;
        continue;
      }
      drafts.push({
        kind: draft.kind,
        tool: draft.tool,
        input: parsedInput.data as Record<string, unknown>,
        summary: draft.summary,
        display: summarizeDraft({
          tool: draft.tool,
          kind: draft.kind,
          input: draft.input,
          parsed: parsedInput.data as Record<string, unknown>,
          description: target.description,
        }),
      });
    }

    const forced = forcedPartialFailures(runtimeResult.trace, modelOutput.partialFailures);
    const partialFailures = [...modelOutput.partialFailures, ...forced].slice(0, 20);

    const hints: string[] = [];
    if (droppedDrafts > 0) {
      hints.push(`${droppedDrafts} 条无效写入草案已被安全门控丢弃`);
    }
    if (forced.length > 0) {
      hints.push(`${forced.length} 项工具失败未由模型披露，已按工具轨迹强制补入 partialFailures`);
    }
    // 输出 schema 上限 50 条：极端情况下截断模型 risks，披露提示必须保留。
    const risks = [...modelOutput.risks.slice(0, 50 - hints.length), ...hints];
    return {
      ...modelOutput,
      risks,
      partialFailures,
      disclaimers: [...new Set([...modelOutput.disclaimers, ...STANDARD_DISCLAIMERS])],
      drafts,
      usedTools: [...runtimeResult.usedTools],
      trace: [...runtimeResult.trace],
      totalUsage: runtimeResult.totalUsage,
    };
  },
});
