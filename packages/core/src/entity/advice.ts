import { z } from 'zod';
import { dateInShanghai, isHoliday, isWeekend, previousTradingDate } from '../trading-calendar.js';
import { type Money, MoneySchema, money } from '../types/branded.js';
import { renderAdviceCard } from './advice-card.js';
import { type AnalysisProvenance, AnalysisProvenanceSchema } from './analysis-provenance.js';
import { type TechnicalIndicators, TechnicalIndicatorsSchema } from './indicator-set.js';
import { notificationText, notificationTime } from './notification.js';
import { type Quote, QuoteSchema } from './quote.js';
import { ActiveSignalObservationHorizonSchema } from './signal-observation.js';

// ---------- 枚举类型（ARCHITECTURE §5.2） ----------

export type AdviceDecision = 'buy' | 'sell' | 'hold' | 'watch' | 'avoid';
export type AdviceSubjectKind = 'stock' | 'portfolio' | 'market' | 'sector' | 'position';
export type AdviceHorizon = 'intraday' | 'short' | 'medium' | 'long';

export const AdviceDecisionSchema = z.enum(['buy', 'sell', 'hold', 'watch', 'avoid']);
export const AdviceSubjectKindSchema = z.enum([
  'stock',
  'portfolio',
  'market',
  'sector',
  'position',
]);
export const AdviceHorizonSchema = z.enum(['intraday', 'short', 'medium', 'long']);
export const ActiveStrategyRecommendationTriggerSchema = z.union([
  z.literal('run'),
  ActiveSignalObservationHorizonSchema,
]);
export type ActiveStrategyRecommendationTrigger = z.infer<
  typeof ActiveStrategyRecommendationTriggerSchema
>;
/** `t20` 只为读取已经生成的 Advice 证据保留。 */
export const StrategyRecommendationTriggerSchema = z.union([
  ActiveStrategyRecommendationTriggerSchema,
  z.literal('t20'),
]);
export type StrategyRecommendationTrigger = z.infer<typeof StrategyRecommendationTriggerSchema>;

/**
 * Advice 有效期映射（ARCHITECTURE §6.5），单位：交易日。
 * intraday 为 0：由调用方结合 clock 截断到当日 15:00 收盘。
 */
export const adviceExpiryDays: Record<AdviceHorizon, number> = {
  intraday: 0, // 当日 15:00
  short: 3, // +3 个交易日
  medium: 20, // +20 个交易日
  long: 60, // +60 个交易日
};

// ---------- 免责声明（docs/archive/MVP-TASK.md §2.3，恰好 3 条，硬约束） ----------

export const STANDARD_DISCLAIMERS = [
  '本建议由 AI 生成，基于历史数据与技术指标，不构成投资建议。',
  '投资有风险，决策需自行承担。',
  '市场有不可预测性，过往表现不代表未来收益。',
] as const;

// ---------- Advice 结构（ARCHITECTURE §5.2） ----------

export interface AdviceReasoning {
  readonly premise: string; // 核心论点（一句话）
  readonly evidence: readonly string[]; // 支持证据（数据点引用）
  readonly counterEvidence: readonly string[]; // 反证
}

/** 数据快照：advice 产出瞬间引用的数据，事后可复盘。 */
export interface AdviceDataSnapshot {
  readonly quotes?: Record<string, Quote>;
  readonly indicators?: Record<string, TechnicalIndicators>;
  readonly ladder?: AdviceLadderSnapshot;
  readonly strategy?: StrategyAdviceEvidence;
  readonly dataAsOf: Date; // 数据截止时间
}

export interface StrategyAdviceEvidence {
  readonly strategyId: string;
  readonly strategyVersionId: string;
  readonly runId: string;
  readonly stockId: string;
  /** V2 account provenance; absent on legacy Advice and therefore not trusted for V2 cooldown. */
  readonly accountId?: string;
  readonly score?: number;
  readonly rank?: number;
  readonly resultEvidence: readonly string[];
  readonly signalIds: readonly string[];
  readonly observationIds: readonly string[];
  readonly recommendationTrigger: StrategyRecommendationTrigger;
}

