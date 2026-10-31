import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import { DataProvenanceSchema } from './provenance.js';
import { DeliveryStatusSchema } from './watch-trigger.js';

export const ReportKindSchema = z.enum([
  'opening',
  'closing',
  'weekly',
  'watchlist-facts',
  // M3-08 五类里原本没有 Report 生产者的三类（REQ-M3-08）：盘前简报、日复盘、风险。
  // 加值是向后兼容的（旧行仍可解析），且都按单日报告处理（periodStart === periodEnd）。
  'morning-brief',
  'daily-review',
  'risk',
]);
export type ReportKind = z.infer<typeof ReportKindSchema>;

export const ReportStatusSchema = z.enum(['complete', 'partial']);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

export const ReportSectionStatusSchema = z.enum(['complete', 'partial', 'unavailable']);
export type ReportSectionStatus = z.infer<typeof ReportSectionStatusSchema>;

export const ReportValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ReportValue = z.infer<typeof ReportValueSchema>;

export const AccountReportScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all-accounts') }),
  z.object({ kind: z.literal('account'), accountId: z.string().min(1) }),
]);
export type AccountReportScope = z.infer<typeof AccountReportScopeSchema>;
export const ReportScopeSchema = z.discriminatedUnion('kind', [
  ...AccountReportScopeSchema.options,
  z.object({ kind: z.literal('watchlist'), watchlistId: z.string().min(1) }),
]);
export type ReportScope = z.infer<typeof ReportScopeSchema>;

export const reportScopeKey = (scope: ReportScope): string => {
  if (scope.kind === 'all-accounts') return 'all-accounts';
  return scope.kind === 'account' ? `account:${scope.accountId}` : `watchlist:${scope.watchlistId}`;
};

const MetricBlockSchema = z.object({
  kind: z.literal('metrics'),
  items: z.array(
    z.object({
      key: z.string().min(1),
      label: z.string().min(1),
      value: ReportValueSchema,
      unit: z.string().optional(),
      displayValue: z.string().optional(),
    }),
  ),
});

