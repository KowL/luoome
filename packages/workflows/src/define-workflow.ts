import { InvariantError, type ToolContext, type ToolResult } from '@luoome/core';
import { type CatalogToolMap, catalogTools } from '@luoome/tools';
import type { z } from 'zod';

export interface ToolAccessor<In extends z.ZodType, Out extends z.ZodType> {
  readonly execute: (input: z.input<In>) => Promise<ToolResult<z.output<Out>>>;
}

export type WorkflowToolMap = {
  readonly [K in keyof CatalogToolMap]: ToolAccessor<
    CatalogToolMap[K]['inputSchema'],
    CatalogToolMap[K]['outputSchema']
  >;
};

export interface WorkflowContext extends ToolContext {
  readonly tools: WorkflowToolMap;
}

export const buildWorkflowTools = (ctx: ToolContext): WorkflowToolMap =>
  Object.fromEntries(
    Object.entries(catalogTools).map(([name, tool]) => [
      name,
      { execute: (input: unknown) => tool.execute(input, ctx) },
    ]),
  ) as WorkflowToolMap;

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
 * Workflow 对象（docs/archive/plan.md 跨包契约）。run 永不抛异常，永远返回 ToolResult：
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
 * 可复用的 workflow 步骤管线（不注册为独立 workflow）。
 *
 * 多个入口共享同一管线时（报告/策略/行情同步），管线本身不再算一个 workflow；
 * 由 `reportWorkflow`/`strategyWorkflow`/`syncMarketWorkflow` 这类入口按 kind/mode 分发。
 * 审计名仍由管线内部显式写入，合并不会改写历史 WorkflowRun 身份。
 */
export const defineOperation = <I, O>(definition: WorkflowDefinition<I>): Workflow<I, O> => {
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

/** 注册为独立 workflow 的入口；定义数由 workflow-architecture 测试守住（目标 12 个）。 */
export const defineWorkflow = <I, O>(definition: WorkflowDefinition<I>): Workflow<I, O> =>
  defineOperation<I, O>(definition);
