import { InvariantError, type SideEffect, type ToolContext, type ToolResult } from '@luoome/core';
import type { z } from 'zod';

/**
 * handler 主动返回 not_found 的便捷构造器。
 * 约定：handler 用返回值表达业务错误（not_found），抛异常只用于
 * invariant 违反（InvariantError）与未预期错误（→ internal）。
 */
export const errNotFound = (entity: string, id: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'not_found', entity, id },
});

/** defineTool 的输入定义（ARCHITECTURE §4.4：一次定义，多处生效）。 */
export interface ToolDefinition<I, O> {
  readonly name: string;
  readonly description: string;
  readonly sideEffect: SideEffect;
  /** 入参 zod schema；registry 据此推导 MCP / OpenAI / .d.ts。 */
  readonly input: z.ZodType<I>;
  /** 出参 zod schema；execute 成功路径会先做 output parse 再返回 Ok(data)。 */
  readonly output: z.ZodType<O>;
  /**
   * 业务逻辑。返回 O 表示成功；返回 ToolResult（errNotFound 等）表示业务错误；
   * 抛 InvariantError → invariant_violation；抛其他异常 → internal。
   */
  readonly handler: (
    input: I,
    ctx: ToolContext,
  ) => Promise<O | ToolResult<never>> | O | ToolResult<never>;
}

/**
 * Tool 对象（plan.md 跨包契约）。
 * execute 永不抛异常，永远返回 ToolResult：
 * - input parse 失败          → { kind: 'invalid_input' }
 * - handler 返回 ToolResult   → 原样透传（not_found 等业务错误）
 * - handler 抛 InvariantError → { kind: 'invariant_violation' }
 * - 其他异常 / output 校验失败 → { kind: 'internal' }
 */
export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly sideEffect: SideEffect;
  readonly inputSchema: z.ZodType<I>;
  readonly outputSchema: z.ZodType<O>;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult<O>>;
}

/** 检测 handler 主动返回的业务错误（{ ok: false, error: { kind } } 形状）。 */
const isToolErrorResult = (value: unknown): value is ToolResult<never> => {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { ok?: unknown; error?: unknown };
  if (record.ok !== false) return false;
  if (typeof record.error !== 'object' || record.error === null) return false;
  return typeof (record.error as { kind?: unknown }).kind === 'string';
};

const issuesMessage = (issues: readonly { message: string }[]): string =>
  issues.map((issue) => issue.message).join('; ');

export const defineTool = <I, O>(definition: ToolDefinition<I, O>): Tool<I, O> => {
  const { name, description, sideEffect, input, output, handler } = definition;

  // AUDIT(advice × trade 隔离，AGENTS.md「Advice 与 Trade 的边界」硬约束):
  // sideEffect === 'advice' 的 tool 只允许「读数据 + 调 LLM + 落 advice」。
  // ToolContext 类型层不含任何 trade 能力（无下单 adapter / 无 place_order），
  // advice handler 能触达的最远写入是 ctx.repos.advice.save（建议持久化），
  // 永远不得触发 trade 类副作用。v0.1 以本注释 + registry 单测
  // （断言工具表中不存在 sideEffect === 'trade' 的 tool）兜底；
  // v0.2+ 若引入 write/external tool，应在 ctx 组装层按 sideEffect 裁剪能力。

  const execute = async (rawInput: unknown, ctx: ToolContext): Promise<ToolResult<O>> => {
    const parsed = input.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          kind: 'invalid_input',
          message: `tool "${name}" input 校验失败: ${issuesMessage(parsed.error.issues)}`,
          issues: parsed.error.issues,
        },
      };
    }

    let result: O | ToolResult<never>;
    try {
      result = await handler(parsed.data, ctx);
    } catch (error) {
      if (error instanceof InvariantError) {
        return { ok: false, error: { kind: 'invariant_violation', message: error.message } };
      }
      const cause = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { kind: 'internal', cause: `tool "${name}": ${cause}` } };
    }

    if (isToolErrorResult(result)) return result;

    const outParsed = output.safeParse(result);
    if (!outParsed.success) {
      return {
        ok: false,
        error: {
          kind: 'internal',
          cause: `tool "${name}" output 校验失败: ${issuesMessage(outParsed.error.issues)}`,
        },
      };
    }
    return { ok: true, data: outParsed.data };
  };

  return { name, description, sideEffect, inputSchema: input, outputSchema: output, execute };
};