const TableBlockSchema = z.object({
  kind: z.literal('table'),
  columns: z
    .array(
      z.object({
        key: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .min(1),
  rows: z.array(z.record(z.string(), ReportValueSchema)),
});

/**
 * 自由文本的来源。只有 `advice` 来源的文本会在渲染时按词面策略规范化；
 * 报告自撰文本不带此标记——它命中行动词就是 bug，必须拒绝而不是被兜底改掉。
 */
export const ReportTextOriginSchema = z.enum(['advice']);
export type ReportTextOrigin = z.infer<typeof ReportTextOriginSchema>;

const ListBlockSchema = z.object({
  kind: z.literal('list'),
  items: z.array(
    z
      .object({
        title: z.string().min(1),
        detail: z.string().optional(),
        notificationSummary: z.string().max(1500).optional(),
        entityKind: z
          .enum([
            'stock',
            'strategy',
            'watchlist',
            'alert-plan',
            // deprecated：仅为读取存量报告保留，新报告不再产生这两种 kind
            'stock-group',
            'watch-plan',
            'watch-trigger',
            'stock-event',
            'research-note',
            'advice',
            'trading-plan',
          ])
          .optional(),
        entityId: z.string().optional(),
        /** `detail` / `notificationSummary` 的来源；渲染时按来源决定是否规范化。 */
        textOrigin: ReportTextOriginSchema.optional(),
      })
      .refine((item) => (item.entityKind === undefined) === (item.entityId === undefined), {
        message: 'entityKind and entityId must appear together',
      }),
  ),
});

const TextBlockSchema = z.object({
  kind: z.literal('text'),
  text: z.string().min(1),
  tone: z.enum(['factual', 'warning']).default('factual'),
  /** 正文来源；`advice` 来源在渲染时规范化，自撰文本不得使用该标记。 */
  textOrigin: ReportTextOriginSchema.optional(),
});

export const ReportBlockSchema = z.discriminatedUnion('kind', [
  MetricBlockSchema,
  TableBlockSchema,
  ListBlockSchema,
  TextBlockSchema,
]);
export type ReportBlock = z.infer<typeof ReportBlockSchema>;

export const ReportEvidenceSchema = z.object({
  id: z.string().min(1),
  dimension: z.string().min(1),
  provenance: DataProvenanceSchema,
});
export type ReportEvidence = z.infer<typeof ReportEvidenceSchema>;

export const ReportMissingDimensionSchema = z.object({
  dimension: z.string().min(1),
  reason: z.string().min(1).max(500),
  errorKind: z.string().optional(),
  retryable: z.boolean(),
});
export type ReportMissingDimension = z.infer<typeof ReportMissingDimensionSchema>;

/**
 * 盘前简报的四段（REQ-M3-17），**顺序固定**。
 *
 * 与报告级六槽是并列关系而不是嵌套：六槽是「整份报告对外声明」（全部 kind 都有），
 * 四段是「盘前简报的内部结构」（只有 `morning-brief` 强制）。
 */
export const MORNING_BRIEF_SECTION_KEYS = [
  'account-overview',
  'overnight-facts',
  'existing-advice',
  'watch-conditions',
] as const;
export type MorningBriefSectionKey = (typeof MORNING_BRIEF_SECTION_KEYS)[number];

export const ReportSectionSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  required: z.boolean(),
  status: ReportSectionStatusSchema,
  dataAsOf: z.coerce.date().optional(),
  inputFingerprint: z.string().length(64).optional(),
  blocks: z.array(ReportBlockSchema),
  evidenceIds: z.array(z.string()).default([]),
  missingDimensions: z.array(ReportMissingDimensionSchema).default([]),
});
export type ReportSection = z.infer<typeof ReportSectionSchema>;

export const DecisionReviewReportSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  accountId: z.string().min(1),
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  throughSequence: z.number().int().nonnegative(),
  revisionIds: z.array(
    z.object({ reviewId: z.string().min(1), revision: z.number().int().positive() }),
  ),
  tradeFactHashes: z.record(z.string(), z.string()),
  inputFingerprint: z.string().length(64),
});
export type DecisionReviewReportSnapshot = z.infer<typeof DecisionReviewReportSnapshotSchema>;

export const WatchlistFactsSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  watchlistRevision: z.string().regex(/^[a-f0-9]{64}$/),
  ruleFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  // 历史托管期写入的渲染版本号；保留以解析旧报告行。
  rendererVersion: z.literal('facts-v1'),
  frozenInput: z.record(z.string(), z.unknown()),
});
export type WatchlistFactsSnapshot = z.infer<typeof WatchlistFactsSnapshotSchema>;

export const ReportSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().optional(),
  supersedesReportId: z.string().min(1).optional(),
  kind: ReportKindSchema,
  scope: ReportScopeSchema,
  periodStart: z.string().date(),
  periodEnd: z.string().date(),
  title: z.string().min(1).max(200),
  generatedAt: z.coerce.date(),
  dataAsOf: z.coerce.date(),
  status: ReportStatusSchema,
  sections: z.array(ReportSectionSchema).min(1),
  evidence: z.array(ReportEvidenceSchema),
  missingDimensions: z.array(ReportMissingDimensionSchema).default([]),
  deliveryStatus: DeliveryStatusSchema.default('not-requested'),
  notificationPolicy: z.enum(['eligible', 'never']).optional(),
  decisionReviewSnapshot: DecisionReviewReportSnapshotSchema.optional(),
  watchlistFactsSnapshot: WatchlistFactsSnapshotSchema.optional(),
  workflowRunId: z.string().min(1),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Report = z.infer<typeof ReportSchema>;

export const reportDisplayTitle = (report: Pick<Report, 'kind' | 'title'>): string =>
  report.kind === 'closing' ? report.title.replace(/（(?:复盘)?补充 v\d+）/g, '') : report.title;

const weekStart = (date: string): string => {
  const value = new Date(`${date}T00:00:00.000Z`);
  const daysSinceMonday = (value.getUTCDay() + 6) % 7;
  value.setUTCDate(value.getUTCDate() - daysSinceMonday);
  return value.toISOString().slice(0, 10);
};

