import {
  parseReportDocument,
  type Report,
  type ReportArtifactWriter,
  type ReportDocument,
  reportDocumentHash,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { writeReportArtifactTool } from './write-report-artifact.js';

const now = new Date('2026-07-29T00:45:00.000Z');
const dataAsOf = new Date('2026-07-28T07:00:00.000Z');

const memoryWriter = (): ReportArtifactWriter & { readonly files: Map<string, string> } => {
  const files = new Map<string, string>();
  return {
    directory: '/tmp/luoome-reports',
    files,
    async write({ fileName, content, overwrite }) {
      if (files.has(fileName) && !overwrite) {
        return { path: `/tmp/luoome-reports/${fileName}`, written: false, bytes: content.length };
      }
      files.set(fileName, content);
      return { path: `/tmp/luoome-reports/${fileName}`, written: true, bytes: content.length };
    },
    async read(fileName) {
      return files.get(fileName) ?? null;
    },
  };
};

const documentFixture = (overrides: Partial<ReportDocument> = {}): ReportDocument => ({
  schemaVersion: 1,
  rendererVersion: 'report-document-v1',
  kind: 'opening',
  reportId: 'report-opening-2026-07-29',
  title: '2026-07-29 开盘简报',
  scope: { kind: 'all-accounts' },
  periodStart: '2026-07-29',
  periodEnd: '2026-07-29',
  generatedAt: now,
  envelope: {
    dataAsOf,
    conclusion: '今日以观察为主。',
    counterEvidence: ['隔夜外盘走弱'],
    risks: ['量能不足时观察条件不触发'],
    validity: { validUntil: new Date('2026-07-29T07:00:00.000Z'), basis: 'report-period' },
    disclaimer: ['不构成投资建议。'],
  },
  sections: [
    {
      key: 'market-pulse',
      title: '市场脉搏',
      status: 'complete',
      dataAsOf,
      blocks: [
        {
          kind: 'list',
          items: [
            {
              title: '测试标的',
              detail: '反证：值得买入；风险：已建仓后卖出',
              textOrigin: 'advice',
            },
          ],
        },
      ],
      evidenceIds: [],
      missingDimensions: [],
    },
  ],
  evidence: [],
  gaps: [],
  ...overrides,
});

const reportFixture = (): Report => ({
  id: 'report-morning-2026-07-29',
  kind: 'morning-brief',
  scope: { kind: 'all-accounts' },
  periodStart: '2026-07-29',
  periodEnd: '2026-07-29',
  title: '2026-07-29 盘前简报',
  generatedAt: now,
  dataAsOf,
  status: 'complete',
  sections: [
    {
      key: 'account-overview',
      title: '账户概览',
      required: true,
      status: 'complete',
      blocks: [{ kind: 'text', text: '账户数据截至今日。', tone: 'factual' }],
      evidenceIds: [],
      missingDimensions: [],
    },
    {
      key: 'overnight-facts',
      title: '隔夜事实',
      required: true,
      status: 'complete',
      blocks: [{ kind: 'text', text: '隔夜指数收跌。', tone: 'factual' }],
      evidenceIds: [],
      missingDimensions: [],
    },
    {
      key: 'existing-advice',
      title: '既有建议与反证',
      required: true,
      status: 'complete',
      blocks: [{ kind: 'text', text: '既有建议仍有效。', tone: 'factual' }],
      evidenceIds: [],
      missingDimensions: [],
    },
    {
      key: 'watch-conditions',
      title: '今日观察条件',
      required: true,
      status: 'complete',
      blocks: [{ kind: 'text', text: '触发价 100 元。', tone: 'factual' }],
      evidenceIds: [],
      missingDimensions: [],
    },

    {
      key: 'envelope-conclusion',
      title: '结论',
      required: false,
      status: 'complete',
      blocks: [{ kind: 'text', text: '今日以观察为主。', tone: 'factual' }],
      evidenceIds: [],
      missingDimensions: [],
    },
    {
      key: 'envelope-counter-evidence',
      title: '反证',
      required: false,
      status: 'complete',
      blocks: [{ kind: 'list', items: [{ title: '隔夜外盘走弱' }] }],
      evidenceIds: [],
      missingDimensions: [],
    },
    {
      key: 'envelope-risks',
      title: '风险',
      required: false,
      status: 'complete',
      blocks: [{ kind: 'list', items: [{ title: '量能不足时观察条件不触发' }] }],
      evidenceIds: [],
      missingDimensions: [],
    },
    {
      key: 'envelope-validity',
      title: '有效期',
      required: false,
      status: 'complete',
      blocks: [
        {
          kind: 'metrics',
          items: [
            { key: 'validUntil', label: '有效期至', value: '2026-07-29T07:00:00.000Z' },
            { key: 'basis', label: '依据', value: 'report-period' },
          ],
        },
      ],
      evidenceIds: [],
      missingDimensions: [],
    },
    {
      key: 'envelope-disclaimer',
      title: '免责',
      required: false,
      status: 'complete',
      blocks: [{ kind: 'list', items: [{ title: '不构成投资建议。' }] }],
      evidenceIds: [],
      missingDimensions: [],
    },
  ],
  evidence: [],
  missingDimensions: [],
  deliveryStatus: 'not-requested',
  workflowRunId: 'run-1',
  createdAt: now,
  updatedAt: now,
});

describe('write_report_artifact', () => {
  it('writes the document, returns the absolute path, present args and a matching hash', async () => {
    const writer = memoryWriter();
    const ctx = { ...(await buildTestContext({ clock: () => now })), reportArtifacts: writer };
    const document = documentFixture();
    const result = await writeReportArtifactTool.execute(
      { document, reportId: document.reportId },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.deliverablePath).toBe(
      '/tmp/luoome-reports/2026-07-29-opening-all-accounts.md',
    );
    expect(result.data.written).toBe(true);
    // presentArgs 是 DSH present 的真实形状：{ files: [{ path, description? }] }
    expect(result.data.presentArgs.files).toHaveLength(1);
    expect(result.data.presentArgs.files[0]?.path).toBe(result.data.deliverablePath);
    // 回读回环：文件内容解析回同一份文档，指纹与内嵌一致。
    const stored = writer.files.get(result.data.fileName);
    expect(stored).toBeDefined();
    const parsed = parseReportDocument(stored as string);
    expect(parsed).toEqual(document);
    expect(reportDocumentHash(parsed)).toBe(result.data.documentHash);
  });

  it('maps a saved Report when no document is supplied', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const writer = memoryWriter();
    const report = reportFixture();
    await ctx.repos.report.upsertForPeriod(report);
    const result = await writeReportArtifactTool.execute(
      { reportId: report.id },
      { ...ctx, reportArtifacts: writer },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.document.envelope.conclusion).toBe('今日以观察为主。');
    expect(result.data.document.kind).toBe('morning-brief');
    expect(result.data.document.sections.map((section) => section.slot).slice(0, 4)).toEqual([
      'account-overview',
      'overnight-facts',
      'existing-advice',
      'watch-conditions',
    ]);
  });

  it('fails naming the missing envelope slot instead of inventing a default', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const report = reportFixture();
    const withoutRisks = {
      ...report,
      sections: report.sections.filter((section) => section.key !== 'envelope-risks'),
    };
    await ctx.repos.report.upsertForPeriod(withoutRisks);
    const result = await writeReportArtifactTool.execute(
      { reportId: report.id },
      { ...ctx, reportArtifacts: memoryWriter() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invariant_violation');
    expect('message' in result.error ? result.error.message : '').toContain('envelope 槽「risks」');
  });

  it('returns adapter_error when the host did not inject a writer', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const result = await writeReportArtifactTool.execute(
      { document: documentFixture(), reportId: 'report-opening-2026-07-29' },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('adapter_error');
  });

  // 写盘前复检针对**人读正文**：标题不在 block 守卫范围内，只有正文复检能挡住。
  it('rejects action words that only appear in the human-readable body (title)', async () => {
    const writer = memoryWriter();
    const ctx = { ...(await buildTestContext({ clock: () => now })), reportArtifacts: writer };
    const document = documentFixture({ title: '买入 600519 盘前简报' });
    const result = await writeReportArtifactTool.execute(
      { document, reportId: document.reportId },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invariant_violation');
    expect('message' in result.error ? result.error.message : '').toContain('含行动词「买入」');
    expect(writer.files.size).toBe(0);
  });

  it('rejects report-authored action words before writing anything', async () => {
    const writer = memoryWriter();
    const ctx = { ...(await buildTestContext({ clock: () => now })), reportArtifacts: writer };
    const document = documentFixture();
    const withActionText = {
      ...document,
      sections: document.sections.map((section) => ({
        ...section,
        blocks: [{ kind: 'text' as const, text: '建议买入 600519', tone: 'factual' as const }],
      })),
    };
    const result = await writeReportArtifactTool.execute(
      { document: withActionText, reportId: document.reportId },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(writer.files.size).toBe(0);
  });
});
