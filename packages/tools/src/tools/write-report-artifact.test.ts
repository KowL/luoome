import {
  parseReportDocument,
  type Report,
  type ReportArtifactWriter,
  type ReportDocument,
  reportDocumentHash,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { publishReportTool } from './publish-report.js';
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

/**
 * 把 `documentFixture` 的字段映射成一份 `Report`（用于「落库 + 发布」）。
 *
 * 为什么不直接改 `documentFixture`：它是「渲染产物」的 fixture，
 * 而导出路径现在**只吃持久化报告**。两者必须能互相转换，
 * 否则测试会变成「用渲染产物验证渲染产物」——那是自证循环。
 */
const reportForDocument = (document: ReportDocument): Report => ({
  id: document.reportId,
  kind: document.kind,
  scope: document.scope,
  periodStart: document.periodEnd,
  periodEnd: document.periodEnd,
  title: document.title,
  generatedAt: now,
  dataAsOf,
  status: 'complete',
  sections: [
    ...document.sections.map((section, index) => ({
      key: section.slot ?? `section-${String(index)}`,
      title: section.title,
      required: true,
      status: 'complete' as const,
      blocks: section.blocks,
      evidenceIds: [],
      missingDimensions: [],
    })),
    // `document.envelope` 是一个**结构化摘要**，而 `Report` 的 envelope 是**五个独立槽**。
    // 映射时必须拆开还原，否则 `reportDocumentFromReport` 会因为「缺槽」拒绝渲染
    // （它不给默认值——这正是「建议≠结论」那条边界）。
    {
      key: 'envelope-conclusion',
      title: '结论',
      required: true,
      status: 'complete' as const,
      blocks: [
        { kind: 'text' as const, text: document.envelope.conclusion, tone: 'factual' as const },
      ],
      evidenceIds: [],
      missingDimensions: [],
    },
    ...[
      ['envelope-counter-evidence', '反证', document.envelope.counterEvidence],
      ['envelope-risks', '风险', document.envelope.risks],
      ['envelope-disclaimer', '免责声明', document.envelope.disclaimer],
    ].map(([key, title, items]) => ({
      key: key as string,
      title: title as string,
      required: true,
      status: 'complete' as const,
      blocks: [
        {
          kind: 'list' as const,
          items: (items as string[]).map((text) => ({ title: text })),
        },
      ],
      evidenceIds: [],
      missingDimensions: [],
    })),
    {
      key: 'envelope-validity',
      title: '有效期',
      required: true,
      status: 'complete' as const,
      blocks: [
        {
          kind: 'metrics' as const,
          items: [
            {
              key: 'validUntil',
              label: '有效期至',
              value: document.envelope.validity.validUntil.toISOString(),
            },
            { key: 'basis', label: '依据', value: document.envelope.validity.basis },
          ],
        },
      ],
      evidenceIds: [],
      missingDimensions: [],
    },
  ],
  evidence: [],
  missingDimensions: [],
  deliveryStatus: 'not-requested' as const,
  workflowRunId: 'test-run',
  createdAt: now,
  updatedAt: now,
});

/**
 * 落一份报告并**发布**它（REQ-M5-02 之后，导出要求已发布）。
 *
 * 抽成 helper 而不是让每个用例各写一遍：**「先发布才能导出」是这个工具的契约**，
 * 集中在一处说明比散落在 6 个用例里清楚。
 */
const savedAndPublished = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  report: Report,
) => {
  const saved = await ctx.repos.report.upsertForPeriod(report);
  const publication = await publishReportTool.execute({ reportId: saved.id }, ctx);
  if (!publication.ok) throw new Error(`发布失败：${JSON.stringify(publication.error)}`);
  return saved;
};

