import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_ACTION_WORDS,
  MORNING_BRIEF_SECTION_KEYS,
  normalizeDeliverableText,
  REPORT_FACTUAL_TABLE_NOTE,
  reportDisplayText,
} from './report.js';
import {
  parseReportDocument,
  type ReportDocument,
  ReportDocumentSchema,
  renderReportDocument,
  reportDocumentHash,
  reportDocumentHumanBody,
} from './report-document.js';

const NOW = new Date('2026-07-29T00:45:00.000Z');
const DATA_AS_OF = new Date('2026-07-28T07:00:00.000Z');

const section = (
  key: string,
  title: string,
  slot: ReportDocument['sections'][number]['slot'],
  blocks: ReportDocument['sections'][number]['blocks'],
): ReportDocument['sections'][number] => ({
  key,
  title,
  ...(slot === undefined ? {} : { slot }),
  status: 'complete',
  dataAsOf: DATA_AS_OF,
  blocks,
  evidenceIds: [],
  missingDimensions: [],
});

/** 盘前简报文档：六槽 envelope + 四段 sections（顺序固定）。 */
const makeDocument = (overrides: Partial<ReportDocument> = {}): ReportDocument => ({
  schemaVersion: 1,
  rendererVersion: 'report-document-v1',
  kind: 'morning-brief',
  reportId: 'report-morning-brief-2026-07-29',
  title: '2026-07-29 盘前简报',
  scope: { kind: 'all-accounts' },
  periodStart: '2026-07-29',
  periodEnd: '2026-07-29',
  generatedAt: NOW,
  envelope: {
    dataAsOf: DATA_AS_OF,
    conclusion: '今日以观察为主，等待量能确认后再评估仓位变化。',
    counterEvidence: ['隔夜外盘走弱，开盘可能承压', '北向资金连续两日净流出'],
    risks: ['情绪修复不及预期时，观察条件可能整日不触发'],
    validity: { validUntil: new Date('2026-07-29T07:00:00.000Z'), basis: 'report-period' },
    disclaimer: ['本简报为研究材料，不构成投资建议，也不代表任何成交。'],
  },
  sections: [
    section('account-overview', '账户概览', 'account-overview', [
      {
        kind: 'metrics',
        items: [
          { key: 'dataAsOf', label: '数据截止', value: DATA_AS_OF.toISOString() },
          { key: 'totalValue', label: '账户总市值', value: 1_234_567.89, unit: '元' },
        ],
      },
    ]),
    section('overnight-facts', '隔夜事实', 'overnight-facts', [
      {
        kind: 'list',
        items: [
          {
            title: '纳斯达克指数 -1.2%',
            detail: '来源 fixture-index · 观测于 2026-07-28T20:00:00.000Z',
          },
        ],
      },
    ]),
    section('existing-advice', '既有建议与反证', 'existing-advice', [
      {
        kind: 'text',
        text: '既有建议仍有效，反证条件为量能持续萎缩。',
        tone: 'factual',
      },
    ]),
    section('watch-conditions', '今日观察条件', 'watch-conditions', [
      {
        kind: 'metrics',
        items: [
          { key: 'trigger', label: '触发价', value: 100, unit: '元' },
          { key: 'invalid', label: '失效条件', value: '跌破 95 元' },
        ],
      },
    ]),
  ],
  evidence: [
    {
      id: 'market-pulse:indexes:0',
      dimension: 'market-pulse.indexes',
      provenance: {
        provider: 'fixture-index',
        observedAt: DATA_AS_OF,
        fetchedAt: NOW,
        freshness: 'fresh',
      },
    },
  ],
  gaps: [],
  ...overrides,
});