/** 市场观点引用的天梯摘要，避免把完整快照复制进 Advice JSON。 */
export interface AdviceLadderSnapshot {
  readonly date: string;
  readonly total: number;
  readonly maxLevel: number;
  readonly source: string;
  readonly levels: readonly { readonly level: number; readonly count: number }[];
  readonly warnings: readonly string[];
}

export const AdviceLadderSnapshotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  total: z.number().int().nonnegative(),
  maxLevel: z.number().int().nonnegative(),
  source: z.string().min(1),
  levels: z.array(
    z.object({ level: z.number().int().positive(), count: z.number().int().nonnegative() }),
  ),
  warnings: z.array(z.string()),
});

export interface Advice {
  readonly provenance?: AnalysisProvenance;
  readonly id: string;
  readonly subjectKind: AdviceSubjectKind;
  readonly subjectId: string; // stockId / accountId / sectorName ...
  /** 标的名称（如股票名称），生成时快照保存，避免历史建议回显时依赖外部查询。 */
  readonly stockName?: string;
  readonly decision: AdviceDecision;
  readonly confidence: number; // 0-100
  readonly horizon: AdviceHorizon;
  /**
   * 操作价位建议（AI 基于近期走势 + 策略信号给出）；观望（watch）或信息不足时可缺省。
   * entryPrice=兼容旧 Advice 的建议买点；entryPriceLow/High 是新计划使用的入场区间；
   * targetPositionPct 是按账户总资产计算的目标仓位（旧单值）；
   * targetPositionPctRange 是区间版本（百分点，min≤max），有区间时以区间为准；
   * stopLoss=止损价。
   */
  readonly entryPrice?: Money;
  readonly entryPriceLow?: Money;
  readonly entryPriceHigh?: Money;
  readonly targetPositionPct?: number;
  readonly targetPositionPctRange?: TargetPositionPctRange;
  readonly targetPrice?: Money;
  readonly stopLoss?: Money;
  readonly reasoning: AdviceReasoning;
  readonly risks: readonly string[];
  readonly disclaimers: readonly string[]; // 必填，至少包含 STANDARD_DISCLAIMERS
  readonly sourceTool?: string; // 哪个 tool 产出
  readonly sourceWorkflow?: string; // 哪个 workflow 产出
  readonly basedOn: AdviceDataSnapshot;
  readonly validFrom: Date;
  readonly validUntil: Date; // 过期时间（不再被采纳）
  readonly createdAt: Date;
  /** v0.3 起：可选的回填结果（事后复盘）；不存在 = 待回填。 */
  readonly outcome?: AdviceOutcome;
}

/**
 * 回填来源（REQ-M3-18 §2）。
 *
 * 「AI 不得代填建议兑现」不能只靠复盘页的 UI 入口：`record_advice_outcome` 在任何会话
 * 里都能被直接调用。所以写入层必须自己标注来源，统计层默认只认 `user`。
 * 该字段**不是调用方入参**：由写入路径按所在通道盖章（见 `ToolContext.adviceOutcomeOrigin`），
 * 模型无法通过工具参数把它写成 `user`。
 */
export type AdviceOutcomeOrigin = 'user' | 'model' | 'import';
export const AdviceOutcomeOriginSchema = z.enum(['user', 'model', 'import']);

/**
 * 用户回填的四个选项（REQ-M3-18 §1）：兑现 / 部分兑现 / 忽略 / 不知道。
 *
 * `unknown` 是**回答**而不是 outcome：用户选「不知道」时没有任何可统计的兑现事实，
 * 因此不落 adviceFeedback（见 `record_advice_outcome` 与复盘页），分母不变。
 * 缺「不知道」等于逼用户在不知道时猜一个，正是本需求要堵的伪样本。
 */
