import type { Report } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { publishReportTool } from './publish-report.js';
import { saveReportTool } from './save-report.js';

/**
 * REQ-M5-02 第一批：**「已发布」这个概念本身**。
 *
 * ## 为什么必须有它
 *
 * 「只导出已发布/已冻结的内容」的前提是系统里存在「已发布」。
 * 用「仓储里存在这条记录」当判据等于没验（`upsertForPeriod` 会覆盖，任何报告都「存在」）。
 */
const ACCOUNT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const makeReport = (overrides: Partial<Report> = {}): Report => ({
  id: 'report-publish-1',
  kind: 'closing',
  scope: { kind: 'account', accountId: ACCOUNT },
  periodStart: '2026-07-29',
  periodEnd: '2026-07-29',
  title: '收盘报告',
  generatedAt: new Date('2026-07-29T08:00:00Z'),
  dataAsOf: new Date('2026-07-29T08:00:00Z'),
  status: 'complete',
  sections: [
    {
      key: 'summary',
      title: '摘要',
      required: true,
      status: 'complete',
      blocks: [{ kind: 'text', text: '当日摘要', tone: 'factual' }],
      evidenceIds: [],
      missingDimensions: [],
    },
    // `reportDocumentFromReport` 要求五个 envelope 槽齐全（缺则拒绝渲染，
    // 不给默认值——这是「建议≠结论」那条边界的一部分）。
    ...[['envelope-conclusion', '结论', '当日结论']].map(([key, title, text]) => ({
      key: key as string,
      title: title as string,
      required: true,
      status: 'complete' as const,
      blocks: [{ kind: 'text' as const, text: text as string, tone: 'factual' as const }],
      evidenceIds: [],
      missingDimensions: [],
    })),
    // 反证 / 风险槽需要**至少 1 条 list 项**：空的「反证」等于没给反证。
    ...[
      ['envelope-counter-evidence', '反证', '存在反向证据'],
      ['envelope-risks', '风险', '存在风险'],
      ['envelope-disclaimer', '免责声明', '本报告仅供研究参考'],
    ].map(([key, title, text]) => ({
      key: key as string,
      title: title as string,
      required: true,
      status: 'complete' as const,
      blocks: [
        {
          kind: 'list' as const,
          items: [{ title: text as string }],
        },
      ],
      evidenceIds: [],
      missingDimensions: [],
    })),
    {
      // 有效期槽必须是 `metrics` block：渲染器要从里面取 `validUntil` 与 `basis`。
      key: 'envelope-validity',
      title: '有效期',
      required: true,
      status: 'complete' as const,
      blocks: [
        {
          kind: 'metrics' as const,
          items: [
            { key: 'validUntil', label: '有效期至', value: '2026-08-05T00:00:00.000Z' },
            { key: 'basis', label: '依据', value: 'report-period' },
          ],
        },
      ],
      evidenceIds: [],
      missingDimensions: [],
    },
  ],
  evidence: [],
  missingDimensions: [],
  deliveryStatus: 'not-requested',
  workflowRunId: 'run-1',
  createdAt: new Date('2026-07-29T08:00:00Z'),
  updatedAt: new Date('2026-07-29T08:00:00Z'),
  ...overrides,
});

const setup = async () => {
  const ctx = await buildTestContext({ clock: () => new Date('2026-07-29T10:00:00Z') });
  const saved = await saveReportTool.execute({ report: makeReport() }, ctx);
  if (!saved.ok) throw new Error(`save_report 失败：${JSON.stringify(saved.error)}`);
  return ctx;
};

describe('发布记录是「已发布」的唯一判据', () => {
  it('未发布的报告 → `findByReportId` 返回 null', async () => {
    const ctx = await setup();
    // 报告**存在**，但**没发布** —— 两者必须可区分
    expect(await ctx.repos.report.findById('report-publish-1')).not.toBeNull();
    expect(await ctx.repos.reportPublication.findByReportId('report-publish-1')).toBeNull();
  });

  it('发布后 → 记录存在，且记录了当时的哈希与版本', async () => {
    const ctx = await setup();
    const result = await publishReportTool.execute({ reportId: 'report-publish-1' }, ctx);
    if (!result.ok) throw new Error(`publish 失败：${JSON.stringify(result.error)}`);
    expect(result.data.published).toBe(true);
    expect(result.data.publication.documentHash).toHaveLength(64);
    expect(result.data.publication.version).toBe(1);
  });

  it('不存在的报告 → not_found', async () => {
    const ctx = await setup();
    const result = await publishReportTool.execute({ reportId: 'nope' }, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });
});

describe('**快照性质**：发布后内容变了，发布记录仍指向旧 hash', () => {
  it('upsert 覆盖报告后，发布记录不变', async () => {
    const ctx = await setup();
    const published = await publishReportTool.execute({ reportId: 'report-publish-1' }, ctx);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const hashAtPublish = published.data.publication.documentHash;
    const publishedAt = published.data.publication.publishedAt;

    // 内容变了（改标题 → 渲染哈希必然变）
    const overwritten = await saveReportTool.execute(
      { report: makeReport({ title: '收盘报告（已被改写）' }) },
      ctx,
    );
    expect(overwritten.ok).toBe(true);

    const after = await ctx.repos.reportPublication.findByReportId('report-publish-1');
    // **发布记录仍指向旧哈希** —— 这是「时间点快照」的核心
    expect(after?.documentHash).toBe(hashAtPublish);
    expect(after?.publishedAt.getTime()).toBe(publishedAt.getTime());
  });
});

describe('重复发布 → 拒绝，不覆盖', () => {
  it('同一报告发布两次 → 第二次被拒且旧记录不变', async () => {
    const ctx = await setup();
    const first = await publishReportTool.execute({ reportId: 'report-publish-1' }, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstHash = first.data.publication.documentHash;

    const second = await publishReportTool.execute({ reportId: 'report-publish-1' }, ctx);
    // **发布是一次性动作**：允许重复会把「已发布」变成「随时可改」
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.kind).toBe('invalid_input');
    expect(
      (await ctx.repos.reportPublication.findByReportId('report-publish-1'))?.documentHash,
    ).toBe(firstHash);
  });
});