describe('REQ-M3-08 ReportDocument 文档模型', () => {
  // 验收 1：文件 ↔ 结构化输出字段级 diff 为空的可执行版本。
  it('round-trips a document through render and parse with an identical hash', () => {
    const document = makeDocument();
    const rendered = renderReportDocument(document);
    const parsed = parseReportDocument(rendered.content);
    expect(parsed).toEqual(document);
    expect(reportDocumentHash(parsed)).toBe(rendered.documentHash);
    expect(reportDocumentHash(document)).toBe(rendered.documentHash);
  });

  // 验收 5：Markdown 正文必须含每个 metric 的 label 与 displayValue，防「JSON 对但人读部分丢数字」。
  it('prints every metric label and display value in the markdown body', () => {
    const document = makeDocument({
      sections: [
        ...makeDocument().sections,
        section('extra', '补充指标', undefined, [
          {
            kind: 'metrics',
            items: [
              { key: 'ratio', label: '炸板率', value: 0.25, displayValue: '25.0%' },
              { key: 'plain', label: '封板家数', value: 12 },
            ],
          },
        ]),
      ],
    });
    const { content } = renderReportDocument(document);
    expect(content).toContain('炸板率');
    expect(content).toContain('25.0%');
    expect(content).toContain('封板家数');
    expect(content).toContain('12');
  });

  // 验收 2：六槽逐一缺失都要红（五段是下界，不是恰好五个）。
  it('rejects a document missing any of the six envelope slots', () => {
    const cases: [string, (document: ReportDocument) => ReportDocument][] = [
      [
        'dataAsOf',
        (document) => ({
          ...document,
          envelope: { ...document.envelope, dataAsOf: undefined as unknown as Date },
        }),
      ],
      [
        'conclusion',
        (document) => ({
          ...document,
          envelope: { ...document.envelope, conclusion: '' },
        }),
      ],
      [
        'counterEvidence',
        (document) => ({
          ...document,
          envelope: { ...document.envelope, counterEvidence: [] },
        }),
      ],
      [
        'risks',
        (document) => ({
          ...document,
          envelope: { ...document.envelope, risks: [] },
        }),
      ],
      [
        'validity',
        (document) => ({
          ...document,
          envelope: {
            ...document.envelope,
            validity: undefined as unknown as ReportDocument['envelope']['validity'],
          },
        }),
      ],
      [
        'disclaimer',
        (document) => ({
          ...document,
          envelope: { ...document.envelope, disclaimer: [] },
        }),
      ],
    ];
    expect(cases).toHaveLength(6);
    for (const [slot, breakIt] of cases) {
      expect(() => renderReportDocument(breakIt(makeDocument())), slot).toThrow(
        new RegExp(`envelope\\.${slot}`),
      );
    }
  });

  // 验收 3：盘前四段缺段 → 红；顺序错 → 红。
  it('rejects a morning brief missing a slot or with slots out of order', () => {
    const base = makeDocument();
    const missing = {
      ...base,
      sections: base.sections.filter((item) => item.slot !== 'watch-conditions'),
    };
    expect(() => renderReportDocument(missing)).toThrow(/morning-brief 四段缺失或顺序不符/);

    const swapped = { ...base, sections: [...base.sections] };
    const third = swapped.sections[2];
    const fourth = swapped.sections[3];
    if (third === undefined || fourth === undefined) throw new Error('invalid fixture');
    swapped.sections[2] = fourth;
    swapped.sections[3] = third;
    expect(() => renderReportDocument(swapped)).toThrow(/morning-brief 四段缺失或顺序不符/);
  });

  it('only allows section slots on morning-brief documents', () => {
    const document = makeDocument({
      kind: 'closing',
      sections: makeDocument().sections.map((item) => ({ ...item, slot: undefined })),
    });
    expect(() => renderReportDocument(document)).not.toThrow();
    const withSlot = makeDocument({ kind: 'closing' });
    expect(() => renderReportDocument(withSlot)).toThrow(/只有 morning-brief 文档允许/);
  });

  // 验收 4：文本禁令（四个词各一条），报错点名字段与原文片段。
  it('rejects forbidden action language and names the field with the offending text', () => {
    for (const word of ['买入', '卖出', '已建仓', '下单']) {
      const document = makeDocument({
        sections: makeDocument().sections.map((item) =>
          item.slot === 'watch-conditions'
            ? {
                ...item,
                blocks: [
                  {
                    kind: 'text' as const,
                    text: `今日计划：${word} 600519`,
                    tone: 'factual' as const,
                  },
                ],
              }
            : item,
        ),
      });
      expect(() => renderReportDocument(document), word).toThrow(
        new RegExp(`sections\\[watch-conditions\\]\\.blocks\\[0\\]\\.text 含行动词「${word}」`),
      );
    }
  });

  // 交付物词面策略（D）：外部来源自由文本 → 人读正文规范化，结构化投影逐字保留原文。
  it('normalizes advice-origin text in the human body while keeping the original in the JSON block', () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    const originals: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      // 每 4 条里有一条同时含四个词，其余随机取 1–3 个——覆盖「单点」与「密集」两种输入。
      const parts: string[] =
        index % 4 === 0
          ? [...FORBIDDEN_ACTION_WORDS]
          : Array.from({ length: 1 + (next() % 3) }, () => {
              return FORBIDDEN_ACTION_WORDS[next() % FORBIDDEN_ACTION_WORDS.length] as string;
            });
      parts.push(`片段${index}`);
      originals.push(parts.join('，'));
    }
    expect(
      originals.some((text) => FORBIDDEN_ACTION_WORDS.every((word) => text.includes(word))),
    ).toBe(true);

    for (const original of originals) {
      const document = makeDocument({
        sections: makeDocument().sections.map((item) =>
          item.slot === 'watch-conditions'
            ? {
                ...item,
                blocks: [
                  {
                    kind: 'list' as const,
                    items: [{ title: '测试标的', detail: original, textOrigin: 'advice' as const }],
                  },
                ],
              }
            : item,
        ),
      });
      const { content } = renderReportDocument(document);
      const body = reportDocumentHumanBody(content);
      for (const word of FORBIDDEN_ACTION_WORDS) expect(body, original).not.toContain(word);
      // 原文逐字保留在结构化投影里（信息不丢）。
      const parsed = parseReportDocument(content);
      const block = parsed.sections.find((item) => item.slot === 'watch-conditions')?.blocks[0];
      expect(block?.kind === 'list' ? block.items[0]?.detail : undefined).toBe(original);
    }
  });

  // 自撰文本不许被规范化兜底：没有 textOrigin 就是 bug，必须拒绝。
  it('rejects report-authored list text instead of normalizing it', () => {
    const document = makeDocument({
      sections: makeDocument().sections.map((item) =>
        item.slot === 'watch-conditions'
          ? {
              ...item,
              blocks: [
                {
                  kind: 'list' as const,
                  items: [{ title: '测试标的', detail: '建议买入 600519' }],
                },
              ],
            }
          : item,
      ),
    });
    expect(() => renderReportDocument(document)).toThrow(
      /sections\[watch-conditions\]\.blocks\[0\]\.items\[0\]\.detail 含行动词「买入」/,
    );
  });

  it('normalizes only advice-origin text and maps the four words deterministically', () => {
    expect(normalizeDeliverableText('买入 卖出 已建仓 下单')).toBe('看多 看空 已持有 委托');
    expect(normalizeDeliverableText('建议买入，已建仓后再卖出')).toBe('建议看多，已持有后再看空');
    // 报告自撰文本原样返回：规范化不能成为自撰文本的兜底。
    expect(reportDisplayText('建议买入')).toBe('建议买入');
    expect(reportDisplayText('建议买入', 'advice')).toBe('建议看多');
  });

  // 成交事实字段：含成交表才附说明句（由内容派生），且说明句自身过守卫。
  it('adds the trade-fact note only when the document contains trade facts', () => {
    const withTrades = makeDocument({
      sections: makeDocument().sections.map((item) =>
        item.slot === 'watch-conditions'
          ? {
              ...item,
              blocks: [
                {
                  kind: 'table' as const,
                  columns: [
                    { key: 'side', label: '方向' },
                    { key: 'quantity', label: '数量' },
                  ],
                  rows: [{ side: '买入', quantity: 100 }],
                },
              ],
            }
          : item,
      ),
    });
    expect(renderReportDocument(withTrades).content).toContain(REPORT_FACTUAL_TABLE_NOTE);
    // 没有成交事实的文档不出现说明句。
    expect(renderReportDocument(makeDocument()).content).not.toContain(REPORT_FACTUAL_TABLE_NOTE);
    // 说明句本身不含行动词（它也要过守卫）。
    expect(REPORT_FACTUAL_TABLE_NOTE).not.toMatch(/买入|卖出|已建仓|下单/);
  });

  it('detects a tampered document hash and a missing marker', () => {
    const { content } = renderReportDocument(makeDocument());
    const tampered = content.replace(
      /"documentHash": "[a-f0-9]{64}"/,
      `"documentHash": "${'0'.repeat(64)}"`,
    );
    expect(() => parseReportDocument(tampered)).toThrow(/documentHash 与 document 内容不一致/);
    expect(() => parseReportDocument('# 没有标记的报告')).toThrow(/缺少文档标记/);
  });

  it('keeps the document schema strict so unknown keys cannot slip through', () => {
    const document = makeDocument();
    const withExtra = { ...document, unexpected: true };
    expect(ReportDocumentSchema.safeParse(withExtra).success).toBe(false);
  });

  it('uses the fixed four-slot constant as the single source of section order', () => {
    expect(MORNING_BRIEF_SECTION_KEYS).toEqual([
      'account-overview',
      'overnight-facts',
      'existing-advice',
      'watch-conditions',
    ]);
  });
});
