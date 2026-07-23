import type { ToolResult } from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/** LLM 上下文里候选股票的最大条数（spec §8 已知边界：prompt 体积受限，超阈值截断）。 */
const MAX_CANDIDATES = 200;

export const ResolveLlmGroupInput = z.object({
  /** 选股提示词（如「选出当前市场龙头」）。 */
  prompt: z.string().min(1).max(2000),
  /** 返回成员上限；缺省 20，区间 [1, 100]。 */
  maxMembers: z.number().int().min(1).max(100).default(20),
  /** 缺省走系统默认 LLM。 */
  model: z.string().min(1).optional(),
});

export const ResolveLlmGroupOutput = z.object({
  /** 通过存在性校验 + 截断后的成员（stockId + 进入理由）。 */
  members: z.array(
    z.object({
      stockId: z.string().min(1),
      reason: z.string().min(1).max(500),
    }),
  ),
  /** LLM 原始返回条数（校验丢弃前）。 */
  rawCount: z.number().int().nonnegative(),
  /** 因本地股票库不存在而被丢弃的 stockId。 */
  dropped: z.array(z.string()),
});

const LlmGroupSchema = z.object({
  members: z
    .array(
      z.object({
        stockId: z.string().min(1),
        rationale: z.string().min(1).max(500),
      }),
    )
    .max(100),
});

const RESOLVE_LLM_GROUP_SYSTEM =
  'resolve_llm_group\n' +
  '你是股票分组助手。给定选股提示词（prompt）与候选股票列表（candidates，含 stockId/code/name/行业/最新价），' +
  '按提示词选出最符合的股票。要求：只从 candidates 里选；每条给出一句中文 rationale（≤ 80 字）；' +
  '最多输出 maxMembers 条；只输出 JSON：{"members":[{"stockId":"...","rationale":"..."}]}。';

/**
 * LLM 分组解析（分组化起，advice；workflow 内部通道，docs/stock-group-design.md §4/§6）。
 *
 * 链路：prompt + 最小上下文（本地股票列表 ≤200 条 + 当日行情快照）→ LLM generate
 * （zod schema-constrained）→ 逐条 repos.stock.findById 校验存在（丢弃不存在项，
 * spec「明确不做：LLM 输出未校验直接入库」）→ 截断 maxMembers → [{stockId, reason}]。
 *
 * LLM 调用异常 / 输出校验失败 → 返回 llm_error ToolResult（不抛）。
 */
export const resolveLlmGroupTool = defineTool({
  name: 'resolve_llm_group',
  description:
    'LLM 按提示词产出分组成员（advice，refresh-groups workflow 内部通道；逐条校验存在性 + 截断）',
  sideEffect: 'advice',
  input: ResolveLlmGroupInput,
  output: ResolveLlmGroupOutput,
  handler: async (input, ctx) => {
    // 最小上下文：全市场股票列表（截断）+ 当日行情快照（失败降级为无报价）
    const stocks = [...(await ctx.repos.stock.search(''))].slice(0, MAX_CANDIDATES);
    const closeByStock = new Map<string, number>();
    try {
      const quotes = await ctx.adapters.market.batchQuote(stocks.map((s) => s.id));
      for (const [id, q] of quotes) closeByStock.set(id, q.close);
    } catch (e) {
      ctx.logger.warn('[resolve_llm_group] batchQuote 失败，降级为无报价上下文', {
        err: String(e),
      });
    }

    let llmOut: unknown;
    try {
      llmOut = await ctx.adapters.llm.generate({
        system: RESOLVE_LLM_GROUP_SYSTEM,
        schema: LlmGroupSchema,
        data: {
          prompt: input.prompt,
          maxMembers: input.maxMembers,
          ...(input.model !== undefined ? { model: input.model } : {}),
          candidates: stocks.map((s) => ({
            stockId: s.id,
            code: s.code,
            name: s.name,
            ...(s.industry !== undefined ? { industry: s.industry } : {}),
            ...(closeByStock.has(s.id) ? { close: closeByStock.get(s.id) } : {}),
          })),
        },
      });
    } catch (e) {
      return {
        ok: false,
        error: {
          kind: 'llm_error',
          provider: ctx.adapters.llm.name,
          cause: e instanceof Error ? e.message : String(e),
          retryable: true,
        },
      } satisfies ToolResult<never>;
    }

    // adapter 契约是「先 parse 再返回」，但 mock / 自定义 adapter 可能返回未校验 fallback；
    // 这里再兜底 parse 一次，失败按 llm_error（输出校验失败，重试无意义 → retryable=false）
    const parsed = LlmGroupSchema.safeParse(llmOut);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          kind: 'llm_error',
          provider: ctx.adapters.llm.name,
          cause: 'LLM 输出未通过 schema 校验',
          retryable: false,
        },
      } satisfies ToolResult<never>;
    }

    const members: Array<{ stockId: string; reason: string }> = [];
    const dropped: string[] = [];
    const seen = new Set<string>();
    for (const m of parsed.data.members) {
      if (seen.has(m.stockId)) continue;
      seen.add(m.stockId);
      const stock = await ctx.repos.stock.findById(m.stockId);
      if (stock === null) {
        dropped.push(m.stockId);
        continue;
      }
      members.push({ stockId: m.stockId, reason: m.rationale });
    }
    const truncated = members.slice(0, input.maxMembers);
    return { members: truncated, rawCount: parsed.data.members.length, dropped };
  },
});
