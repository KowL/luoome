import { createHash } from 'node:crypto';
import { z } from 'zod';

import { InvariantError } from '../error/index.js';
import {
  assertReportBlocksPolicy,
  MORNING_BRIEF_SECTION_KEYS,
  type MorningBriefSectionKey,
  type Report,
  type ReportBlock,
  ReportBlockSchema,
  ReportEvidenceSchema,
  ReportKindSchema,
  ReportMissingDimensionSchema,
  ReportScopeSchema,
  ReportSectionStatusSchema,
  type ReportValue,
  reportDisplayText,
} from './report.js';

/**
 * 可交付的报告文档（REQ-M3-08 / M3-17）。
 *
 * 这一层**不替换** `Report`：`Report` 是库里的结构化事实（有序 block 数组），
 * `ReportDocument` 是「要写进文件、给人和机器同时读」的投影——
 * 报告级六槽 envelope（对外声明）+ 盘前简报四段 sections（内部结构）+ 可回环解析的 JSON 块。
 * 两者并列：`Report` 有 section/evidence/缺口，`ReportDocument` 多一层「声明」与「顺序约束」。
 */
export const REPORT_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const REPORT_DOCUMENT_RENDERER_VERSION = 'report-document-v1' as const;

/** JSON 块的定位标记；解析靠它，不靠「第一个代码块」。 */
export const REPORT_DOCUMENT_MARKER = '<!-- luoome-report-document:v1 -->';

export const ReportValidityBasisSchema = z.enum(['advice-expiry', 'report-period', 'explicit']);
export type ReportValidityBasis = z.infer<typeof ReportValidityBasisSchema>;

/**
 * 报告级六槽。**六不是五**：M3-08 的五段是 dataAsOf/反证/免责/有效期/结论，
 * M3-09 的五段第 5 项是「风险」——只给五槽会让 P0 的 M3-09 无法验收。
 * 「可解析出五段」是下界：六槽全部必填，缺任一槽即解析失败。
 */
export const ReportEnvelopeSchema = z
  .object({
    dataAsOf: z.coerce.date(),
    conclusion: z.string().min(1),
    counterEvidence: z.array(z.string().min(1)).min(1),
    risks: z.array(z.string().min(1)).min(1),
    validity: z
      .object({
        validUntil: z.coerce.date(),
        basis: ReportValidityBasisSchema,
      })
      .strict(),
    disclaimer: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type ReportEnvelope = z.infer<typeof ReportEnvelopeSchema>;

/**
 * 文档内的一段。`dataAsOf` 必填（不是 optional）：文档里的每个数字都要能说清观测时点，
 * 与 `ReportSection.dataAsOf` 的可选语义刻意不同——文档是交付物，缺时点即缺陷。
 */
export const ReportDocumentSectionSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    /** 盘前简报四段的槽位；非 `morning-brief` 文档不得出现。 */
    slot: z.enum(MORNING_BRIEF_SECTION_KEYS).optional(),
    status: ReportSectionStatusSchema,
    dataAsOf: z.coerce.date(),
    blocks: z.array(ReportBlockSchema),
    evidenceIds: z.array(z.string()),
    missingDimensions: z.array(ReportMissingDimensionSchema),
  })
  .strict();
export type ReportDocumentSection = z.infer<typeof ReportDocumentSectionSchema>;

export const ReportDocumentSchema = z
  .object({
    schemaVersion: z.literal(REPORT_DOCUMENT_SCHEMA_VERSION),
    rendererVersion: z.literal(REPORT_DOCUMENT_RENDERER_VERSION),
    kind: ReportKindSchema,
    reportId: z.string().min(1),
    title: z.string().min(1).max(200),
    scope: ReportScopeSchema,
    periodStart: z.string().date(),
    periodEnd: z.string().date(),
    generatedAt: z.coerce.date(),
    envelope: ReportEnvelopeSchema,
    sections: z.array(ReportDocumentSectionSchema).min(1),
    evidence: z.array(ReportEvidenceSchema),
    gaps: z.array(ReportMissingDimensionSchema),
  })
  .strict();
export type ReportDocument = z.infer<typeof ReportDocumentSchema>;

/** 结构化投影的稳定性：键序无关、Date 归一为 ISO，两端（渲染/解析）必须得到同一个值。 */
const canonicalJson = (value: unknown): string => {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
};

/** 文档指纹：对 canonical JSON 取 sha256；渲染端与解析端必须算出同一个值。 */
export const reportDocumentHash = (document: ReportDocument): string =>
  createHash('sha256').update(canonicalJson(document)).digest('hex');

