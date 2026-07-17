import {
  AdviceDecisionSchema,
  type AdviceQuery,
  AdviceSchema,
  AdviceSubjectKindSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

export const GetAdviceInput = z.object({
  subjectKind: AdviceSubjectKindSchema.optional(),
  subjectId: z.string().min(1).optional(),
  decision: AdviceDecisionSchema.optional(),
  sourceTool: z.string().min(1).optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间下界）。 */
  since: z.coerce.date().optional(),
  /** ISO 日期时间字符串；按 createdAt 过滤（闭区间上界）。 */
  until: z.coerce.date().optional(),
  /** 默认 false：已过期 advice（validUntil <= now）不返回（ARCHITECTURE §6.5）。 */
  includeExpired: z.boolean().default(false),
  limit: z.number().int().positive().max(500).default(50),
});

export const GetAdviceOutput = z.object({
  advices: z.array(AdviceSchema),
  total: z.number().int().nonnegative(),
});

export const getAdviceTool = defineTool({
  name: 'get_advice',
  description: '查询历史建议（按标的 / 决策 / 来源 / 时间窗过滤，默认不含已过期）',
  sideEffect: 'read',
  input: GetAdviceInput,
  output: GetAdviceOutput,
  handler: async (input, ctx) => {
    const filter: AdviceQuery = {
      ...(input.subjectKind !== undefined ? { subjectKind: input.subjectKind } : {}),
      ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
      ...(input.decision !== undefined ? { decision: input.decision } : {}),
      ...(input.sourceTool !== undefined ? { sourceTool: input.sourceTool } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      includeExpired: input.includeExpired,
      limit: input.limit,
    };
    const advices = await ctx.repos.advice.query(filter);
    // core Advice 的数组字段是 readonly，经 schema parse 得到输出类型（运行时零改动）。
    return { advices: z.array(AdviceSchema).parse(advices), total: advices.length };
  },
});
