import { InvariantError, type ToolContext, type ToolResult } from '@luoome/core';
import type {
  AnalyzePositionInput,
  AnalyzePositionOutput,
  AnalyzeStockInput,
  AnalyzeStockOutput,
  BatchQuoteInput,
  BatchQuoteOutput,
  ComputeIndicatorsInput,
  ComputeIndicatorsOutput,
  FetchQuoteInput,
  FetchQuoteOutput,
  GetAccountInput,
  GetAccountOutput,
  GetAdviceInput,
  GetAdviceOutput,
  GetAdviceStatsInput,
  GetAdviceStatsOutput,
  GetHoldingInput,
  GetHoldingOutput,
  GetTacticInput,
  GetTacticOutput,
  ListAccountsInput,
  ListAccountsOutput,
  ListHoldingsInput,
  ListHoldingsOutput,
  ListTacticsInput,
  ListTacticsOutput,
  MarketOutlookInput,
  MarketOutlookOutput,
  RecordAdviceOutcomeInput,
  RecordAdviceOutcomeOutput,
  RunTacticInput,
  RunTacticOutput,
  ScoreSignalsInput,
  ScoreSignalsOutput,
  SearchStocksInput,
  SearchStocksOutput,
  SendNotificationInput,
  SendNotificationOutput,
  SyncQuotesInput,
  SyncQuotesOutput,
  TacticSignalsByStockInput,
  TacticSignalsByStockOutput,
  TacticSignalsByTacticInput,
  TacticSignalsByTacticOutput,
} from '@luoome/tools';
import { toolRegistry } from '@luoome/tools';
import type { z } from 'zod';

/**
 * 单个 tool 的 workflow 侧类型安全访问器。
 * 入参取 input schema 的 raw input 侧（带 default 的字段可省略），
 * 返回对应 output 的 ToolResult；execute 永不抛异常。
 */
export interface ToolAccessor<In extends z.ZodType, Out extends z.ZodType> {
  readonly execute: (input: z.input<In>) => Promise<ToolResult<z.output<Out>>>;
}

/**
 * ctx.tools 的静态类型映射（v0.1 共 8 个 tool，plan.md 跨包契约）。
 * 运行时访问器由 toolRegistry 动态生成（见 buildWorkflowTools）；
 * 新增 tool 时在此补一行，类型层即对全部 workflow 生效。
 */
export interface WorkflowToolMap {
  readonly list_accounts: ToolAccessor<typeof ListAccountsInput, typeof ListAccountsOutput>;
  readonly get_account: ToolAccessor<typeof GetAccountInput, typeof GetAccountOutput>;
  readonly list_holdings: ToolAccessor<typeof ListHoldingsInput, typeof ListHoldingsOutput>;
  readonly get_holding: ToolAccessor<typeof GetHoldingInput, typeof GetHoldingOutput>;
  readonly get_advice: ToolAccessor<typeof GetAdviceInput, typeof GetAdviceOutput>;
  readonly get_advice_stats: ToolAccessor<typeof GetAdviceStatsInput, typeof GetAdviceStatsOutput>;
  readonly analyze_stock: ToolAccessor<typeof AnalyzeStockInput, typeof AnalyzeStockOutput>;
  readonly analyze_position: ToolAccessor<
    typeof AnalyzePositionInput,
    typeof AnalyzePositionOutput
  >;
  // v0.2 新增
  readonly fetch_quote: ToolAccessor<typeof FetchQuoteInput, typeof FetchQuoteOutput>;
  readonly batch_quote: ToolAccessor<typeof BatchQuoteInput, typeof BatchQuoteOutput>;
  readonly sync_quotes: ToolAccessor<typeof SyncQuotesInput, typeof SyncQuotesOutput>;
  readonly search_stocks: ToolAccessor<typeof SearchStocksInput, typeof SearchStocksOutput>;
  readonly compute_indicators: ToolAccessor<
    typeof ComputeIndicatorsInput,
    typeof ComputeIndicatorsOutput
  >;
  // v0.3 新增：战法 + 通知 + 大盘观点 + outcome 回填
  readonly list_tactics: ToolAccessor<typeof ListTacticsInput, typeof ListTacticsOutput>;
  readonly get_tactic: ToolAccessor<typeof GetTacticInput, typeof GetTacticOutput>;
  readonly run_tactic: ToolAccessor<typeof RunTacticInput, typeof RunTacticOutput>;
  readonly score_signals: ToolAccessor<typeof ScoreSignalsInput, typeof ScoreSignalsOutput>;
  readonly tactic_signals_by_stock: ToolAccessor<
    typeof TacticSignalsByStockInput,
    typeof TacticSignalsByStockOutput
  >;
  readonly tactic_signals_by_tactic: ToolAccessor<
    typeof TacticSignalsByTacticInput,
    typeof TacticSignalsByTacticOutput
  >;
  readonly record_advice_outcome: ToolAccessor<
    typeof RecordAdviceOutcomeInput,
    typeof RecordAdviceOutcomeOutput
  >;
  readonly send_notification: ToolAccessor<
    typeof SendNotificationInput,
    typeof SendNotificationOutput
  >;
  readonly market_outlook: ToolAccessor<typeof MarketOutlookInput, typeof MarketOutlookOutput>;
}