export const ADVICE_OUTCOME_ANSWERS = [
  'followed',
  'partially_followed',
  'ignored',
  'unknown',
] as const;
export type AdviceOutcomeAnswer = (typeof ADVICE_OUTCOME_ANSWERS)[number];
export const ADVICE_OUTCOME_ANSWER_LABELS: Readonly<Record<AdviceOutcomeAnswer, string>> = {
  followed: '兑现',
  partially_followed: '部分兑现',
  ignored: '忽略',
  unknown: '不知道',
};

/** 建议结果回填（事后验证，ARCHITECTURE §5.2）。 */
export interface AdviceOutcome {
  readonly adviceId: string;
  /** 实际执行关联的交易记录；空数组表示未关联具体成交。 */
  readonly tradeIds: readonly string[];
  readonly outcome: 'followed' | 'partially_followed' | 'ignored';
  /**
   * 回填来源。存量（REQ-M3-18 之前）记录没有该字段：无法追溯是谁填的，
   * 统计侧单列为 unattested，不默认当成用户回填。
   */
  readonly origin?: AdviceOutcomeOrigin;
  readonly pnl?: Money; // 实际盈亏
  readonly benchmarkPnl?: Money; // 同期基准盈亏
  /** 跟单持仓时长（小时）。 */
  readonly holdingHours?: number;
  /** 用户填写的复盘笔记。 */
  readonly notes?: string;
  readonly recordedAt: Date;
}

/** AdviceRepository.query 的过滤条件。 */
export interface AdviceQuery {
  readonly subjectKind?: AdviceSubjectKind;
  readonly subjectId?: string;
  readonly decision?: AdviceDecision;
  readonly sourceTool?: string;
  readonly since?: Date;
  readonly until?: Date;
  /** 默认 false：过期 advice 不主动返回（ARCHITECTURE §6.5）。 */
  readonly includeExpired?: boolean;
  readonly limit?: number;
}

/** AdviceOutcome 的查询条件；subject 条件通过关联 Advice 过滤。 */
export interface AdviceOutcomeQuery {
  readonly adviceId?: string;
  readonly subjectKind?: AdviceSubjectKind;
  readonly subjectId?: string;
  /** 按 outcome.recordedAt 过滤（闭区间）。 */
  readonly since?: Date;
  readonly until?: Date;
  readonly limit?: number;
}

// ---------- Zod schema ----------

export const AdviceReasoningSchema = z.object({
  premise: z.string().min(1),
  evidence: z.array(z.string()),
  counterEvidence: z.array(z.string()),
});

/** 目标仓位区间：百分点 0–100，与 TradingPlan 的 targetPctRange 同量纲；min ≤ max。 */
export const TargetPositionPctRangeSchema = z
  .object({
    min: z.number().finite().min(0).max(100),
    max: z.number().finite().min(0).max(100),
  })
  .strict()
  .superRefine((range, ctx) => {
    if (range.min > range.max) {
      ctx.addIssue({ code: 'custom', path: ['min'], message: '区间 min 不能大于 max' });
    }
  });
export type TargetPositionPctRange = z.infer<typeof TargetPositionPctRangeSchema>;

