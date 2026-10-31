// 六槽 envelope 段的统一构造（REQ-M3-08 / S6a）。
//
// 盘前简报、日复盘、风险日报共用同一份段形状：`reportDocumentFromReport()` 按固定段键取值，
// 取不到就抛——所以这里**不做任何默认值**，空数组/空串由调用方负责（它们各自的数据决定）。
import { type ReportBlock, type ReportSection, STANDARD_DISCLAIMERS } from '@luoome/core';

export const ENVELOPE_SECTION_KEYS = {
  conclusion: 'envelope-conclusion',
  counterEvidence: 'envelope-counter-evidence',
  risks: 'envelope-risks',
  validity: 'envelope-validity',
  disclaimer: 'envelope-disclaimer',
} as const;

export interface EnvelopeInput {
  readonly dataAsOf: Date;
  readonly conclusion: string;
  readonly counterEvidence: readonly string[];
  readonly risks: readonly string[];
  readonly validUntil: Date;
  readonly disclaimer?: readonly string[];
}

const text = (value: string): ReportBlock => ({ kind: 'text', text: value, tone: 'factual' });
const list = (items: readonly string[]): ReportBlock => ({
  kind: 'list',
  items: items.map((item) => ({ title: item })),
});

const section = (
  key: string,
  title: string,
  blocks: ReportBlock[],
  dataAsOf: Date,
): ReportSection => ({
  key,
  title,
  required: false,
  status: 'complete',
  dataAsOf,
  blocks,
  evidenceIds: [],
  missingDimensions: [],
});

/** 六槽段（`dataAsOf` 走报告级字段，这里只产出 5 个 section）。 */
export const envelopeSections = (input: EnvelopeInput): ReportSection[] => [
  section(ENVELOPE_SECTION_KEYS.conclusion, '结论', [text(input.conclusion)], input.dataAsOf),
  section(
    ENVELOPE_SECTION_KEYS.counterEvidence,
    '反证',
    [list(input.counterEvidence)],
    input.dataAsOf,
  ),
  section(ENVELOPE_SECTION_KEYS.risks, '风险', [list(input.risks)], input.dataAsOf),
  section(
    ENVELOPE_SECTION_KEYS.validity,
    '有效期',
    [
      {
        kind: 'metrics',
        items: [
          { key: 'validUntil', label: '有效期至', value: input.validUntil.toISOString() },
          { key: 'basis', label: '依据', value: 'report-period' },
        ],
      },
    ],
    input.dataAsOf,
  ),
  section(
    ENVELOPE_SECTION_KEYS.disclaimer,
    '免责',
    [list(input.disclaimer ?? STANDARD_DISCLAIMERS)],
    input.dataAsOf,
  ),
];
