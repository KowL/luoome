import { z } from 'zod';
import { InvariantError } from '../error/index.js';
import { dateInShanghai, previousTradingDate } from '../trading-calendar.js';
import {
  type AnalysisKind,
  AnalysisKindSchema,
  AnalysisSubjectSchema,
  analysisSubjectKinds,
} from './analysis-job.js';

/**
 * 跨日引用禁令的原因码（REQ-M3-20）。市场级结论只有当日有效，昨日事实不能顶替今日市场状态：
 * 装配时被排除的跨日市场事实会留下这条 blocking 缺口，`get_analysis_context` 因此返回
 * `unavailable` 而不是静默降级成 partial。
 */
export const MARKET_ADVICE_SAME_DAY_ONLY = 'market-advice-same-day-only' as const;

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
  MARKET_ADVICE_SAME_DAY_ONLY,
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
  // 跨日市场事实被排除后不能给出当日市场结论，因此它是 blocking 而不是 degraded：
  // 降级成 partial 会让「昨日市场结构」继续当作今日依据（REQ-M3-20）。
  MARKET_ADVICE_SAME_DAY_ONLY,
]);

export const missingFactsAvailability = (
  facts: readonly AnalysisMissingFact[],
): 'complete' | 'partial' | 'unavailable' =>
  facts.some((fact) => BLOCKING_MISSING_FACT_KINDS.has(fact.kind))
    ? 'unavailable'
    : facts.length > 0
      ? 'partial'
      : 'complete';

/**
 * contextHash 口径版本。
 * - **1**：`{ facts, dataAsOf }`——历史口径，**不覆盖 missingFacts**，因此删掉一条 blocking 缺口
 *   时 hash 不变、门禁可被绕过（本需求要修的洞）。
 * - **2**：追加 `missingFacts`。缺口的增删会改变 hash，P8 的判断输入因此受 hash 保护。
 * 旧 context 读回时缺该字段 → 默认 1，继续按老口径校验，不悄悄改变历史 hash 的含义。
 */
export const ANALYSIS_CONTEXT_HASH_VERSION = 2;

/** 参与 contextHash 的载荷；版本决定是否纳入 missingFacts。 */
export const analysisContextHashPayload = (input: {
  readonly version: number;
  readonly facts: readonly unknown[];
  readonly dataAsOf: Date;
  readonly missingFacts?: readonly AnalysisMissingFact[];
}): Record<string, unknown> =>
  input.version >= 2
    ? {
        version: input.version,
        facts: input.facts,
        dataAsOf: input.dataAsOf,
        missingFacts: input.missingFacts ?? [],
      }
    : { facts: input.facts, dataAsOf: input.dataAsOf };

/**
 * 校验 contextHash 是否与当前事实+缺口一致。
 *
 * 为什么要"两版都试"：`contextHashVersion` 是新增字段，历史存档/未加列的存储读回来是 undefined，
 * 只看字段会把 v2 写入的 context 误判成 v1 而报 mismatch。这里改为**按口径重算比对**：
 * 先按 v2（含 missingFacts）算，不等再按 v1（不含）算。两者都不等才判失败。
 *
 * 这不削弱保护：v2 写入的 context 的 hash 里含 `version` 键，删掉一条 blocking 缺口后
 * v2 重算必变、v1 重算也不可能撞上——两条路径都失败，篡改仍被发现。
 */