/**
 * 文档级不变量：六槽由 schema 保证齐全，这里只补 schema 表达不了的两条——
 * 盘前四段的**顺序**（`slot` 序列必须严格等于常量）与 `slot` 只属于 morning-brief。
 */
export const assertReportDocumentInvariants = (document: ReportDocument): void => {
  const slots = document.sections.flatMap((section): MorningBriefSectionKey[] =>
    section.slot === undefined ? [] : [section.slot],
  );
  if (document.kind === 'morning-brief') {
    const outOfOrder = MORNING_BRIEF_SECTION_KEYS.some((key, index) => slots[index] !== key);
    if (outOfOrder || slots.length !== MORNING_BRIEF_SECTION_KEYS.length) {
      throw new InvariantError(
        `morning-brief 四段缺失或顺序不符：期望 ${MORNING_BRIEF_SECTION_KEYS.join(' → ')}，实际 ${slots.join(' → ') || '无'}`,
      );
    }
  } else if (slots.length > 0) {
    throw new InvariantError(
      `只有 morning-brief 文档允许 section.slot（kind=${document.kind} 出现 ${slots.join(',')}）`,
    );
  }
  for (const section of document.sections) {
    assertReportBlocksPolicy(section.blocks, `sections[${section.key}].blocks`);
  }
};

const valueText = (value: ReportValue): string => {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return String(value);
};

const metricText = (item: Extract<ReportBlock, { kind: 'metrics' }>['items'][number]): string =>
  item.displayValue ??
  (item.unit === 'ratio' && typeof item.value === 'number'
    ? `${(item.value * 100).toFixed(1)}%`
    : `${valueText(item.value)}${item.unit ?? ''}`);

const markdownCell = (value: ReportValue): string =>
  valueText(value).replaceAll('|', '\\|').replaceAll('\n', ' ');

const renderBlock = (block: ReportBlock): string[] => {
  if (block.kind === 'text') {
    const text = reportDisplayText(block.text, block.textOrigin);
    return [block.tone === 'warning' ? `> ⚠️ ${text}` : text];
  }
  if (block.kind === 'metrics') {
    if (block.items.length === 0) return ['暂无指标。'];
    return block.items.map((item) => `- ${item.label}：${metricText(item)}`);
  }
  if (block.kind === 'list') {
    if (block.items.length === 0) return ['暂无记录。'];
    return block.items.map(
      (item) =>
        `- ${item.title}${
          item.detail === undefined ? '' : ` — ${reportDisplayText(item.detail, item.textOrigin)}`
        }`,
    );
  }
  if (block.rows.length === 0) return ['暂无记录。'];
  return [
    `| ${block.columns.map((column) => column.label).join(' | ')} |`,
    `| ${block.columns.map(() => '---').join(' | ')} |`,
    ...block.rows.map(
      (row) =>
        `| ${block.columns.map((column) => markdownCell(row[column.key] ?? null)).join(' | ')} |`,
    ),
  ];
};

const validityText = (envelope: ReportEnvelope): string => {
  const basis =
    envelope.validity.basis === 'advice-expiry'
      ? '依据既有建议的有效期'
      : envelope.validity.basis === 'report-period'
        ? '仅在本报告期内有效'
        : '显式声明';
  return `${envelope.validity.validUntil.toISOString()}（${basis}）`;
};

export interface RenderedReportDocument {
  readonly content: string;
  readonly documentHash: string;
}

/**
 * 渲染成「人读 Markdown + 机器读 canonical JSON 块」。
 *
 * JSON 块是唯一权威：`documentHash` 由它算出；Markdown 正文由同一个 document 渲染，
 * 不允许出现「只在正文里有、文档里没有」的信息。
 */
