import { z } from 'zod';
import { InvariantError } from '../error/index.js';
import { dateInShanghai } from '../trading-calendar.js';
import {
  type AnalysisKind,
  AnalysisKindSchema,
  AnalysisSubjectSchema,
  analysisSubjectKinds,
} from './analysis-job.js';

/**
 * 结构化缺口（REQ-M3-02）。`kind` 可枚举，供多智能体 gate 区分：
 * - blocking（缺事实导致不可判）→ `unavailable`
 * - degraded（部分缺但仍可判）→ `partial`
 * 旧字段 `limitations: string[]` 保留为展示/兼容，语义不变。
 */
export const ANALYSIS_MISSING_FACT_KINDS = [
  'quote-unavailable',
  'quote-stale',
  'account-facts-unavailable',
  'strategy-run-unavailable',
  'fundamental-unavailable',
  'research-unavailable',
  'market-breadth-unavailable',
  'news-unavailable',
  'industry-unavailable',
  'position-unavailable',
  'watch-facts-unavailable',
] as const;
export const AnalysisMissingFactKindSchema = z.enum(ANALYSIS_MISSING_FACT_KINDS);
export type AnalysisMissingFactKind = z.infer<typeof AnalysisMissingFactKindSchema>;
export const AnalysisMissingFactSchema = z
  .object({
    kind: AnalysisMissingFactKindSchema,
    subjectId: z.string().min(1),
    reason: z.string().min(1).max(500),
    asOf: z.coerce.date(),
  })
  .strict();
export type AnalysisMissingFact = z.infer<typeof AnalysisMissingFactSchema>;

/** 缺了就无法给出可判定结论的缺口；其余为“部分缺但仍可判”。 */
export const BLOCKING_MISSING_FACT_KINDS: ReadonlySet<AnalysisMissingFactKind> = new Set([
  'quote-unavailable',
  'quote-stale',
  'account-facts-unavailable',
  'strategy-run-unavailable',
]);

export const missingFactsAvailability = (
  facts: readonly AnalysisMissingFact[],
): 'complete' | 'partial' | 'unavailable' =>
  facts.some((fact) => BLOCKING_MISSING_FACT_KINDS.has(fact.kind))
    ? 'unavailable'
    : facts.length > 0
      ? 'partial'
      : 'complete';

export const AnalysisContextSchema = z
  .object({
    recordedResult: z.object({ hash: z.string().min(1), ref: z.string().min(1) }).optional(),
    id: z.string().min(1),
    jobId: z.string().min(1).nullable(),
    kind: AnalysisKindSchema,
    accountId: z.string().min(1),
    subject: AnalysisSubjectSchema,
    dataAsOf: z.coerce.date(),
    facts: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        value: z.json(),
        evidenceIds: z.array(z.string().min(1)),
      }),
    ),
    factIds: z.array(z.string().min(1)),
    limitations: z.array(z.string().min(1)),
    /** 结构化缺口；旧 context 没有该字段时按空数组读取（兼容）。 */
    missingFacts: z.array(AnalysisMissingFactSchema).default([]),
    contextHash: z.string().regex(/^[a-f0-9]{64}$/),
    writeUntil: z.coerce.date(),
    expiresAt: z.coerce.date(),
    createdAt: z.coerce.date(),
  })
  .superRefine((context, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (analysisSubjectKinds[context.kind] !== context.subject.kind)
      invalid('analysis_subject_mismatch');
    const ids = new Set(context.factIds);
    if (
      ids.size !== context.factIds.length ||
      context.facts.length !== ids.size ||
      new Set(context.facts.map((fact) => fact.id)).size !== ids.size ||
      context.facts.some((fact) => !ids.has(fact.id))
    )
      invalid('analysis_fact_ids_mismatch');
    if (
      context.dataAsOf > context.createdAt ||
      context.expiresAt < context.createdAt ||
      context.writeUntil > context.expiresAt
    )
      invalid('analysis_context_time_order_invalid');
  });
export type AnalysisContext = z.infer<typeof AnalysisContextSchema>;
export const assertAnalysisContextInvariants = (context: AnalysisContext): void => {
  const result = AnalysisContextSchema.safeParse(context);
  if (!result.success) throw new InvariantError(result.error.message);
};

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * `AnalysisKind` 的写回时效规则（docs/ARCHITECTURE.md §6.3）。
 * 盘中行动类的事实只有收盘前且足够新鲜时才有行动价值；市场/研究/策略结论允许
 * 盘后与隔日写回，但市场事实最长 7 天、研究/策略事实最长 30 天。
 * 15:00 截断只属于盘中行动类，套在其它 kind 上会让盘后研究恒过期。
 */