export const analysisContextHashMatches = (input: {
  readonly contextHash: string;
  readonly facts: readonly unknown[];
  readonly dataAsOf: Date;
  readonly missingFacts: readonly AnalysisMissingFact[];
  readonly compute: (payload: Record<string, unknown>) => string;
}): boolean => {
  if (
    input.compute(
      analysisContextHashPayload({
        version: ANALYSIS_CONTEXT_HASH_VERSION,
        facts: input.facts,
        dataAsOf: input.dataAsOf,
        missingFacts: input.missingFacts,
      }),
    ) === input.contextHash
  )
    return true;
  return (
    input.compute(
      analysisContextHashPayload({ version: 1, facts: input.facts, dataAsOf: input.dataAsOf }),
    ) === input.contextHash
  );
};

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
    /**
     * hash 口径版本；**缺省即 1（老口径）**。用 optional 而不是 default，是为了不强制
     * 历史 fixture / 旧存档补字段；读取侧统一 `?? 1` 归一。
     */
    contextHashVersion: z.number().int().min(1).optional(),
    /**
     * 判定该 context 写回/有效期时所用的时效规则版本（REQ-M3-20 / R2）。
     * 缺省 = 该 context 早于版本位落地，按旧规则判定（读兼容：不 crash、不 resurrect）。
     */
    timingRuleVersion: z.string().min(1).optional(),
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
 * 盘中行动类的事实只有收盘前且足够新鲜时才有行动价值；研究/策略结论允许盘后与隔日写回，
 * 但研究/策略事实最长 30 天。15:00 截断只属于盘中行动类，套在其它 kind 上会让盘后研究恒过期。
 *
 * 市场级结论按 `sameDayOnly` 走自然日边界（REQ-M3-20）：A 股市场状态一天即变，
 * 「24h 写回 + 7 天数据龄」是伪精确——自然日不是固定时长，写死毫秒数会立刻腐烂。
 */
interface AnalysisTimingRuleBase {
  /** 口径版本位：同一 kind 的规则语义变更时必须换值，不许静默改语义。 */
  readonly ruleVersion: string;
  /** 从 context 装配时刻起允许写回的最长时长。 */
  readonly writeWindowMs: number;
  /** 盘中行动类以当日 15:00（Asia/Shanghai）为硬截断。 */
  readonly closesAtSessionEnd: boolean;
}

export type AnalysisTimingRule =
  | (AnalysisTimingRuleBase & {
      /** 可用窗口收窄为 Asia/Shanghai 自然日当日；跨日即不可用。 */
      readonly sameDayOnly: true;
    })
  | (AnalysisTimingRuleBase & {
      readonly sameDayOnly: false;
      /** `dataAsOf` 至今允许的最大年龄，超过即 stale。 */
      readonly dataMaxAgeMs: number;
    });

/** 市场级建议的时效口径版本位；口径变了就换值（REQ-M3-20 / R2）。 */
export const MARKET_ANALYSIS_TIMING_RULE_VERSION = 'market-analysis-same-day-v1';

const intradayActionRule: AnalysisTimingRule = {
  ruleVersion: 'intraday-action-v1',
  writeWindowMs: 30 * MINUTE_MS,
  dataMaxAgeMs: 30 * MINUTE_MS,
  closesAtSessionEnd: true,
  sameDayOnly: false,
};
const marketAnalysisRule: AnalysisTimingRule = {
  ruleVersion: MARKET_ANALYSIS_TIMING_RULE_VERSION,
  writeWindowMs: 24 * HOUR_MS,
  closesAtSessionEnd: false,
  sameDayOnly: true,
};
/**
 * 盘后策略候选建议：结论依据当日收盘后的已发布运行事实，天然晚于 15:00，
 * 因此不能套用盘中行动类的 30 分钟窗口与收盘截断；数据仍受 7 天有效期约束。
 * 它不随市场级当日口径收窄——策略候选的引用对象是运行结果，不是当日市场状态。
 */
const afterCloseStrategyRule: AnalysisTimingRule = {
  ruleVersion: 'after-close-strategy-v1',
  writeWindowMs: 24 * HOUR_MS,
  dataMaxAgeMs: 7 * DAY_MS,
  closesAtSessionEnd: false,
  sameDayOnly: false,
};
const researchAnalysisRule: AnalysisTimingRule = {
  ruleVersion: 'research-analysis-30d-v1',
  writeWindowMs: 24 * HOUR_MS,
  dataMaxAgeMs: 30 * DAY_MS,
  closesAtSessionEnd: false,
  sameDayOnly: false,
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
  /** 算出这份 timing 的规则版本，随 context 落库可追溯（REQ-M3-20 / R2）。 */
  readonly ruleVersion: string;
}

const shanghaiSessionClose = (now: Date): Date => new Date(`${dateInShanghai(now)}T15:00:00+08:00`);

/**
 * `at` 之后那个 Asia/Shanghai 自然日的 00:00。
 * 用日历而不是「+24h」表达当日：自然日不是固定时长（跨月、跨年都一样按日期走）。
 */