export const renderReportDocument = (document: ReportDocument): RenderedReportDocument => {
  const checked = ReportDocumentSchema.safeParse(document);
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new InvariantError(
      `报告文档结构不合法：${issue?.path.join('.') ?? '未知字段'} ${issue?.message ?? ''}`.trim(),
    );
  }
  const parsed = checked.data;
  assertReportDocumentInvariants(parsed);
  const documentHash = reportDocumentHash(parsed);
  const lines = [
    `# ${parsed.title}`,
    '',
    REPORT_DOCUMENT_MARKER,
    '```json',
    JSON.stringify({ documentHash, document: parsed }, null, 2),
    '```',
    '',
    '## 结论',
    '',
    parsed.envelope.conclusion,
    '',
    '## 反证',
    '',
    ...parsed.envelope.counterEvidence.map((item) => `- ${item}`),
    '',
    '## 风险',
    '',
    ...parsed.envelope.risks.map((item) => `- ${item}`),
    '',
    '## 免责',
    '',
    ...parsed.envelope.disclaimer.map((item) => `- ${item}`),
    '',
    '## 有效期',
    '',
    `- 有效期至 ${validityText(parsed.envelope)}`,
    '',
    '## 数据截止',
    '',
    `- ${parsed.envelope.dataAsOf.toISOString()}`,
  ];
  for (const section of parsed.sections) {
    lines.push('', `## ${section.title}`, '');
    lines.push(`- 数据截止：${section.dataAsOf.toISOString()}`);
    if (section.status === 'unavailable') lines.push('', '> 本节暂未取得数据，请稍后重试。');
    for (const block of section.blocks) lines.push('', ...renderBlock(block));
  }
  if (parsed.gaps.length > 0) {
    lines.push('', '## 数据说明', '', '以下缺口不代表零值；已取得的数据仍可阅读。');
    for (const gap of parsed.gaps) lines.push(`- ${gap.dimension}：${gap.reason}`);
  }
  lines.push('', '## 数据来源');
  if (parsed.evidence.length === 0) {
    lines.push('- 无');
  } else {
    for (const evidence of parsed.evidence) {
      const provenance = evidence.provenance;
      lines.push(
        `- ${evidence.dimension}：${provenance.provider}，${provenance.freshness}，观测于 ${provenance.observedAt.toISOString()}`,
      );
    }
  }
  return { content: `${lines.join('\n')}\n`, documentHash };
};

/**
 * 文件的人读正文：去掉内嵌 JSON 块，只留 Markdown。
 *
 * PRD 的行动词正则针对的是**人读正文**；JSON 块是结构化投影（原文保留处），不是给人读的指令面。
 * 任何「整份文件跑正则」的检查都应该先用这个函数取出正文，否则会把投影里的原文误判成违规。
 */
export const reportDocumentHumanBody = (content: string): string => {
  const markerAt = content.indexOf(REPORT_DOCUMENT_MARKER);
  if (markerAt < 0) return content;
  const fenceAt = content.indexOf('```json', markerAt);
  if (fenceAt < 0) return content;
  const fenceEnd = content.indexOf('```', fenceAt + '```json'.length);
  if (fenceEnd < 0) return content;
  return `${content.slice(0, markerAt)}${content.slice(fenceEnd + 3)}`;
};

/**
 * 从文件内容回环还原文档。
 *
 * **刻意与渲染分开实现**：渲染端自己拼 JSON 块，解析端自己定位标记、切代码块、逐字段过 schema、
 * 再重算指纹比对。两边若共用一段「序列化/反序列化」逻辑，丢掉一个字段会在两侧同时发生、
 * 回环断言照样绿——那就没有牙。
 */
