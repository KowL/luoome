import { AdviceDecisionSchema, type AdviceQuery, AdviceSchema } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errNotFound } from '../define-tool.js';
import { accountScopedAdvices } from '../internal/account-advice-outcomes.js';
import { selectAdvices } from '../internal/advice-selection.js';

/**
 * 列出账户既有建议（REQ-M3-17 ③ 的数据来源）。
 *
 * 归属：复用 `accountScopedAdvices`（`get_advice_stats` / `get-confidence-calibration` /
 * `get-strategy-decision-cycles` 用的是同一份），**不另写一套「哪些建议属于这个账户」**。
 * 过期与 outcome：复用 `selectAdvices`，与 `get_advice` 同一实现。
 */
export const ListAdvicesInput = z
  .object({
    accountId: z.string().min(1).optional(),
    since: z.coerce.date().optional(),
    until: z.coerce.date().optional(),
    decision: AdviceDecisionSchema.optional(),
    /** 默认 false：已过期建议（validUntil <= now）不返回，与 `get_advice` 一致。 */
    includeExpired: z.boolean().default(false),
    limit: z.number().int().positive().max(200).default(20),
  })
  .strict();
export type ListAdvicesInput = z.output<typeof ListAdvicesInput>;

export const AdviceListItemSchema = z
  .object({
    id: z.string().min(1),
    subjectKind: AdviceSchema.shape.subjectKind,
    subjectId: z.string().min(1),
    stockName: z.string().optional(),
    decision: AdviceDecisionSchema,
    confidence: z.number().min(0).max(100),
    dataAsOf: z.coerce.date(),
    validFrom: z.coerce.date(),
    validUntil: z.coerce.date(),
    counterEvidence: z.array(z.string()),
    risks: z.array(z.string()),
    disclaimers: z.array(z.string()),
    outcome: AdviceSchema.shape.outcome,
    /** 该建议缺反证时为 true——不补默认值，由调用方按可用性披露。 */
    counterEvidenceMissing: z.boolean(),
  })
  .strict();
export type AdviceListItem = z.output<typeof AdviceListItemSchema>;

export const ListAdvicesOutput = z
  .object({
    advices: z.array(AdviceListItemSchema),
    total: z.number().int().nonnegative(),
    /** 缺反证的建议 id 列表（可用性披露用，不假装有反证）。 */
    missingCounterEvidenceIds: z.array(z.string()),
  })
  .strict();
export type ListAdvicesOutput = z.output<typeof ListAdvicesOutput>;

export const listAdvicesTool = defineTool({
  name: 'list_advices',
  description:
    '列出账户既有建议（含决策、有效期、反证、风险、免责与回填状态），默认不含已过期；用于盘前简报的「既有建议与反证」段',
  sideEffect: 'read',
  input: ListAdvicesInput,
  output: ListAdvicesOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    if (!accountId || (await ctx.repos.account.findById(accountId)) === null)
      return errNotFound('Account', accountId);
    const filter: AdviceQuery = {
      ...(input.decision !== undefined ? { decision: input.decision } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      includeExpired: true,
    };
    const selected = await selectAdvices(ctx, accountId, filter, {
      includeExpired: input.includeExpired,
      limit: input.limit,
    });
    // 归属过滤复用既有实现：`selectAdvices` 只负责过期/outcome，账户归属在这里。
    const scoped = await accountScopedAdvices(ctx, accountId, selected);
    const advices = scoped.map((advice) => ({
      id: advice.id,
      subjectKind: advice.subjectKind,
      subjectId: advice.subjectId,
      ...(advice.stockName === undefined ? {} : { stockName: advice.stockName }),
      decision: advice.decision,
      confidence: advice.confidence,
      dataAsOf: advice.basedOn.dataAsOf,
      validFrom: advice.validFrom,
      validUntil: advice.validUntil,
      counterEvidence: advice.reasoning.counterEvidence,
      risks: advice.risks,
      disclaimers: advice.disclaimers,
      ...(advice.outcome === undefined ? {} : { outcome: advice.outcome }),
      counterEvidenceMissing: advice.reasoning.counterEvidence.length === 0,
    }));
    return ListAdvicesOutput.parse({
      advices,
      total: advices.length,
      missingCounterEvidenceIds: advices
        .filter((advice) => advice.counterEvidenceMissing)
        .map((advice) => advice.id),
    });
  },
});