const ADVICE_DECISION_FIELDS = new Set([
  'decision',
  'positionSize',
  'stopLoss',
  'takeProfit',
  'confidence',
]);

const findAdviceDecisionField = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findAdviceDecisionField(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (value === null || typeof value !== 'object') return null;
  for (const [key, nested] of Object.entries(value)) {
    if (ADVICE_DECISION_FIELDS.has(key)) return key;
    const found = findAdviceDecisionField(nested);
    if (found !== null) return found;
  }
  return null;
};

/**
 * 报告正文的行动词禁令（REQ-M3-08）。
 *
 * 报告是研究材料，不是下单指令；`买入/卖出/已建仓/下单` 出现在正文里会被读成动作。
 * 键名守卫（`ADVICE_DECISION_FIELDS`）只查对象键，`{kind:'text', text:'建议买入'}` 能整体通过——
 * 所以判定必须分两层，且只写一份：写回路径（`assertReportInvariants`）与每条渲染出口共用本函数。
 *
 * **交付物的自由文本规则（本文件的核心不变量）**：任何进入交付物的自由文本，都必须过同一套
 * 词面策略——不管是产品文案、模型推理（`advice.reasoning.*`），还是将来的外部事实摘要
 * （news / research 结论）。来源分两类，处置不同、不许混同：
 * - **自撰文本**（无 `textOrigin`）：命中即拒绝——那是我们自己的 bug，改文案，不许被规范化兜底；
 * - **外部来源文本**（`textOrigin: 'advice'` 等）：渲染时按 `DELIVERABLE_TEXT_NORMALIZATIONS`
 *   规范化成人读立场词，原文留在结构化投影（canonical JSON 块）里，信息不丢。
 * 新增任何外部自由文本来源时，先给它一个 `textOrigin`，再确认它进了本函数的扫描范围。
 */
/**
 * 成交事实字段白名单（REQ-M3-08 的**收窄**，逐键豁免，不是整块豁免）。
 *
 * 报告里有一类文本**必须**写「买入/卖出」：已发生成交的方向。那是账本事实的转述，
 * 不是给读者的动作；把它一并禁掉等于让成交明细表永久违规。
 * 因此只豁免**这些字段键**的值，同一块里的其它字段（列名、label、其它列）照常检查。
 *
 * 加键的规矩：每条必须有非空理由，且理由要说清「为什么这是事实而不是指令」。
 * 不许写通配、不许按文本嗅探、不许因为「这段是成交表」整块跳过。
 */
export const REPORT_FACTUAL_FIELD_KEYS: Readonly<Record<string, string>> = {
  // 成交方向：`Trade.side` 已落库（买入/卖出），报告照实转述；读它不会产生任何动作。
  side: '已发生成交的方向（Trade.side 的事实转述），不是对读者的动作指令',
};

/**
 * 白名单自检：每条必须带非空理由，键必须是具体字段名（不许通配、不许空键）。
 * 加键的人必须解释「为什么这是事实而不是指令」。
 */
export const assertFactualFieldReasons = (
  keys: Readonly<Record<string, string>> = REPORT_FACTUAL_FIELD_KEYS,
): void => {
  for (const [key, reason] of Object.entries(keys)) {
    if (key.trim().length === 0 || key.includes('*'))
      throw new InvariantError(`报告事实字段白名单出现非法键：${key}`);
    if (reason.trim().length === 0)
      throw new InvariantError(`报告事实字段「${key}」缺少理由：豁免必须被解释`);
  }
};

/** 该字段键是否被豁免（逐键判断；没有通配分支）。 */
export const isReportFactualField = (key: string): boolean =>
  Object.hasOwn(REPORT_FACTUAL_FIELD_KEYS, key);

/** 含成交事实字段时，报告正文必须附的说明句（由内容派生，不常驻）。 */
export const REPORT_FACTUAL_TABLE_NOTE = '以下为已发生成交的记录，不是建议。';