/** 新生成的个股策略判断使用严格契约，历史 Advice 继续由 AdviceSchema 读取。 */
export const StrategyAdviceAnalysisSchema = z
  .object({
    decision: AdviceDecisionSchema,
    confidence: z.number().min(0).max(100),
    horizon: AdviceHorizonSchema,
    entryPrice: z.number().finite().positive().optional(),
    entryPriceLow: z.number().finite().positive().optional(),
    entryPriceHigh: z.number().finite().positive().optional(),
    targetPositionPct: z.number().finite().min(0).max(100).optional(),
    /** 区间优先于单值；单值保留给旧数据与展示兼容。 */
    targetPositionPctRange: TargetPositionPctRangeSchema.optional(),
    targetPrice: z.number().finite().positive().optional(),
    stopLoss: z.number().finite().positive().optional(),
    reasoning: AdviceReasoningSchema.extend({
      premise: z.string().trim().min(1),
      evidence: z.array(z.string().trim().min(1)).min(1),
      counterEvidence: z.array(z.string().trim().min(1)).min(1),
    }),
    risks: z.array(z.string().trim().min(1)).min(1),
  })
  .superRefine((advice, ctx) => {
    const {
      entryPrice,
      entryPriceLow,
      entryPriceHigh,
      targetPositionPct,
      targetPositionPctRange,
      targetPrice,
      stopLoss,
    } = advice;
    if (
      advice.decision === 'buy' ||
      entryPrice !== undefined ||
      entryPriceLow !== undefined ||
      entryPriceHigh !== undefined ||
      targetPositionPct !== undefined ||
      targetPositionPctRange !== undefined ||
      targetPrice !== undefined ||
      stopLoss !== undefined
    ) {
      if (entryPrice === undefined || targetPrice === undefined || stopLoss === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['entryPrice'],
          message: '买入或给出价位时必须同时提供买点、目标价和止损价',
        });
      } else if (
        (entryPriceLow === undefined) !== (entryPriceHigh === undefined) ||
        (entryPriceLow !== undefined &&
          entryPriceHigh !== undefined &&
          entryPriceLow > entryPriceHigh) ||
        (advice.decision === 'buy' &&
          (entryPriceLow === undefined ||
            entryPriceHigh === undefined ||
            (targetPositionPct === undefined && targetPositionPctRange === undefined))) ||
        !(
          money(stopLoss) > 0 &&
          money(stopLoss) < money(entryPrice) &&
          money(entryPrice) < money(targetPrice)
        ) ||
        (entryPriceLow !== undefined &&
          entryPriceHigh !== undefined &&
          !(
            money(stopLoss) < money(entryPriceLow) && money(entryPriceHigh) < money(targetPrice)
          )) ||
        (entryPriceLow !== undefined &&
          entryPriceHigh !== undefined &&
          entryPrice !== undefined &&
          !(entryPriceLow <= entryPrice && entryPrice <= entryPriceHigh))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['stopLoss'],
          message:
            '价格必须满足 0 < 止损价 < 入场区间 <= 目标价，且买点落在入场区间内；买入还必须提供目标仓位（单值或区间）',
        });
      }
      if (
        targetPositionPct !== undefined &&
        targetPositionPctRange !== undefined &&
        (targetPositionPct < targetPositionPctRange.min ||
          targetPositionPct > targetPositionPctRange.max)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['targetPositionPctRange'],
          message: '单值目标仓位必须落在目标仓位区间内',
        });
      }
    }
  });

