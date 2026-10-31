import { describe, expect, it } from 'vitest';

import {
  assertFactualFieldReasons,
  assertReportInvariants,
  MORNING_BRIEF_SECTION_KEYS,
  REPORT_FACTUAL_FIELD_KEYS,
  REPORT_STANCE_LABELS,
  type Report,
  ReportSchema,
  reportDisplayTitle,
  reportStanceLabel,
  TRADE_SIDE_LABELS,
  tradeSideLabel,
} from './report.js';

const NOW = new Date('2026-07-29T10:00:00.000Z');
const DATA_AS_OF = new Date('2026-07-29T08:00:00.000Z');

const makeReport = (overrides: Partial<Report> = {}): Report => ({
  id: 'report-closing-2026-07-29',
  kind: 'closing',
  scope: { kind: 'all-accounts' },
  periodStart: '2026-07-29',
  periodEnd: '2026-07-29',
  title: '2026-07-29 A 股收盘复盘',
  generatedAt: NOW,
  dataAsOf: DATA_AS_OF,
  status: 'complete',
  sections: [
    {
      key: 'market-pulse',
      title: '市场脉搏',
      required: true,
      status: 'complete',
      dataAsOf: DATA_AS_OF,
      blocks: [
        {
          kind: 'metrics',
          items: [{ key: 'limit-up', label: '涨停家数', value: 42, unit: '家' }],
        },
      ],
      evidenceIds: ['evidence-market'],
      missingDimensions: [],
    },
  ],
  evidence: [
    {
      id: 'evidence-market',
      dimension: 'market.limit-up',
      provenance: {
        provider: 'eastmoney',
        observedAt: DATA_AS_OF,
        fetchedAt: NOW,
        freshness: 'fresh',
      },
    },
  ],
  missingDimensions: [],
  deliveryStatus: 'not-requested',
  workflowRunId: 'workflow-run-1',
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('Report', () => {
  it('收盘历史版本展示统一标题，周报保留补充标记', () => {
    const title = '2026-07-29 收盘复盘（补充 v2）（复盘补充 v3）';
    expect(reportDisplayTitle({ kind: 'closing', title })).toBe('2026-07-29 收盘复盘');
    expect(reportDisplayTitle({ kind: 'weekly', title })).toBe(title);
  });
  it('接受结构化的完整收盘报告', () => {
    const report = ReportSchema.parse(makeReport());

    expect(() => assertReportInvariants(report)).not.toThrow();
    expect(report.sections[0]?.blocks[0]?.kind).toBe('metrics');
  });

  it('保留完整输入指纹，拒绝不完整的指纹', () => {
    const fixture = makeReport();
    const withFingerprint = (inputFingerprint: string) => ({
      ...fixture,
      sections: fixture.sections.map((section) => ({ ...section, inputFingerprint })),
    });
    expect(ReportSchema.parse(withFingerprint('a'.repeat(64))).sections[0]?.inputFingerprint).toBe(
      'a'.repeat(64),
    );
    expect(ReportSchema.safeParse(withFingerprint('incomplete')).success).toBe(false);
  });

  it('拒绝不一致的周期与时间顺序', () => {
    const invalidReports: Report[] = [
      makeReport({ periodStart: '2026-07-30', periodEnd: '2026-07-29' }),
      makeReport({ dataAsOf: new Date('2026-07-29T11:00:00.000Z') }),
      makeReport({ createdAt: NOW, updatedAt: new Date('2026-07-29T09:00:00.000Z') }),
      makeReport({ periodStart: '2026-07-28' }),
      makeReport({ version: 2 }),
      makeReport({ version: 2, supersedesReportId: makeReport().id }),
      makeReport({
        kind: 'weekly',
        periodStart: '2026-07-27',
        periodEnd: '2026-08-03',
      }),
    ];

    for (const report of invalidReports) {
      expect(() => assertReportInvariants(report)).toThrow();
    }
  });

  it('要求 section/evidence 标识唯一且证据引用可解析', () => {
    const base = makeReport();
    const baseSection = base.sections[0];
    const baseEvidence = base.evidence[0];
    if (baseSection === undefined || baseEvidence === undefined) throw new Error('invalid fixture');
    const duplicateSection = makeReport({ sections: [...base.sections, baseSection] });
    const duplicateEvidence = makeReport({ evidence: [...base.evidence, baseEvidence] });
    const danglingEvidence = makeReport({
      sections: [{ ...baseSection, evidenceIds: ['missing-evidence'] }],
    });

    expect(() => assertReportInvariants(duplicateSection)).toThrow(/section key/);
    expect(() => assertReportInvariants(duplicateEvidence)).toThrow(/evidence id/);
    expect(() => assertReportInvariants(danglingEvidence)).toThrow(/evidence reference/);
  });

  it('要求 section 状态、缺失原因与报告状态相互一致', () => {
    const base = makeReport();
    const baseSection = base.sections[0];
    if (baseSection === undefined) throw new Error('invalid fixture');
    const missing = {
      dimension: 'market.breadth',
      reason: '上游不可用',
      errorKind: 'adapter_error',
      retryable: true,
    };
    const invalidReports: Report[] = [
      makeReport({
        sections: [{ ...baseSection, missingDimensions: [missing] }],
      }),
      makeReport({
        status: 'partial',
        missingDimensions: [missing],
      }),
      makeReport({
        sections: [
          {
            ...baseSection,
            status: 'partial',
            missingDimensions: [missing],
          },
        ],
      }),
      makeReport({
        status: 'partial',
        sections: [{ ...baseSection, status: 'partial' }],
      }),
      makeReport({
        status: 'partial',
        sections: [
          {
            ...baseSection,
            status: 'unavailable',
            blocks: baseSection.blocks,
            missingDimensions: [missing],
          },
        ],
      }),
    ];

    for (const report of invalidReports) {
      expect(() => assertReportInvariants(report)).toThrow();
    }
  });

  it('要求实体跳转成对出现，并拒绝把 Advice 决策字段写入事实 block', () => {
    const base = makeReport();
    const baseSection = base.sections[0];
    if (baseSection === undefined) throw new Error('invalid fixture');
    const invalidLink = ReportSchema.safeParse({
      ...base,
      sections: [
        {
          ...base.sections[0],
          blocks: [
            {
              kind: 'list',
              items: [{ title: '比亚迪', entityKind: 'stock' }],
            },
          ],
        },
      ],
    });
    expect(invalidLink.success).toBe(false);

    const decisionTable = makeReport({
      sections: [
        {
          ...baseSection,
          blocks: [
            {
              kind: 'table',
              columns: [{ key: 'decision', label: '决策' }],
              rows: [{ decision: 'buy' }],
            },
          ],
        },
      ],
    });
    expect(() => assertReportInvariants(decisionTable)).toThrow(/Advice decision field/);
  });
});

// REQ-M3-08：键名守卫只查键，正文里的行动词要单独一层——两层共用同一份判定。
describe('REQ-M3-08 报告正文行动词禁令', () => {
  const withText = (text: string): Report =>
    makeReport({
      sections: [
        {
          key: 'strategy-actions',
          title: '策略行动',
          required: true,
          status: 'complete',
          blocks: [{ kind: 'text', text, tone: 'factual' }],
          evidenceIds: [],
          missingDimensions: [],
        },
      ],
    });

  it('rejects each forbidden action word and names the field with the snippet', () => {
    for (const word of ['买入', '卖出', '已建仓', '下单']) {
      expect(() => assertReportInvariants(withText(`今日计划：${word} 600519`)), word).toThrow(
        new RegExp(`sections\\[strategy-actions\\]\\.blocks\\[0\\]\\.text 含行动词「${word}」`),
      );
    }
  });

  // 这条钉住「键名守卫 ≠ 文本守卫」：block 的键只有 kind/text/tone，键名层永远看不到正文。
  it('catches advice phrasing that the key-name guard alone lets through', () => {
    expect(() => assertReportInvariants(withText('建议买入，止损 9.8'))).toThrow(
      /含行动词「买入」/,
    );
    expect(() => assertReportInvariants(withText('建议买入，止损 9.8'))).toThrow(
      /建议买入，止损 9\.8/,
    );
  });

  it('keeps reports whose text carries no action word', () => {
    expect(() => assertReportInvariants(withText('今日以观察为主，等待量能确认。'))).not.toThrow();
  });

  // 报告面的立场标签必须自身合规：把「买入」写回标签，正文立刻违规（mutation 钉住这一点）。
  it('uses report-facing stance labels that never contain action words', () => {
    expect(REPORT_STANCE_LABELS).toEqual({
      buy: '看多',
      sell: '看空',
      hold: '观望',
      watch: '观察',
      avoid: '回避',
    });
    for (const label of Object.values(REPORT_STANCE_LABELS)) {
      expect(label).not.toMatch(/买入|卖出|已建仓|下单/);
    }
    expect(reportStanceLabel('buy')).toBe('看多');
    expect(reportStanceLabel('sell')).toBe('看空');
    // 未登记的 decision 原样透出，不静默替换成某个立场。
    expect(reportStanceLabel('unknown')).toBe('unknown');
  });
});

// REQ-M3-17：盘前简报四段，顺序固定；缺段或错序都要红。
describe('REQ-M3-17 盘前简报四段', () => {
  const brief = (keys: readonly string[]): Report =>
    makeReport({
      kind: 'morning-brief',
      sections: keys.map((key) => ({
        key,
        title: key,
        required: true,
        status: 'complete' as const,
        blocks: [{ kind: 'text' as const, text: '观察条件见下。', tone: 'factual' as const }],
        evidenceIds: [],
        missingDimensions: [],
      })),
    });

  it('accepts the four sections in the fixed order', () => {
    expect(() => assertReportInvariants(brief(MORNING_BRIEF_SECTION_KEYS))).not.toThrow();
  });

  it('rejects a missing section', () => {
    expect(() =>
      assertReportInvariants(brief(['account-overview', 'overnight-facts', 'existing-advice'])),
    ).toThrow(/morning-brief 四段缺失或顺序不符/);
  });

  it('rejects out-of-order sections', () => {
    expect(() =>
      assertReportInvariants(
        brief(['account-overview', 'existing-advice', 'overnight-facts', 'watch-conditions']),
      ),
    ).toThrow(/morning-brief 四段缺失或顺序不符/);
  });
});

// REQ-M3-08 收窄：成交事实字段按**字段键**豁免，不是整块豁免。
describe('REQ-M3-08 成交事实字段白名单', () => {
  const tableReport = (columnKey: string, cell: string): Report =>
    makeReport({
      sections: [
        {
          key: 'prior-day-review',
          title: '前一交易日',
          required: true,
          status: 'complete',
          blocks: [
            {
              kind: 'table',
              columns: [
                { key: columnKey, label: '方向' },
                { key: 'quantity', label: '数量' },
              ],
              rows: [{ [columnKey]: cell, quantity: 100 }],
            },
          ],
          evidenceIds: [],
          missingDimensions: [],
        },
      ],
    });

  it('exempts the whitelisted trade-side column', () => {
    expect(() => assertReportInvariants(tableReport('side', '买入'))).not.toThrow();
  });

  it('does not let the exemption spill to other columns', () => {
    expect(() => assertReportInvariants(tableReport('action', '买入'))).toThrow(
      /rows\[0\]\.action 含行动词「买入」/,
    );
  });

  it('still checks metrics labels even when the key is whitelisted', () => {
    const report = makeReport({
      sections: [
        {
          key: 'market-pulse',
          title: '市场脉搏',
          required: true,
          status: 'complete',
          blocks: [
            {
              kind: 'metrics',
              items: [{ key: 'side', label: '买入方向金额', value: 100 }],
            },
          ],
          evidenceIds: [],
          missingDimensions: [],
        },
      ],
    });
    expect(() => assertReportInvariants(report)).toThrow(/items\[0\]\.label 含行动词「买入」/);
  });

  it('requires a non-empty reason for every whitelisted key', () => {
    expect(() => assertFactualFieldReasons()).not.toThrow();
    for (const reason of Object.values(REPORT_FACTUAL_FIELD_KEYS))
      expect(reason.trim().length).toBeGreaterThan(0);
    // 加键不写理由 → 红；通配 → 红。
    expect(() => assertFactualFieldReasons({ action: '   ' })).toThrow(/缺少理由/);
    expect(() => assertFactualFieldReasons({ '*': '通配' })).toThrow(/非法键/);
  });
});

// U1（task-25）：成交事实词与立场词是两张表；白名单按字段键生效，与语言无关。
describe('U1 成交事实词表', () => {
  it('买卖方向的规范词，且与立场词表不共享任何取值', () => {
    expect(tradeSideLabel('buy')).toBe('买入');
    expect(tradeSideLabel('sell')).toBe('卖出');
    expect(tradeSideLabel('unknown-side')).toBe('unknown-side');
    // 两张表的语义不相交：成交事实 ≠ 研究立场。
    for (const value of Object.values(TRADE_SIDE_LABELS))
      expect(Object.values(REPORT_STANCE_LABELS)).not.toContain(value);
  });

  it('白名单豁免与语言无关：英文 side 与中文 label 都被 side 键豁免', () => {
    const tableReport = (cell: string): Report =>
      makeReport({
        sections: [
          {
            key: 'prior-day-review',
            title: '回执',
            required: true,
            status: 'complete',
            blocks: [
              {
                kind: 'table',
                columns: [
                  { key: 'side', label: '方向' },
                  { key: 'quantity', label: '数量' },
                ],
                rows: [{ side: cell, quantity: 100 }],
              },
            ],
            evidenceIds: [],
            missingDimensions: [],
          },
        ],
      });
    // 中文（closing-report 的口径）与英文原值（weekly-report 旧口径）都因 `side` 键而豁免。
    expect(() => assertReportInvariants(tableReport('买入'))).not.toThrow();
    expect(() => assertReportInvariants(tableReport('buy'))).not.toThrow();
    expect(() => assertReportInvariants(tableReport('卖出'))).not.toThrow();
    expect(() => assertReportInvariants(tableReport('sell'))).not.toThrow();
  });
});

// U1 回归：两个报告的成交表都必须用 `tradeSideLabel`（同一张表），
// 否则「豁免与语言解耦」这件事只在白名单侧成立、在渲染侧又分叉了。
describe('U1 两个报告的成交表用同一张词表', () => {
  it('closing-report 与 weekly-report 都用 tradeSideLabel 渲染 side 列', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const sources = [
      'packages/workflows/src/closing-report.ts',
      'packages/workflows/src/weekly-report.ts',
    ];
    for (const relative of sources) {
      const text = readFileSync(join(root, relative), 'utf8');
      expect(text, relative).toContain('side: tradeSideLabel(trade.side)');
      // 旧写法必须绝迹：一个写死中文三元、一个直接透出英文原值。
      expect(text, relative).not.toContain("trade.side === 'buy' ? '买入' : '卖出'");
      expect(text, relative).not.toMatch(/side:\s*trade\.side\s*,/);
    }
  });
});
