import { describe, expect, it } from 'vitest';

import { assertReportInvariants, type Report, ReportSchema } from './report.js';

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
  it('接受结构化的完整收盘报告', () => {
    const report = ReportSchema.parse(makeReport());

    expect(() => assertReportInvariants(report)).not.toThrow();
    expect(report.sections[0]?.blocks[0]?.kind).toBe('metrics');
  });

  it('拒绝不一致的周期与时间顺序', () => {
    const invalidReports: Report[] = [
      makeReport({ periodStart: '2026-07-30', periodEnd: '2026-07-29' }),
      makeReport({ dataAsOf: new Date('2026-07-29T11:00:00.000Z') }),
      makeReport({ createdAt: NOW, updatedAt: new Date('2026-07-29T09:00:00.000Z') }),
      makeReport({ periodStart: '2026-07-28' }),
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