export const isAdviceQuoteCurrent = (quote: Quote, now: Date): boolean => {
  if (quote.observedAt > now) return false;
  const local = new Date(now.getTime() + 8 * 3_600_000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  const tradingDate = !isWeekend(now) && !isHoliday(now);
  const today = dateInShanghai(now);
  const expectedDate = tradingDate && minutes >= 570 ? today : previousTradingDate(now);
  if (dateInShanghai(quote.observedAt) !== expectedDate) return false;
  const dailyBar = quote.source.startsWith('daily-bar-fallback:');
  if (dailyBar) return expectedDate !== today || minutes >= 900;
  const cutoff =
    tradingDate && minutes >= 570 && minutes <= 900
      ? minutes > 690 && minutes < 780
        ? new Date(`${today}T11:30:00+08:00`)
        : now
      : new Date(`${expectedDate}T15:00:00+08:00`);
  return quote.observedAt.getTime() >= cutoff.getTime() - 180_000;
};

// 存量 basedOn JSON 可能仍含已下线的 tacticSignals key；zod object 默认 strip，
// 读出时静默忽略，不需要保留旧 schema。

export const AdviceDataSnapshotSchema = z.object({
  quotes: z.record(z.string(), QuoteSchema).optional(),
  indicators: z.record(z.string(), TechnicalIndicatorsSchema).optional(),
  ladder: AdviceLadderSnapshotSchema.optional(),
  strategy: z
    .object({
      strategyId: z.string().min(1),
      strategyVersionId: z.string().min(1),
      runId: z.string().min(1),
      stockId: z.string().min(1),
      accountId: z.string().min(1).optional(),
      score: z.number().min(0).max(100).optional(),
      rank: z.number().int().positive().optional(),
      resultEvidence: z.array(z.string()),
      signalIds: z.array(z.string()),
      observationIds: z.array(z.string()),
      recommendationTrigger: StrategyRecommendationTriggerSchema,
    })
    .optional(),
  dataAsOf: z.coerce.date(),
});

export const AdviceOutcomeSchema = z.object({
  adviceId: z.string().min(1),
  tradeIds: z.array(z.string().min(1)).default([]),
  outcome: z.enum(['followed', 'partially_followed', 'ignored']),
  origin: AdviceOutcomeOriginSchema.optional(),
  pnl: MoneySchema.optional(),
  benchmarkPnl: MoneySchema.optional(),
  holdingHours: z.number().nonnegative().optional(),
  notes: z.string().max(2000).optional(),
  recordedAt: z.coerce.date(),
});

/**
 * 从**冻结的 analysis context 事实**派生 `basedOn`。
 *
 * 历史上 `recordAdvice` 直接写 `basedOn: { dataAsOf }`，把 context 里已经冻结的行情与
 * 策略运行证据丢掉了；而下游（逐股交易计划、收盘报告「策略行动」）恰恰依赖
 * `basedOn.strategy` 判断这条建议来自哪次已发布运行。这里改为从事实包还原，
 * 保证「建议引用了什么证据」与「context 冻结了什么证据」是同一份。
 */
export const adviceDataSnapshotFromFacts = (
  facts: readonly { readonly id: string; readonly value: unknown }[],
  dataAsOf: Date,
): AdviceDataSnapshot => {
  const quotes: Record<string, Quote> = {};
  let strategy: StrategyAdviceEvidence | undefined;
  for (const fact of facts) {
    if (fact.id.startsWith('quote:')) {
      const parsed = QuoteSchema.safeParse(fact.value);
      if (parsed.success) quotes[parsed.data.stockId] = parsed.data;
      continue;
    }
    if (fact.id.startsWith('strategy-run:')) {
      const parsed = AdviceDataSnapshotSchema.shape.strategy.safeParse(fact.value);
      if (!parsed.success || parsed.data === undefined) continue;
      const value = parsed.data;
      strategy = {
        strategyId: value.strategyId,
        strategyVersionId: value.strategyVersionId,
        runId: value.runId,
        stockId: value.stockId,
        ...(value.accountId === undefined ? {} : { accountId: value.accountId }),
        ...(value.score === undefined ? {} : { score: value.score }),
        ...(value.rank === undefined ? {} : { rank: value.rank }),
        resultEvidence: value.resultEvidence,
        signalIds: value.signalIds,
        observationIds: value.observationIds,
        recommendationTrigger: value.recommendationTrigger,
      };
    }
  }
  return {
    ...(Object.keys(quotes).length === 0 ? {} : { quotes }),
    ...(strategy === undefined ? {} : { strategy }),
    dataAsOf,
  };
};

export const AdviceSchema = z.object({
  provenance: AnalysisProvenanceSchema.optional(),
  id: z.string().min(1),
  subjectKind: AdviceSubjectKindSchema,
  subjectId: z.string().min(1),
  stockName: z.string().optional(),
  decision: AdviceDecisionSchema,
  confidence: z.number().min(0).max(100),
  horizon: AdviceHorizonSchema,
  entryPrice: MoneySchema.optional(),
  entryPriceLow: MoneySchema.optional(),
  entryPriceHigh: MoneySchema.optional(),
  targetPositionPct: z.number().finite().min(0).max(100).optional(),
  targetPositionPctRange: TargetPositionPctRangeSchema.optional(),
  targetPrice: MoneySchema.optional(),
  stopLoss: MoneySchema.optional(),
  reasoning: AdviceReasoningSchema,
  risks: z.array(z.string()),
  disclaimers: z.array(z.string()).min(1),
  sourceTool: z.string().optional(),
  sourceWorkflow: z.string().optional(),
  basedOn: AdviceDataSnapshotSchema,
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date(),
  createdAt: z.coerce.date(),
  outcome: AdviceOutcomeSchema.optional(),
});

/**
 * 规则兜底标记：已删除的规则 fallback 生成路径曾在 `reasoning.evidence` 写此标记、
 * 在 `reasoning.premise` 写「LLM 推理不可用」。带任一标记的建议不是研究结论，
 * 不能作为生效计划；生成路径已下线，标记只读不写，这里只用于识别存量 Advice。
 */
export const RULE_FALLBACK_EVIDENCE_MARKER = '规则 fallback';

/** premise 侧标记没有导出常量：没有生产写入方，内联字面量即可（详见 ARCHITECTURE §8.1）。 */
export const isRuleFallbackAdvice = (advice: Pick<Advice, 'reasoning'>): boolean =>
  advice.reasoning.premise.includes('LLM 推理不可用') ||
  advice.reasoning.evidence.some((line) => line.includes(RULE_FALLBACK_EVIDENCE_MARKER));

export const AdviceQuerySchema = z.object({
  subjectKind: AdviceSubjectKindSchema.optional(),
  subjectId: z.string().optional(),
  decision: AdviceDecisionSchema.optional(),
  sourceTool: z.string().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  includeExpired: z.boolean().optional(),
  limit: z.number().int().positive().optional(),
});

/**
 * 通知文本：**消费 `renderAdviceCard`**，不再自己拼五段。
 *
 * 缺段时不再输出「未提供，需人工核对」这种半张卡（那会让人以为其余四段是完整结论），
 * 而是明确写「不可渲染：缺 X」。这与 PRD §2 的「阻断渲染并报缺段名」是同一条。
 */
export const adviceNotificationSummary = (
  advice: z.output<typeof AdviceSchema>,
  now: Date = new Date(),
): string => {
  if (isRuleFallbackAdvice(advice)) return 'AI 分析未完成，仅有规则兜底，暂不形成交易判断。';
  const card = renderAdviceCard(advice, now);
  if (card.status === 'blocked')
    return `${card.note}（建议 ${advice.id}）——本条建议不完整，不按建议内容行动，请核对原始研究结论。`;
  const decision = {
    buy: '考虑买入',
    sell: '考虑卖出',
    hold: '持有观察',
    watch: '等待确认',
    avoid: '暂时回避',
  }[advice.decision];
  const prices = [
    ...(advice.entryPriceLow !== undefined && advice.entryPriceHigh !== undefined
      ? [`入场 ${advice.entryPriceLow.toFixed(2)}–${advice.entryPriceHigh.toFixed(2)}`]
      : advice.entryPrice !== undefined
        ? [`参考买点 ${advice.entryPrice.toFixed(2)}`]
        : []),
    ...(advice.stopLoss === undefined ? [] : [`止损 ${advice.stopLoss.toFixed(2)}`]),
    ...(advice.targetPrice === undefined ? [] : [`目标 ${advice.targetPrice.toFixed(2)}`]),
  ];
  return [
    `**${decision}** · ${notificationText(card.conclusion, 100)}`,
    ...(prices.length === 0 ? [] : [prices.join(' · ')]),
    ...(advice.targetPositionPctRange !== undefined
      ? [
          `目标仓位 ${advice.targetPositionPctRange.min.toFixed(1)}–${advice.targetPositionPctRange.max.toFixed(1)}%（占账户总资产）`,
        ]
      : advice.targetPositionPct === undefined
        ? []
        : [`目标仓位 ${advice.targetPositionPct.toFixed(1)}%（占账户总资产）`]),
    `反证：${notificationText(card.counterEvidence.join('；'), 100)}`,
    `风险：${notificationText(card.risks.join('；'), 100)}`,
    `数据 ${notificationTime(card.dataAsOf)} · 有效至 ${notificationTime(card.validity.validUntil)}（北京时间）`,
    ...card.disclaimer.map((item) => `· ${item}`),
  ].join('\n');
};