export const parseReportDocument = (content: string): ReportDocument => {
  const markerAt = content.indexOf(REPORT_DOCUMENT_MARKER);
  if (markerAt < 0) {
    throw new InvariantError(`报告文件缺少文档标记 ${REPORT_DOCUMENT_MARKER}`);
  }
  const fenceAt = content.indexOf('```json', markerAt);
  if (fenceAt < 0) throw new InvariantError('报告文件的文档标记后没有 json 代码块');
  const bodyAt = fenceAt + '```json'.length;
  const fenceEnd = content.indexOf('```', bodyAt);
  if (fenceEnd < 0) throw new InvariantError('报告文件的 json 代码块没有闭合');

  let payload: unknown;
  try {
    payload = JSON.parse(content.slice(bodyAt, fenceEnd));
  } catch (error) {
    throw new InvariantError(
      `报告文件的 json 代码块无法解析：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (payload === null || typeof payload !== 'object') {
    throw new InvariantError('报告文件的 json 代码块必须是对象');
  }
  const { documentHash, document } = payload as { documentHash?: unknown; document?: unknown };
  const parsed = ReportDocumentSchema.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InvariantError(
      `报告文件的 document 结构不合法：${issue?.path.join('.') ?? '未知字段'} ${issue?.message ?? ''}`.trim(),
    );
  }
  if (documentHash !== reportDocumentHash(parsed.data)) {
    throw new InvariantError('报告文件的 documentHash 与 document 内容不一致');
  }
  assertReportDocumentInvariants(parsed.data);
  return parsed.data;
};

/**
 * 六槽的来源段键（REQ-M3-08 / S4）。
 *
 * 六槽**不许给默认值**：Report 里没有这些段时，文档生成直接失败并点名缺哪个槽——
 * 用默认值填上等于废掉「缺段即红」这条验收。
 */
export const REPORT_ENVELOPE_SECTION_KEYS = {
  conclusion: 'envelope-conclusion',
  counterEvidence: 'envelope-counter-evidence',
  risks: 'envelope-risks',
  validity: 'envelope-validity',
  disclaimer: 'envelope-disclaimer',
} as const;

const envelopeSection = (report: Report, slot: keyof typeof REPORT_ENVELOPE_SECTION_KEYS) => {
  const key = REPORT_ENVELOPE_SECTION_KEYS[slot];
  const section = report.sections.find((item) => item.key === key);
  if (section === undefined) {
    throw new InvariantError(`报告缺少 envelope 槽「${slot}」：需要 section「${key}」；不给默认值`);
  }
  return section;
};

const listTexts = (report: Report, slot: keyof typeof REPORT_ENVELOPE_SECTION_KEYS): string[] => {
  const section = envelopeSection(report, slot);
  const items = section.blocks.flatMap((block) =>
    block.kind === 'list' ? block.items.map((item) => item.title) : [],
  );
  if (items.length === 0) {
    throw new InvariantError(
      `报告 envelope 槽「${slot}」为空：section「${section.key}」需要至少 1 条 list 项`,
    );
  }
  return items;
};

/**
 * `Report` → `ReportDocument`（纯函数）。
 *
 * 六槽从固定的 envelope 段取；取不到就抛，**不兜底**。非 morning-brief 报告没有盘前四段，
 * `slot` 保持 undefined。
 */
export const reportDocumentFromReport = (report: Report): ReportDocument => {
  const conclusionSection = envelopeSection(report, 'conclusion');
  const conclusion = conclusionSection.blocks.find((block) => block.kind === 'text');
  if (conclusion === undefined || conclusion.kind !== 'text') {
    throw new InvariantError(
      `报告 envelope 槽「conclusion」缺失：section「${conclusionSection.key}」需要文本块`,
    );
  }
  const validitySection = envelopeSection(report, 'validity');
  const validityItems = validitySection.blocks.flatMap((block) =>
    block.kind === 'metrics' ? block.items : [],
  );
  const validUntilItem = validityItems.find((item) => item.key === 'validUntil');
  const basisItem = validityItems.find((item) => item.key === 'basis');
  const validUntil = validUntilItem?.value;
  const basis = basisItem?.value;
  if (typeof validUntil !== 'string' || Number.isNaN(Date.parse(validUntil))) {
    throw new InvariantError(
      `报告 envelope 槽「validity」缺失 validUntil：section「${validitySection.key}」需要 metrics.validUntil（ISO 时间）`,
    );
  }
  const basisParsed = ReportValidityBasisSchema.safeParse(basis);
  if (!basisParsed.success) {
    throw new InvariantError(
      `报告 envelope 槽「validity」缺失 basis：section「${validitySection.key}」需要 metrics.basis ∈ advice-expiry|report-period|explicit`,
    );
  }
  const gaps = [
    ...report.missingDimensions,
    ...report.sections.flatMap((section) => section.missingDimensions),
  ];
  const document: ReportDocument = {
    schemaVersion: REPORT_DOCUMENT_SCHEMA_VERSION,
    rendererVersion: REPORT_DOCUMENT_RENDERER_VERSION,
    kind: report.kind,
    reportId: report.id,
    title: report.title,
    scope: report.scope,
    periodStart: report.periodStart,
    periodEnd: report.periodEnd,
    generatedAt: report.generatedAt,
    envelope: {
      dataAsOf: report.dataAsOf,
      conclusion: conclusion.text,
      counterEvidence: listTexts(report, 'counterEvidence'),
      risks: listTexts(report, 'risks'),
      validity: { validUntil: new Date(validUntil), basis: basisParsed.data },
      disclaimer: listTexts(report, 'disclaimer'),
    },
    sections: report.sections.map((section) => ({
      key: section.key,
      title: section.title,
      ...(report.kind === 'morning-brief' &&
      (MORNING_BRIEF_SECTION_KEYS as readonly string[]).includes(section.key)
        ? { slot: section.key as MorningBriefSectionKey }
        : {}),
      status: section.status,
      dataAsOf: section.dataAsOf ?? report.dataAsOf,
      blocks: section.blocks,
      evidenceIds: section.evidenceIds,
      missingDimensions: section.missingDimensions,
    })),
    evidence: report.evidence,
    gaps,
  };
  return ReportDocumentSchema.parse(document);
};