/** 该 block 是否含被豁免的成交事实字段——渲染层据此决定要不要加说明句。 */
export const blockHasFactualFields = (block: ReportBlock): boolean =>
  block.kind === 'table'
    ? block.columns.some((column) => isReportFactualField(column.key))
    : block.kind === 'metrics'
      ? block.items.some((item) => isReportFactualField(item.key))
      : false;

export const FORBIDDEN_ACTION_WORDS = ['买入', '卖出', '已建仓', '下单'] as const;

/**
 * 交付物词面策略的**固定映射表**（不做模糊匹配、不做上下文推断）。
 *
 * 方法论（比修好某一处更重要）：**任何进入交付物的自由文本，都必须过同一套词面策略**——
 * 不管是产品文案、模型推理，还是将来的外部事实摘要（news / research 结论）。
 * 今天的触发点是 `advice.reasoning.premise`，明天可能是新闻摘要。
 */
export const DELIVERABLE_TEXT_NORMALIZATIONS = [
  ['买入', '看多'],
  ['卖出', '看空'],
  ['已建仓', '已持有'],
  ['下单', '委托'],
] as const;

/** 把行动词换成立场词：用于**外部来源**的自由文本在人读正文里的呈现。 */
export const normalizeDeliverableText = (text: string): string =>
  DELIVERABLE_TEXT_NORMALIZATIONS.reduce(
    (current, [from, to]) => current.replaceAll(from, to),
    text,
  );

/**
 * 人读正文的取词口径：`advice` 来源规范化，自撰文本原样（自撰命中会先被守卫拒绝）。
 * 所有渲染出口都调它，避免某一层「记得改」而另一层忘掉。
 */
export const reportDisplayText = (text: string, origin?: ReportTextOrigin): string =>
  origin === 'advice' ? normalizeDeliverableText(text) : text;
export type ForbiddenActionWord = (typeof FORBIDDEN_ACTION_WORDS)[number];

/** 命中位置（字段路径）、命中的词、以及原文片段——报错要让用户能直接改。 */
export interface ReportActionTextViolation {
  readonly where: string;
  readonly word: ForbiddenActionWord;
  readonly snippet: string;
}

const SNIPPET_PADDING = 12;

const snippetAround = (text: string, at: number, length: number): string => {
  const start = Math.max(0, at - SNIPPET_PADDING);
  const end = Math.min(text.length, at + length + SNIPPET_PADDING);
  return `${start === 0 ? '' : '…'}${text.slice(start, end)}${end === text.length ? '' : '…'}`;
};

/**
 * 文本层：扫每个 `text` 块的正文。`where` 是字段路径前缀，用于把违规点定位到段与块。
 *
 * 一个块只报第一处命中——报告正文的错误按块改，堆一串同词命中只会淹没重点。
 */
export const findReportActionTextViolations = (
  blocks: readonly ReportBlock[],
  where: string,
): readonly ReportActionTextViolation[] => {
  const violations: ReportActionTextViolation[] = [];
  const check = (text: string, field: string): void => {
    for (const word of FORBIDDEN_ACTION_WORDS) {
      const at = text.indexOf(word);
      if (at < 0) continue;
      violations.push({ where: field, word, snippet: snippetAround(text, at, word.length) });
      return;
    }
  };
  blocks.forEach((block, index) => {
    if (block.kind === 'text') {
      // advice 来源的自由文本在渲染时规范化，原文留在结构化投影里；自撰文本没有这个豁免。
      if (block.textOrigin !== 'advice') check(block.text, `${where}[${index}].text`);
      return;
    }
    // 表格：列名永远是报告自撰文本（必查）；单元格只在**列 key 命中白名单**时豁免。
    if (block.kind === 'table') {
      block.columns.forEach((column, columnIndex) => {
        check(column.label, `${where}[${index}].columns[${columnIndex}].label`);
        if (isReportFactualField(column.key)) return;
        block.rows.forEach((row, rowIndex) => {
          const cell = row[column.key];
          if (typeof cell === 'string') {
            check(cell, `${where}[${index}].rows[${rowIndex}].${column.key}`);
          }
        });
      });
      return;
    }
    // 指标：label 是自撰措辞（必查）；值只在 key 命中白名单时豁免。
    if (block.kind === 'metrics') {
      block.items.forEach((item, itemIndex) => {
        check(item.label, `${where}[${index}].items[${itemIndex}].label`);
        if (isReportFactualField(item.key)) return;
        if (item.displayValue !== undefined) {
          check(item.displayValue, `${where}[${index}].items[${itemIndex}].displayValue`);
        }
        if (typeof item.value === 'string') {
          check(item.value, `${where}[${index}].items[${itemIndex}].value`);
        }
      });
      return;
    }
    // 列表项的 title/detail/notificationSummary 都是报告正文的一部分：
    // 立场描述写在 detail 里同样会被读成动作。
    if (block.kind !== 'list') return;
    block.items.forEach((item, itemIndex) => {
      check(item.title, `${where}[${index}].items[${itemIndex}].title`);
      if (item.textOrigin === 'advice') return;
      if (item.detail !== undefined) {
        check(item.detail, `${where}[${index}].items[${itemIndex}].detail`);
      }
      if (item.notificationSummary !== undefined) {
        check(
          item.notificationSummary,
          `${where}[${index}].items[${itemIndex}].notificationSummary`,
        );
      }
    });
  });
  return violations;
};

