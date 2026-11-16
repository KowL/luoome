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

export const DeleteAdviceOutput = z.object({
  deleted: z.number().int().nonnegative(),
  notFound: z.array(z.string()),
});

export const deleteAdviceTool = defineTool({
  name: 'delete_advice',
  description:
    '按 id 删除历史建议（可批量，ids 1-100 个）；其 outcome 记录一并删除，删除后不可恢复',
  sideEffect: 'write',
  input: DeleteAdviceInput,
  output: DeleteAdviceOutput,
  handler: async (input, ctx) => {
    const notFound: string[] = [];
    let deleted = 0;
    for (const id of input.ids) {
      if ((await ctx.repos.advice.findById(id)) === null) {
        notFound.push(id);
        continue;
      }
      await ctx.repos.advice.remove(id);
      deleted += 1;
    }
    return { deleted, notFound };
  },
});
