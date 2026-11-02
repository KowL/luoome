import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * token 用量查询（REQ-M5-03 第 3 项）。**只读**。
 *
 * ## ⚠️ 当前**未接入宿主 usage**
 *
 * 查证结果（`node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:337`）：
 * - 宿主**确实记录** token 用量：`assistant/message` 事件带 `usage?: TokenUsage`
 *   （`inputTokens` / `outputTokens` / `totalTokens?` / cache 字段）
 * - 但读取它是**同步读会话事件**（`Session.eventAt` / `snapshotEvents`），
 *   而这两个 API 已标 `@deprecated ... **new calls are prohibited**`
 *   （Agent Note `2026-09-09-deprecate-synchronous-session-event-reads.md`）
 *
 * ⇒ **拿不到真实值时返回 `null`，并显式说明原因**。
 * **绝不估算**：编一个数字会被当真、被计入预算、被拿去调阈值——
 * 与 M4-02 `tokenUsed: null`、M4-05 `recorded-after-cutoff` 是同一条纪律。
 *
 * ## 为什么仍然提供这个工具
 *
 * 「成本可见」需要先把**读面**立起来：宿主一旦提供异步 usage 接口，
 * 这里换实现即可，调用方与输出契约不变。
 */
export const GetTokenUsageInput = z.object({}).strict();

export const GetTokenUsageOutput = z.object({
  /**
   * 真实用量；**当前恒为 `null`**（宿主 usage 未接入）。
   * `null` 的含义是「未知」，不是「零消耗」。
   */
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative().nullable(),
      cacheReadTokens: z.number().int().nonnegative().nullable(),
      cacheWriteTokens: z.number().int().nonnegative().nullable(),
    })
    .strict()
    .nullable(),
  /** 为什么拿不到（`usage` 非 null 时为 null）。**必须能解释**。 */
  unavailableReason: z.string().nullable(),
  /** 数据来源说明：`null` = 未接入。 */
  source: z.enum(['host-session-usage']).nullable(),
});

export const getTokenUsageTool = defineTool({
  name: 'get_token_usage',
  description:
    '查询 token 用量（只读）。当前宿主 usage 读取接口不可用，返回 usage=null 并说明原因；不做任何估算。',
  sideEffect: 'read',
  input: GetTokenUsageInput,
  output: GetTokenUsageOutput,
  handler: async () => ({
    usage: null,
    unavailableReason:
      '宿主 token usage 记录在会话的 assistant/message 事件上，但读取它的同步接口已被标记弃用（new calls are prohibited）；暂无异步替代接口，因此不提供数值，也不做估算。',
    source: null,
  }),
});