/**
 * 报告 block 的共享守卫（两层：键名 + 文本）。写回路径与所有渲染出口都调它。
 * 报错点名违规字段与原文片段，而不是只说「含禁用词」。
 */
export const assertReportBlocksPolicy = (blocks: readonly ReportBlock[], where: string): void => {
  const decisionField = findAdviceDecisionField(blocks);
  if (decisionField !== null) {
    throw new InvariantError(`report block contains Advice decision field: ${decisionField}`);
  }
  const [violation] = findReportActionTextViolations(blocks, where);
  if (violation === undefined) return;
  throw new InvariantError(
    `${violation.where} 含行动词「${violation.word}」：${violation.snippet}`,
  );
};

/**
 * 写盘前复检：**人读正文**不得含行动词。
 *
 * 入参必须是 `reportDocumentHumanBody(content)` 的结果——直接对整份文件跑正则会把
 * canonical JSON 块里保留的原文误判成违规，让含 advice 的报告恒红。
 */
export const assertDeliverableBodyPolicy = (body: string, where: string): void => {
  for (const word of FORBIDDEN_ACTION_WORDS) {
    const at = body.indexOf(word);
    if (at < 0) continue;
    throw new InvariantError(
      `${where} 含行动词「${word}」：${snippetAround(body, at, word.length)}`,
    );
  }
};

/** 整份报告（全部段）过一遍共享守卫；渲染出口只需要这一句。 */
export const assertReportTextPolicy = (report: Pick<Report, 'sections'>): void => {
  for (const section of report.sections) {
    assertReportBlocksPolicy(section.blocks, `sections[${section.key}].blocks`);
  }
};

/**
 * 报告面向的立场标签（REQ-M3-08）。
 *
 * 报告正文不写「买入/卖出」这类动作词，只写立场；同一个 `decision` 在面板/工具提示里仍用
 * `adviceDecisionLabel`（买入/卖出）——两套词面向两种读者，信息不丢、词面合规。
 */
export const REPORT_STANCE_LABELS: Readonly<Record<string, string>> = {
  buy: '看多',
  sell: '看空',
  hold: '观望',
  watch: '观察',
  avoid: '回避',
};

export const reportStanceLabel = (decision: string): string =>
  REPORT_STANCE_LABELS[decision] ?? decision;