export interface AnalysisTimingRule {
  /** 从 context 装配时刻起允许写回的最长时长。 */
  readonly writeWindowMs: number;
  /** `dataAsOf` 至今允许的最大年龄，超过即 stale。 */
  readonly dataMaxAgeMs: number;
  /** 盘中行动类以当日 15:00（Asia/Shanghai）为硬截断。 */
  readonly closesAtSessionEnd: boolean;
}

const intradayActionRule: AnalysisTimingRule = {
  writeWindowMs: 30 * MINUTE_MS,
  dataMaxAgeMs: 30 * MINUTE_MS,
  closesAtSessionEnd: true,
};
const marketAnalysisRule: AnalysisTimingRule = {
  writeWindowMs: 24 * HOUR_MS,
  dataMaxAgeMs: 7 * DAY_MS,
  closesAtSessionEnd: false,
};
/**
 * 盘后策略候选建议：结论依据当日收盘后的已发布运行事实，天然晚于 15:00，
 * 因此不能套用盘中行动类的 30 分钟窗口与收盘截断；数据仍受 7 天有效期约束。
 */
const afterCloseStrategyRule: AnalysisTimingRule = {
  writeWindowMs: 24 * HOUR_MS,
  dataMaxAgeMs: 7 * DAY_MS,
  closesAtSessionEnd: false,
};
const researchAnalysisRule: AnalysisTimingRule = {
  writeWindowMs: 24 * HOUR_MS,
  dataMaxAgeMs: 30 * DAY_MS,
  closesAtSessionEnd: false,
};

/** 唯一事实来源：context 装配、enqueue、record、refresh 都读这张表。 */
export const analysisTimingRules: Readonly<Record<AnalysisKind, AnalysisTimingRule>> = {
  advice_stock: intradayActionRule,
  advice_position: intradayActionRule,
  advice_strategy_candidate: intradayActionRule,
  advice_strategy_candidate_after_close: afterCloseStrategyRule,
  advice_market: marketAnalysisRule,
  research_directions: researchAnalysisRule,
  strategy_version_proposal: researchAnalysisRule,
  strategy_insight_narrative: researchAnalysisRule,
};

export interface AnalysisContextTiming {
  /** 写回截止（排他）：`now >= writeUntil` 即 context_expired。 */
  readonly writeUntil: Date;
  /** 数据有效期：`now` 严格晚于该时刻即 stale_context。 */
  readonly staleAfter: Date;
}

const shanghaiSessionClose = (now: Date): Date => new Date(`${dateInShanghai(now)}T15:00:00+08:00`);

/** 按 kind 计算写回截止与数据有效期；盘后分析不再被 15:00 截断。 */
export const analysisContextTiming = (
  kind: AnalysisKind,
  dataAsOf: Date,
  now: Date,
): AnalysisContextTiming => {
  const rule = analysisTimingRules[kind];
  const staleAfter = new Date(dataAsOf.getTime() + rule.dataMaxAgeMs);
  const windowEnd = new Date(now.getTime() + rule.writeWindowMs);
  const cap = rule.closesAtSessionEnd ? shanghaiSessionClose(now) : staleAfter;
  return {
    writeUntil: new Date(Math.min(windowEnd.getTime(), cap.getTime())),
    staleAfter,
  };
};

export const isAnalysisContextStale = (kind: AnalysisKind, dataAsOf: Date, now: Date): boolean =>
  now.getTime() - dataAsOf.getTime() > analysisTimingRules[kind].dataMaxAgeMs;

/**
 * 写回窗口与数据新鲜度的统一校验。
 * 错误优先级：盘中行动类先报窗口关闭（`context_expired`，保持既有语义）；
 * 非盘中分析的写回窗口以数据有效期封顶，数据过期时先报 `stale_context`，
 * 提示消费者重新取事实，而不是误以为重取 context 就能写回。
 */
export const analysisContextTimingError = (
  context: Pick<AnalysisContext, 'kind' | 'dataAsOf' | 'writeUntil' | 'expiresAt'>,
  now: Date,
): 'context_expired' | 'stale_context' | undefined => {
  const expired = now >= context.writeUntil || now >= context.expiresAt;
  const stale = isAnalysisContextStale(context.kind, context.dataAsOf, now);
  if (stale && (!expired || !analysisTimingRules[context.kind].closesAtSessionEnd))
    return 'stale_context';
  if (expired) return 'context_expired';
  return undefined;
};