/**
 * Workflow 步骤收到的上下文 = ToolContext（repos/adapters/user/clock/logger，§4.8）
 * + tools 访问器。ARCHITECTURE §4.6：workflow 编排逻辑只应通过 ctx.tools 调 tool，
 * 不直接写 repository / adapter（持久化走专用 tool，不绕过层级）。
 */
export interface WorkflowContext extends ToolContext {
  readonly tools: WorkflowToolMap;
}

/**
 * 从 toolRegistry 动态生成 ctx.tools 访问器集：每个访问器把 input 转发给
 * 对应 tool 的 execute（绑定当前 ToolContext）。Registry 名表 → WorkflowToolMap
 * 的类型断言集中在这一点；一致性由 define-workflow / daily-advice 测试兜底。
 */
export const buildWorkflowTools = (ctx: ToolContext): WorkflowToolMap => {
  const accessors: Record<
    string,
    { readonly execute: (input: unknown) => Promise<ToolResult<unknown>> }
  > = {};
  for (const tool of toolRegistry.all()) {
    accessors[tool.name] = { execute: (input) => tool.execute(input, ctx) };
  }
  return accessors as unknown as WorkflowToolMap;
};

/**
 * 工作流步骤：接收上一步输出（首步为已校验的 workflow 输入），返回下一步输入。
 *
 * 步骤返回 ToolResult 时引擎自动解包（ARCHITECTURE §4.6 语义）：
 * - ok    → data 传给下一步
 * - error → 整个 workflow 以该错误短路返回，后续步骤不再执行
 *
 * 步骤抛 InvariantError → invariant_violation；抛其他异常 → internal（run 永不外抛）。
 */
export type WorkflowStep = (prev: unknown, ctx: WorkflowContext) => Promise<unknown> | unknown;

/** defineWorkflow 的输入定义（输出类型 O 由 defineWorkflow 的泛型承载，步骤间类型见 WorkflowStep）。 */
export interface WorkflowDefinition<I> {
  readonly name: string;
  readonly description: string;
  /** 入参 zod schema；run 据此校验，非法输入 → invalid_input。 */
  readonly input: z.ZodType<I>;
  /** 顺序执行的步骤序列；末步输出即 workflow 输出（O）。 */
  readonly steps: readonly WorkflowStep[];
}

/**
 * Workflow 对象（plan.md 跨包契约）。run 永不抛异常，永远返回 ToolResult：
 * - input parse 失败            → { kind: 'invalid_input' }
 * - 步骤返回 ToolResult error   → 原样透传并短路
 * - 步骤抛 InvariantError       → { kind: 'invariant_violation' }
 * - 步骤抛其他异常              → { kind: 'internal' }
 */
export interface Workflow<I, O> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<I>;
  run(input: unknown, ctx: ToolContext): Promise<ToolResult<O>>;
}

/** 检测 { ok: false, error: { kind } } 形状（tool 业务错误 / 短路信号）。 */
const isToolErrorResult = (value: unknown): value is ToolResult<never> => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { ok?: unknown; error?: unknown };
  if (record.ok !== false) return false;
  if (typeof record.error !== 'object' || record.error === null) return false;
  return typeof (record.error as { kind?: unknown }).kind === 'string';
};

/** 检测 { ok: true, data } 形状（步骤返回 ToolResult 成功值时自动解包）。 */
const isToolOkResult = (value: unknown): value is { readonly ok: true; readonly data: unknown } => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { ok?: unknown };
  return record.ok === true && 'data' in value;
};

const issuesMessage = (issues: readonly { message: string }[]): string =>
  issues.map((issue) => issue.message).join('; ');

/**
 * 极简 workflow 引擎（ARCHITECTURE §4.6 / §8）：顺序执行 steps，逐步传递输出。
 * steps 为空是装配期错误，直接抛错（不进 ToolResult 错误模型，同 createRegistry）。
 */
export const defineWorkflow = <I, O>(definition: WorkflowDefinition<I>): Workflow<I, O> => {
  const { name, description, input, steps } = definition;
  if (steps.length === 0) {
    throw new Error(`defineWorkflow: workflow "${name}" 至少需要一个 step`);
  }

  const run = async (rawInput: unknown, toolCtx: ToolContext): Promise<ToolResult<O>> => {
    const parsed = input.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          message: `workflow "${name}" input 校验失败: ${issuesMessage(parsed.error.issues)}`,
          issues: parsed.error.issues,
        },
      };
    }

    const ctx: WorkflowContext = { ...toolCtx, tools: buildWorkflowTools(toolCtx) };

    let current: unknown = parsed.data;
    for (const [index, step] of steps.entries()) {
      let value: unknown;
      try {
        value = await step(current, ctx);
      } catch (error) {
        if (error instanceof InvariantError) {
          return { ok: false, error: { kind: 'invariant_violation', message: error.message } };
        }
        const cause = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: { kind: 'internal', cause: `workflow "${name}" step#${index + 1}: ${cause}` },
        };
      }
      if (isToolErrorResult(value)) return value;
      current = isToolOkResult(value) ? value.data : value;
    }

    // 终值已被沿途各 tool 的 output schema（及末步自定义 parse）校验过，
    // 引擎不做重复校验，此处为集中的一次性类型断言。
    return { ok: true, data: current as O };
  };

  return { name, description, inputSchema: input, run };
};