const nextShanghaiDayStart = (at: Date): Date =>
  new Date(`${dateInShanghai(new Date(at.getTime() + DAY_MS))}T00:00:00+08:00`);

const dataStaleAfter = (rule: AnalysisTimingRule, dataAsOf: Date): Date =>
  rule.sameDayOnly
    ? nextShanghaiDayStart(dataAsOf)
    : new Date(dataAsOf.getTime() + rule.dataMaxAgeMs);

/** 按 kind 计算写回截止与数据有效期；盘后分析不再被 15:00 截断，市场级当日即止。 */
export const analysisContextTiming = (
  kind: AnalysisKind,
  dataAsOf: Date,
  now: Date,
): AnalysisContextTiming => {
  const rule = analysisTimingRules[kind];
  const staleAfter = dataStaleAfter(rule, dataAsOf);
  const windowEnd = new Date(now.getTime() + rule.writeWindowMs);
  const cap = rule.closesAtSessionEnd ? shanghaiSessionClose(now) : staleAfter;
  return {
    writeUntil: new Date(Math.min(windowEnd.getTime(), cap.getTime())),
    staleAfter,
    ruleVersion: rule.ruleVersion,
  };
};

export const isAnalysisContextStale = (kind: AnalysisKind, dataAsOf: Date, now: Date): boolean =>
  now.getTime() > dataStaleAfter(analysisTimingRules[kind], dataAsOf).getTime();

/**
 * 市场级观察的时效分类（REQ-M3-20 / R4，纯函数）。
 *
 * 渲染层与事实包装都调它，不在各 surface 各写一遍判断（AGENTS.md：不变量放 core）。
 * `reference` 是判定所依据的时点：实时路径下即 now，补跑历史报告时应传报告期，
 * 否则 N 个交易日前的数据会被按「今天」判定（见 `marketObservationScope`）。
 * - 非同一上海日（含未来时点）→ `historical`：不能代表参照日的市场状态
 * - 同一上海日但落在 15:00 收盘之后 → `historical`：收盘后的观察不是「当前依据」
 * - 其余 → `current`
 *
 * `historical` 是**降级标注**，不是删除：观察本身仍然可读，只是不得作为当前依据进入建议链。
 */
export const classifyMarketObservation = (
  observedAt: Date,
  reference: Date,
): 'current' | 'historical' =>
  dateInShanghai(observedAt) !== dateInShanghai(reference) ||
  observedAt.getTime() > shanghaiSessionClose(reference).getTime()
    ? 'historical'
    : 'current';

/** 历史观察的固定标注词；渲染层与事实包装共用，避免各写一遍。 */
export const MARKET_OBSERVATION_HISTORICAL_LABEL = '历史观察';

/** 上一交易日观察的固定标注词：盘前简报的常态数据，不是降级。 */
export const MARKET_OBSERVATION_PRIOR_SESSION_LABEL = '上一交易日收盘观察';

/** 市场级观察相对参照日的三档口径（REQ-M3-20 / R4）。 */
export type MarketObservationScope = 'current' | 'prior-session' | 'historical';

/**
 * 市场级观察的三档口径：参照「报告期」而不是固定用 now。
 *
 * 两种被标成 `historical` 的情形处置不同，措辞必须精确到能对上事实：
 * - `current`：同一上海日且未过当日 15:00 收盘 → 当前依据，不加标注
 * - `prior-session`：观测日的上海日期恰是参照日的**前一交易日** → 盘前/盘后复用的上一交易日收盘，
 *   这是盘前本来就该有的数据，不是降级
 * - `historical`：更早或未来时点 → 降级，必须显眼
 *
 * 参照日取报告期而不是 now：补跑历史报告时若拿 now 当参照，N 个交易日前的数据会被说成
 * 「上一交易日收盘观察」，措辞与事实不符。实时路径下两者同日，行为不变。
 * 「前一交易日」复用 `previousTradingDate`（trading-calendar 的唯一日历实现），
 * 这里不写第二份周末/节假日判断。
 */
export const marketObservationScope = (
  observedAt: Date,
  reference: Date,
): MarketObservationScope =>
  classifyMarketObservation(observedAt, reference) === 'current'
    ? 'current'
    : dateInShanghai(observedAt) === previousTradingDate(reference)
      ? 'prior-session'
      : 'historical';