export const assertReportInvariants = (report: Report): void => {
  if ((report.kind === 'watchlist-facts') !== (report.scope.kind === 'watchlist'))
    throw new InvariantError('watchlist facts kind and scope must appear together');
  if ((report.kind === 'watchlist-facts') !== (report.watchlistFactsSnapshot !== undefined))
    throw new InvariantError('watchlist facts requires a frozen input snapshot');
  if (
    report.kind === 'watchlist-facts' &&
    (report.version ?? 1) > 1 &&
    report.notificationPolicy !== 'never'
  )
    throw new InvariantError('updated watchlist facts report must never notify');
  if (
    report.decisionReviewSnapshot !== undefined &&
    (report.scope.kind !== 'account' ||
      report.scope.accountId !== report.decisionReviewSnapshot.accountId ||
      report.periodStart !== report.decisionReviewSnapshot.periodStart ||
      report.periodEnd !== report.decisionReviewSnapshot.periodEnd)
  )
    throw new InvariantError('decision review snapshot scope/window mismatch');
  if (report.notificationPolicy === 'never' && report.deliveryStatus !== 'not-requested') {
    throw new InvariantError('never report cannot enter delivery');
  }
  if ((report.version ?? 1) > 1 && report.supersedesReportId === undefined) {
    throw new InvariantError('report supplement must reference previous report');
  }
  if ((report.version ?? 1) === 1 && report.supersedesReportId !== undefined) {
    throw new InvariantError('report first version cannot supersede another report');
  }
  if (report.supersedesReportId === report.id) {
    throw new InvariantError('report cannot supersede itself');
  }
  if (report.periodStart > report.periodEnd) {
    throw new InvariantError('report periodStart > periodEnd');
  }
  if (report.dataAsOf.getTime() > report.generatedAt.getTime()) {
    throw new InvariantError('report dataAsOf > generatedAt');
  }
  if (report.updatedAt.getTime() < report.createdAt.getTime()) {
    throw new InvariantError('report updatedAt < createdAt');
  }
  if (report.kind !== 'weekly' && report.periodStart !== report.periodEnd) {
    throw new InvariantError(`${report.kind} report period must be one trading day`);
  }
  if (report.kind === 'weekly' && weekStart(report.periodStart) !== weekStart(report.periodEnd)) {
    throw new InvariantError('weekly report period must stay within one Shanghai natural week');
  }
  const sectionKeys = new Set(report.sections.map((section) => section.key));
  if (sectionKeys.size !== report.sections.length) {
    throw new InvariantError('report section key must be unique');
  }
  const evidenceIds = new Set(report.evidence.map((evidence) => evidence.id));
  if (evidenceIds.size !== report.evidence.length) {
    throw new InvariantError('report evidence id must be unique');
  }
  for (const section of report.sections) {
    for (const evidenceId of section.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new InvariantError(`report evidence reference not found: ${evidenceId}`);
      }
    }
    if (section.status === 'complete' && section.missingDimensions.length > 0) {
      throw new InvariantError(`complete report section has missing dimensions: ${section.key}`);
    }
    if (
      section.status === 'unavailable' &&
      section.blocks.some((block) => block.kind !== 'text' || block.tone !== 'warning')
    ) {
      throw new InvariantError(
        `unavailable report section may only contain warning text: ${section.key}`,
      );
    }
  }
  const allRequiredComplete = report.sections
    .filter((section) => section.required)
    .every((section) => section.status === 'complete');
  if (allRequiredComplete !== (report.status === 'complete')) {
    throw new InvariantError('report status does not match required section status');
  }
  if (
    report.status === 'partial' &&
    report.missingDimensions.length === 0 &&
    report.sections.every((section) => section.missingDimensions.length === 0)
  ) {
    throw new InvariantError('partial report requires at least one missing dimension');
  }
  if (report.kind === 'morning-brief') {
    const keys = report.sections.map((section) => section.key);
    const outOfOrder = MORNING_BRIEF_SECTION_KEYS.some((key, index) => keys[index] !== key);
    if (outOfOrder || keys.length < MORNING_BRIEF_SECTION_KEYS.length) {
      throw new InvariantError(
        `morning-brief 四段缺失或顺序不符：期望 ${MORNING_BRIEF_SECTION_KEYS.join(' → ')}，实际 ${keys.join(' → ')}`,
      );
    }
  }
  // 键名层 + 文本层共用同一份判定：写回路径与渲染出口不能各守一套（REQ-M3-08）。
  assertReportTextPolicy(report);
};

export const assertReportDeliveryTransition = (
  from: Report['deliveryStatus'],
  to: Report['deliveryStatus'],
): void => {
  if (from === 'sent' && to === 'pending') {
    throw new InvariantError('sent report deliveryStatus cannot return to pending');
  }
};
