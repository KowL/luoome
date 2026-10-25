import { z } from 'zod';
import { InvariantError } from '../error/index.js';
import { dateInShanghai } from '../trading-calendar.js';
import {
  type AnalysisKind,
  AnalysisKindSchema,
  AnalysisSubjectSchema,
  analysisSubjectKinds,
} from './analysis-job.js';

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
