import {
  type AdviceDecision,
  AdviceSchema,
  type StockBrief,
  StockBriefPhaseSchema,
  StockBriefSchema,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool } from '../define-tool.js';

/**
 * 个股观察只读查询（design.md §5.1 / §12.2）。
 *
 * 只读本地 `stock_briefs` / `advices`：不调 LLM、不拉外部行情、不触发生成。
 * 展示层文案统一在这里映射，后端 `decision` 枚举保持不变。
 */

export const BRIEF_DISCLAIMER =
  '本内容为技术研究记录，不构成投资建议；投资有风险，决策需自行承担。';

export const StockBriefWordingLabelSchema = z.enum([
  '偏多信号',
  '偏空信号',
  '中性观察',
  '待确认观察',
  '回避观察',
  '规则观察（低置信）',
  '暂无观察',
]);
export type StockBriefWordingLabel = z.infer<typeof StockBriefWordingLabelSchema>;

export const StockBriefWordingSchema = z.object({
  label: StockBriefWordingLabelSchema,
  /** 只描述事实与条件，不含任何操作动词。 */
  detail: z.string().min(1),
  disclaimer: z.string().min(1),
  isRuleOnly: z.boolean(),
});
export type StockBriefWording = z.infer<typeof StockBriefWordingSchema>;

const DECISION_WORDING: Readonly<
  Record<AdviceDecision, { label: StockBriefWordingLabel; detail: string }>
> = {
  buy: {
    label: '偏多信号',
    detail: '偏多条件成立；研究区间与量能条件由用户自行判断，价格字段均为研究参考位。',
  },
  sell: {
    label: '偏空信号',
    detail: '风险位之下偏空条件成立；参考位仅作研究参考。',
  },
  hold: {
    label: '中性观察',
    detail: '无新增事实，维持上一观察；下一复核点见 premise。',
  },
  watch: {
    label: '待确认观察',
    detail: '观察区间内的条件未满足前维持观察。',
  },
  avoid: {
    label: '回避观察',
    detail: '当前不满足研究条件，原因见证据与降级项。',
  },
};

/** brief（或缺失）→ §12.2 展示文案。 */
export const stockBriefWordingOf = (brief: StockBrief | undefined): StockBriefWording => {
  if (brief === undefined) {
    return {
      label: '暂无观察',
      detail: '当前没有该标的的观察记录；需要时由用户显式触发每日观察批次生成。',
      disclaimer: BRIEF_DISCLAIMER,
      isRuleOnly: false,
    };
  }
  if (brief.quality === 'unavailable') {
    return {
      label: '暂无观察',
      detail: '数据不可用，未形成观察结论；缺失维度见 warnings。',
      disclaimer: BRIEF_DISCLAIMER,
      isRuleOnly: false,
    };
  }
  if (brief.quality === 'rule-only') {
    return {
      label: '规则观察（低置信）',
      detail: 'AI 分析不可用，仅展示确定性规则结果；置信度低，只作记录。',
      disclaimer: BRIEF_DISCLAIMER,
      isRuleOnly: true,
    };
  }
  const wording = DECISION_WORDING[brief.decision];
  return {
    label: wording.label,
    detail: wording.detail,
    disclaimer: BRIEF_DISCLAIMER,
    isRuleOnly: false,
  };
};

export const GetStockBriefInput = z.object({
  stockId: z.string().trim().min(1),
  /** Asia/Shanghai 交易日；缺省取最近一条。 */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  accountId: z.string().min(1).optional(),
  phase: StockBriefPhaseSchema.optional(),
});

export const GetStockBriefOutput = z.object({
  stockId: z.string().min(1),
  stockName: z.string().min(1).optional(),
  date: z.string().min(1).optional(),
  phase: StockBriefPhaseSchema.optional(),
  brief: StockBriefSchema.optional(),
  advice: AdviceSchema.optional(),
  warnings: z.array(z.string().min(1)),
  wording: StockBriefWordingSchema,
});
export type GetStockBriefOutput = z.infer<typeof GetStockBriefOutput>;

const warningsOf = (input: {
  readonly brief: StockBrief | undefined;
  readonly date: string | undefined;
  readonly hasAdvice: boolean;
  readonly now: Date;
}): string[] => {
  const warnings: string[] = [];
  if (input.brief === undefined) {
    warnings.push('当日未生成该标的的观察记录；本工具不会触发生成。');
    return warnings;
  }
  if (input.brief.quality === 'ai' && !input.hasAdvice) {
    warnings.push('观察记录标记为 AI 结论，但对应建议已不可读（可能已被删除）。');
  }
  if (input.brief.quality === 'partial') {
    warnings.push(
      `部分数据维度不可用：${input.brief.missing.map((item) => item.dimension).join('、')}`,
    );
  }
  if (input.brief.quality === 'rule-only') {
    warnings.push('本条为规则观察（低置信），不是 AI 结论。');
  }
  if (input.brief.quality === 'unavailable') {
    warnings.push(
      `数据不可用，未形成观察结论：${
        input.brief.missing.map((item) => item.reason).join('；') || '未记录原因'
      }`,
    );
  }
  if (input.brief.missing.length > 0 && input.brief.quality !== 'unavailable') {
    for (const item of input.brief.missing) {
      warnings.push(`数据缺口 ${item.dimension}：${item.reason}`);
    }
  }
  if (input.brief.validUntil.getTime() < input.now.getTime()) {
    warnings.push('该观察记录已过期，仅作历史参考。');
  }
  if (input.date === undefined) {
    warnings.push('未指定交易日，返回该标的最近一条观察记录。');
  }
  return warnings;
};

/** 个股观察记录（design.md §5.1）：`read`，只读本地，不触发生成。 */
export const getStockBriefTool = defineTool({
  name: 'get_stock_brief',
  description:
    '读取某只股票的当日（或指定交易日）观察记录：结论、置信度、缺失维度、对应建议与展示用词。' +
    '只读本地记录，不触发 AI 生成；本内容为技术研究记录，不构成投资建议。',
  sideEffect: 'read',
  input: GetStockBriefInput,
  output: GetStockBriefOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const rows = await ctx.repos.stockBrief.findByStock({
      stockId: input.stockId,
      accountId,
      ...(input.date === undefined ? {} : { tradingDate: input.date }),
      limit: 20,
    });
    const brief =
      input.phase === undefined ? rows[0] : rows.find((row) => row.phase === input.phase);
    const advice =
      brief?.adviceId === undefined ? null : await ctx.repos.advice.findById(brief.adviceId);
    const stock = await ctx.repos.stock.findById(input.stockId);
    return GetStockBriefOutput.parse({
      stockId: input.stockId,
      ...(stock === null ? {} : { stockName: stock.name }),
      ...(brief === undefined ? {} : { date: brief.tradingDate, phase: brief.phase }),
      ...(brief === undefined ? {} : { brief }),
      ...(advice === null ? {} : { advice }),
      warnings: warningsOf({
        brief,
        date: input.date,
        hasAdvice: advice !== null,
        now: ctx.clock(),
      }),
      wording: stockBriefWordingOf(brief),
    });
  },
});