describe('write_report_artifact', () => {
  it('writes the document, returns the absolute path, present args and a matching hash', async () => {
    const writer = memoryWriter();
    const ctx = { ...(await buildTestContext({ clock: () => now })), reportArtifacts: writer };
    const report = reportForDocument(documentFixture());
    const saved = await savedAndPublished(ctx, report);
    const result = await writeReportArtifactTool.execute({ reportId: saved.id }, ctx);
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
    // 与**从持久化报告映射出的** document 比较（不是传入的那个）
    expect(parsed).toEqual(result.data.document);
    expect(reportDocumentHash(parsed)).toBe(result.data.documentHash);
  });

  it('maps a saved Report when no document is supplied', async () => {
    const ctx = await buildTestContext({ clock: () => now });
    const writer = memoryWriter();
    const report = reportFixture();
    await savedAndPublished(ctx, report);
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
      { reportId: 'report-opening-2026-07-29' },
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
    // **改动前**：这条测试直传含动作词的 document，测的是「写盘前正文复检」。
    // **改动后**：直传入口已删除，所以改成「先落一份含动作词的报告 → 发布 → 导出」。
    //
    // 这**不是**为了让测试通过而改：原来那条在直传存在时**永远通过**
    // （因为根本没经过「从持久化记录读内容」这条路）。现在它才第一次真正有效——
    // 它证明「导出内容确实来自持久化记录，且那条记录里的动作词会被拦下」。
    const report = reportForDocument(documentFixture({ title: '买入 600519 盘前简报' }));
    await savedAndPublished(ctx, report);
    const result = await writeReportArtifactTool.execute({ reportId: report.id }, ctx);
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
    /**
     * 动作词落在**section title** 而不是 block 文本里。
     *
     * 为什么：`upsertForPeriod` 的 block 守卫会在**保存时**就拦下 block 里的动作词，
     * 于是这条测试会在「落库」阶段失败，**根本走不到导出**——那它就测不到正文复检了。
     *
     * 用 title 承载，才能保证：**报告能存、能发布，动作词只在导出渲染时被正文复检抓住**。
     * 这正是这条测试的原始意图（见上一条用例的注释）。
     */
    const report = reportForDocument({
      ...document,
      sections: document.sections.map((section) => ({
        ...section,
        title: '建议买入 600519',
      })),
    });
    await savedAndPublished(ctx, report);
    const result = await writeReportArtifactTool.execute({ reportId: report.id }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invariant_violation');
    expect('message' in result.error ? result.error.message : '').toContain('含行动词「买入」');
    expect(writer.files.size).toBe(0);
  });
});

// ── REQ-M5-02 第二批：只导出已发布、内容未变的内容 ──
describe('只导出已发布（M5-02）', () => {
  it('**未发布 → 拒绝**并提示先发布', async () => {
    const writer = memoryWriter();
    const ctx = { ...(await buildTestContext({ clock: () => now })), reportArtifacts: writer };
    const report = reportFixture();
    await ctx.repos.report.upsertForPeriod(report); // 落库但**不发布**
    const result = await writeReportArtifactTool.execute({ reportId: report.id }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect('message' in result.error ? result.error.message : '').toContain('尚未发布');
    // 一个字节都没写
    expect(writer.files.size).toBe(0);
  });

  it('**发布后内容被改 → 拒绝**并说明哈希不一致', async () => {
    const writer = memoryWriter();
    const ctx = { ...(await buildTestContext({ clock: () => now })), reportArtifacts: writer };
    const report = reportFixture();
    await savedAndPublished(ctx, report);

    // 发布之后内容被改（改标题）
    await ctx.repos.report.upsertForPeriod({ ...report, title: '2026-07-29 盘前简报（改写）' });
    const result = await writeReportArtifactTool.execute({ reportId: report.id }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect('message' in result.error ? result.error.message : '').toContain('发布后内容已变更');
    expect(writer.files.size).toBe(0);
  });

  it('已发布且未改 → 通过，且内容与发布时一致', async () => {
    const writer = memoryWriter();
    const ctx = { ...(await buildTestContext({ clock: () => now })), reportArtifacts: writer };
    const report = reportFixture();
    await savedAndPublished(ctx, report);
    const result = await writeReportArtifactTool.execute({ reportId: report.id }, ctx);
    expect(result.ok).toBe(true);
  });
});

describe('manifest 与自证（M5-02）', () => {
  it('导出输出带 manifest 声明 + 扫描结果', async () => {
    const writer = memoryWriter();
    const ctx = { ...(await buildTestContext({ clock: () => now })), reportArtifacts: writer };
    const report = reportFixture();
    await savedAndPublished(ctx, report);
    const result = await writeReportArtifactTool.execute({ reportId: report.id }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.manifest.containsVendorHistoricalData).toBe(false);
    expect(result.data.manifest.replayableAcrossMachines).toBe(false);
    expect(result.data.manifest.contentSource).toBe('persisted-report');
    // **自证**：声明不含 ⇒ 实际扫到的键里也没有
    expect(result.data.manifest.scannedKeys.length).toBeGreaterThan(0);
    expect(result.data.manifest.scannedKeys).not.toContain('vendorHistory');
  });
});
