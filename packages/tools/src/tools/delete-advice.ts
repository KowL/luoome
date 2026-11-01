import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * delete_advice（write）。按 id 批量删除历史建议；单条删除 = 单元素数组。
 * 建议的 outcome 记录随建议一并删除（repository remove 级联）。
 * 部分命中不是错误：deleted 计实际删除数，notFound 列出未命中的 id，
 * 调用方据此提示（与 get_advice 的列表语义一致——建议可能刚被其它入口删掉）。
 */
export const DeleteAdviceInput = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
});

/**
 * 逐项删除结果（决策 3-B）。
 *
 * 旧形状 `{ deleted: number, notFound: string[] }` 里 `deleted` 只是**一个数字**——
 * 删了哪几条、每条是什么，调用方一概不知。这里改成**逐项返回**：
 * 每个 id 要么在 `deleted` 里（带身份），要么在 `notFound` 里（带原因）。
 *
 * ## 为什么 `deleted` 项只给身份，不给建议全文
 *
 * 建议的 `reasoning`（premise/evidence/counterEvidence）与 `risks` 可能很长，
 * 且删除的语义是「让它消失」——把全文塞进回执等于换个地方继续留着。
 * 只保留**能认出删了哪条**的最小集合。
 */
export const DeletedAdviceItemSchema = z
  .object({
    adviceId: z.string().min(1),
    subjectKind: z.string().min(1),
    subjectId: z.string().min(1),
    decision: z.string().min(1),
    createdAt: z.coerce.date(),
  })
  .strict();

export const NotFoundAdviceItemSchema = z
  .object({
    id: z.string().min(1),
    /**
     * 未命中的原因。当前**只有** `not-found` 一种（可能是刚被其它入口删掉）。
     * 不预造「权限不足」「已归档」这类不存在的种类——枚举只放真实会发生的值。
     */
    reason: z.literal('not-found'),
  })
  .strict();

export const DeleteAdviceOutput = z.object({
  /** 实际删除的条目，**逐项**返回（批量删除逐项可核对）。 */
  deleted: z.array(DeletedAdviceItemSchema),
  /** 未命中的条目，逐项返回原因。 */
  notFound: z.array(NotFoundAdviceItemSchema),
});

export const deleteAdviceTool = defineTool({
  name: 'delete_advice',
  description:
    '按 id 删除历史建议（可批量，ids 1-100 个）；其 outcome 记录一并删除，删除后不可恢复',
  sideEffect: 'write',
  input: DeleteAdviceInput,
  output: DeleteAdviceOutput,
  handler: async (input, ctx) => {
    const notFound: z.infer<typeof NotFoundAdviceItemSchema>[] = [];
    const deleted: z.infer<typeof DeletedAdviceItemSchema>[] = [];
    for (const id of input.ids) {
      const existing = await ctx.repos.advice.findById(id);
      if (existing === null) {
        notFound.push({ id, reason: 'not-found' });
        continue;
      }
      await ctx.repos.advice.remove(id);
      deleted.push({
        adviceId: existing.id,
        subjectKind: existing.subjectKind,
        subjectId: existing.subjectId,
        decision: existing.decision,
        createdAt: existing.createdAt,
      });
    }
    return { deleted, notFound };
  },
});