/**
 * 市场级判断的观测时间标注：降级显式标注，而不是被丢弃。
 * 三种口径各一句话——当前依据 / 盘前沿用的上一交易日收盘 / 被降级的历史观察。
 */
export const marketObservationLabel = (observedAt: Date, reference: Date): string => {
  const stamp = `观测于 ${observedAt.toISOString()}`;
  switch (marketObservationScope(observedAt, reference)) {
    case 'current':
      return stamp;
    case 'prior-session':
      return `${MARKET_OBSERVATION_PRIOR_SESSION_LABEL}（${stamp}）`;
    case 'historical':
      return `${MARKET_OBSERVATION_HISTORICAL_LABEL}（${stamp}）`;
  }
};

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
      'omitted-blocking-missing-fact',
      /** REQ-M3-16：`extfact:*` 出现在了证据链里，但表里查不到这条事实。 */
      'persisted-fact-missing',
    ]),
    path: z.string().min(1),
    message: z.string().min(1).max(500),
  })
  .strict();
export type AnalysisReportReferenceIssue = z.infer<typeof AnalysisReportReferenceIssueSchema>;

/**
 * L2 强制点（REQ-M3-16）：外部事实必须**在表里查得到**。
 *
 * L1（`checkAnalysisReportReferences`）只证明「这条 id 在这条 context 的事实包里」，
 * 证明不了「那条事实还在库里」——而 context 的 facts 是抓取快照，事实可能从未落库
 * （模型直接编一个 `extfact:` payload）。所以这里再查一次表。
 *
 * **本项的强制点 = 表查询，不是签名**：模型伪造的 `extfact:*` 只要表里没有就会被拒；
 * 但工具层无法证明 payload 真的来自 `fetch_*`（那需要 `fetchToken` 硬签，登记 backlog）。
 *
 * 只校 `extfact:` 前缀，避免误伤既有非外部 fact id（`quote:` / `trade:` …）。
 */
export const externalFactIdsOf = (factIds: readonly string[]): readonly string[] =>
  factIds.filter((id) => id.startsWith('extfact:'));

export const checkExternalFactPersistence = (input: {
  readonly evidenceFactIds: readonly string[];
  readonly persistedFactIds: ReadonlySet<string>;
}): readonly AnalysisReportReferenceIssue[] =>
  externalFactIdsOf(input.evidenceFactIds)
    .filter((id) => !input.persistedFactIds.has(id))
    .map((id, index) => ({
      code: 'persisted-fact-missing' as const,
      path: `evidenceFactIds[${index}]`,
      message: `引用了未落库的外部事实: ${id}；先落库（persist_external_facts）再引用`,
    }));

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

/**
 * 完整性方向（T28）：context 里有 blocking 缺口，报告必须**逐条声明**。
 *
 * 与 `checkAnalysisReportReferences` 分开成两个函数，是为了保持既有错误优先级不变
 * （引用错误 → 时序错误 → 完整性错误）：直接塞进前者会让"上下文已过期"被
 * "缺口没声明"抢答，改变用户看到的第一个错误。
 *
 * 为什么必须有这条：blocking 缺口是 P8 的**判断输入**（unavailable 必须阻断）。
 * 只查"引用的对不对"不查"该提的提了没"，就等于允许报告删掉一条 blocking 缺口绕过门禁。
 */
export const checkAnalysisReportCompleteness = (input: {
  readonly context: Pick<AnalysisContext, 'missingFacts'>;
  readonly missingFacts: readonly {
    readonly kind: string;
    readonly subjectId: string;
  }[];
}): readonly AnalysisReportReferenceIssue[] => {
  const declared = new Set(input.missingFacts.map((fact) => `${fact.kind}\0${fact.subjectId}`));
  const issues: AnalysisReportReferenceIssue[] = [];
  input.context.missingFacts.forEach((fact, index) => {
    if (!BLOCKING_MISSING_FACT_KINDS.has(fact.kind)) return;
    if (declared.has(`${fact.kind}\0${fact.subjectId}`)) return;
    issues.push({
      code: 'omitted-blocking-missing-fact',
      path: `missingFacts[${index}]`,
      message: `报告未声明 blocking 缺口: ${fact.kind} / ${fact.subjectId}`,
    });
  });
  return issues;
};