export const analysisContextWriteError = (
  context: AnalysisContext,
  now: Date,
  evidenceFactIds: readonly string[],
): 'context_expired' | 'stale_context' | 'unknown_fact_reference' | undefined => {
  const facts = new Set(context.factIds);
  if (evidenceFactIds.some((id) => !facts.has(id))) return 'unknown_fact_reference';
  return analysisContextTimingError(context, now);
};

export const analysisAdviceContextError = (
  context: AnalysisContext,
  advice: import('./advice.js').Advice,
): 'context_mismatch' | undefined => {
  if (
    !context.kind.startsWith('advice_') ||
    advice.id !== `analysis:${context.id}` ||
    advice.provenance?.contextId !== context.id ||
    advice.provenance.jobId !== (context.jobId ?? undefined) ||
    advice.basedOn.dataAsOf.getTime() !== context.dataAsOf.getTime() ||
    advice.subjectId !== context.subject.id ||
    advice.subjectKind !==
      (context.subject.kind === 'stock'
        ? 'stock'
        : context.subject.kind === 'position'
          ? 'position'
          : 'market') ||
    advice.provenance.evidenceFactIds.some((id) => !context.factIds.includes(id))
  )
    return 'context_mismatch';
  return undefined;
};

/**
 * 引用一致性 checker（REQ-M3-02）。返回**逐条**不符项而不是布尔值：
 * 调用方要能指出哪一条引用不存在、哪一条缺口为空，而不是只说“报告不通过”。
 */
export const AnalysisReportReferenceIssueSchema = z
  .object({
    code: z.enum([
      'unknown-fact-id',
      'duplicate-fact-id',
      'unknown-missing-kind',
      'empty-missing-fact',
      'duplicate-missing-fact',
    ]),
    path: z.string().min(1),
    message: z.string().min(1).max(500),
  })
  .strict();
export type AnalysisReportReferenceIssue = z.infer<typeof AnalysisReportReferenceIssueSchema>;

export const checkAnalysisReportReferences = (input: {
  readonly context: Pick<AnalysisContext, 'factIds' | 'missingFacts'>;
  readonly evidenceFactIds: readonly string[];
  readonly missingFacts: readonly {
    readonly kind: string;
    readonly subjectId: string;
    readonly reason: string;
    readonly asOf: Date;
  }[];
}): readonly AnalysisReportReferenceIssue[] => {
  const issues: AnalysisReportReferenceIssue[] = [];
  const knownFacts = new Set(input.context.factIds);
  const seenFacts = new Set<string>();
  input.evidenceFactIds.forEach((factId, index) => {
    if (!knownFacts.has(factId)) {
      issues.push({
        code: 'unknown-fact-id',
        path: `evidenceFactIds[${index}]`,
        message: `引用了事实包里不存在的 factId: ${factId}`,
      });
      return;
    }
    if (seenFacts.has(factId)) {
      issues.push({
        code: 'duplicate-fact-id',
        path: `evidenceFactIds[${index}]`,
        message: `重复引用 factId: ${factId}`,
      });
    }
    seenFacts.add(factId);
  });
  const seenGaps = new Set<string>();
  input.missingFacts.forEach((fact, index) => {
    if (!(ANALYSIS_MISSING_FACT_KINDS as readonly string[]).includes(fact.kind)) {
      issues.push({
        code: 'unknown-missing-kind',
        path: `missingFacts[${index}].kind`,
        message: `缺口 kind 不在枚举内: ${fact.kind}`,
      });
      return;
    }
    if (fact.subjectId.trim().length === 0 || fact.reason.trim().length === 0) {
      issues.push({
        code: 'empty-missing-fact',
        path: `missingFacts[${index}]`,
        message: `缺口缺少 subjectId 或 reason: ${fact.kind}`,
      });
      return;
    }
    const key = `${fact.kind}\0${fact.subjectId}`;
    if (seenGaps.has(key)) {
      issues.push({
        code: 'duplicate-missing-fact',
        path: `missingFacts[${index}]`,
        message: `重复缺口: ${fact.kind} / ${fact.subjectId}`,
      });
    }
    seenGaps.add(key);
  });
  return issues;
};
