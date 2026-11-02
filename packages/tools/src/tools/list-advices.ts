import {
  AdviceDecisionSchema,
  AdviceHistoryStatusSchema,
  type AdviceQuery,
  AdviceSchema,
  AdviceStaleReasonSchema,
  adviceHistoryMark,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errNotFound } from '../define-tool.js';
import { selectAdvices } from '../internal/advice-selection.js';

/**
 * 列出账户既有建议（REQ-M3-17 ③ 的数据来源）。
 *
 * 归属 / 过期 / outcome：全部复用 `selectAdvices`（它内部用 `adviceAttribution`，
 * 与 `get_advice_stats` / `get_confidence_calibration` / `get_strategy_decision_cycles` 同一份），
 * **不另写一套「哪些建议属于这个账户」**。
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
    /** REQ-M5-03 第 1 项：历史标识（与 `list_advices` 输出里的同名同义）。 */
    historyStatus: AdviceHistoryStatusSchema,
    staleReason: AdviceStaleReasonSchema.nullable(),
    validFrom: z.coerce.date(),
    validUntil: z.coerce.date(),
    counterEvidence: z.array(z.string()),
    risks: z.array(z.string()),
    disclaimers: z.array(z.string()),
    outcome: AdviceSchema.shape.outcome,
    /**
     * 该建议缺反证时为 true——不补默认值，由调用方按可用性披露。
     *
     * 档位：`0`（false = 有反证；true = **缺席**的显式标记）。这里用布尔而不是 `?? []`，
     * 因为空数组与「没有反证」在语义上不可区分。
     */
    counterEvidenceMissing: z.boolean(),
  })
  .strict();
export type AdviceListItem = z.output<typeof AdviceListItemSchema>;

export const ListAdvicesOutput = z
  .object({
    /**
     * 恒为 `account`：本工具**按账户归属过滤**（与 `get_advice` 的 `all-accounts` 相对）。
     * 标注放在结果里，调用方不必靠文档判断这批建议属于谁。
     */
    scope: z.literal('account'),
    advices: z.array(AdviceListItemSchema),
    total: z.number().int().nonnegative(),
    /**
     * 缺反证的建议 id 列表（可用性披露用，不假装有反证）。
     *
     * 档位：`0`（空数组 = 全部有反证，是事实；非空 = 点名哪些是**缺席**）。
     */
    missingCounterEvidenceIds: z.array(z.string()),
    /**
     * 本次查询命中、但**无法归属到任何账户**的建议条数（存量无归属数据）。
     * 它们不会出现在 `advices` 里，但必须被计数披露——不许静默丢弃。
     */
    unattributedCount: z.number().int().nonnegative(),
  })
  .strict();
export type ListAdvicesOutput = z.output<typeof ListAdvicesOutput>;

export const listAdvicesTool = defineTool({
  name: 'list_advices',
  description:
    '列出**本账户**既有建议（按账户归属过滤，输出 scope 恒为 account；含决策、有效期、反证、风险、免责与回填状态），' +
    '默认不含已过期；用于盘前简报的「既有建议与反证」段。' +
    '需要跨账户按条件检索时用 get_advice',
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
    // 账户归属 + 过期 + outcome 全在 `selectAdvices` 里（与 `get_advice` 同一实现）。
    const { advices: scoped, unattributedCount } = await selectAdvices(ctx, accountId, filter, {
      includeExpired: input.includeExpired,
      limit: input.limit,
    });
    /**
     * 历史标识需要「今天」的起点。**按业务时区算**（与其它面板一致用 Asia/Shanghai），
     * 而不是 UTC——否则跨日判断会差 8 小时。
     */
    const now = ctx.clock();
    const shanghaiToday = new Date(now.getTime() + 8 * 3_600_000);
    const todayStart = new Date(
      Date.UTC(
        shanghaiToday.getUTCFullYear(),
        shanghaiToday.getUTCMonth(),
        shanghaiToday.getUTCDate(),
      ) -
        8 * 3_600_000,
    );
    const advices = scoped.map((advice) => ({
      id: advice.id,
      subjectKind: advice.subjectKind,
      subjectId: advice.subjectId,
      ...(advice.stockName === undefined ? {} : { stockName: advice.stockName }),
      decision: advice.decision,
      confidence: advice.confidence,
      dataAsOf: advice.basedOn.dataAsOf,
      // REQ-M5-03 第 1 项：**历史标识**。回显原 `dataAsOf` 之外，
      // 还要标明「它是不是今天的」——否则跨会话检索到的旧结论会被当成当前事实。
      ...adviceHistoryMark({
        validUntil: advice.validUntil,
        dataAsOf: advice.basedOn.dataAsOf,
        now,
        todayStart,
      }),
      validFrom: advice.validFrom,
      validUntil: advice.validUntil,
      counterEvidence: advice.reasoning.counterEvidence,
      risks: advice.risks,
      disclaimers: advice.disclaimers,
      ...(advice.outcome === undefined ? {} : { outcome: advice.outcome }),
      counterEvidenceMissing: advice.reasoning.counterEvidence.length === 0,
    }));
    return ListAdvicesOutput.parse({
      scope: 'account',
      advices,
      total: advices.length,
      missingCounterEvidenceIds: advices
        .filter((advice) => advice.counterEvidenceMissing)
        .map((advice) => advice.id),
      unattributedCount,
    });
  },
});
