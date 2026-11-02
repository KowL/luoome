import {
  type ReportPublication,
  renderReportDocument,
  reportDocumentFromReport,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

/**
 * 发布一份报告（REQ-M5-02）。
 *
 * ## 这个工具是「只导出已发布」的**唯一入口**
 *
 * 没有发布记录 ⇒ 不可导出。所以这一步必须显式、可审计：
 * 用户在什么时刻、把哪一版、**什么内容哈希**发布了出去。
 *
 * ## `documentHash` 记的是**发布那一刻的渲染哈希**
 *
 * 之后报告被 `upsertForPeriod` 覆盖，发布记录**仍指向旧哈希** ——
 * 于是「内容变了但发布记录没更新」可被发现，而不是静默跟随。
 *
 * ## 重复发布同一报告 → 拒绝
 *
 * 发布是一次性动作。允许重复会把「已发布」变成「随时可改」，
 * 而那正是这个概念要防的。要重新发布必须先撤销（当前不支持，属另一个需求）。
 */
export const PublishReportInput = z
  .object({
    reportId: z.string().min(1),
  })
  .strict();

export const PublishReportOutput = z.object({
  /** 本次是否真的新建了发布记录（false = 之前已发布过，原样返回旧记录）。 */
  published: z.boolean(),
  publication: z.object({
    reportId: z.string().min(1),
    version: z.number().int().positive(),
    publishedAt: z.coerce.date(),
    documentHash: z.string().length(64),
    frozenAt: z.coerce.date(),
  }),
});

export const publishReportTool = defineTool({
  name: 'publish_report',
  description:
    '发布一份已保存的报告，记录发布时刻的内容哈希（快照）。只有发布过的报告才能被导出为交付物。',
  sideEffect: 'write',
  input: PublishReportInput,
  output: PublishReportOutput,
  handler: async (input, ctx) => {
    const report = await ctx.repos.report.findById(input.reportId);
    if (report === null) return errNotFound('Report', input.reportId);

    // 渲染一次，取这一刻的哈希 —— **这是快照的来源**。
    const { documentHash } = renderReportDocument(reportDocumentFromReport(report));
    const now = ctx.clock();
    const publication: ReportPublication = {
      reportId: report.id,
      version: report.version ?? 1,
      publishedAt: now,
      documentHash,
      frozenAt: now,
    };

    const result = await ctx.repos.reportPublication.publish(publication);
    // 已发布过 → 不覆盖，但要**明确告知**（让调用方知道它不是新发布的）。
    if (!result.published)
      return errInvalidInput(
        `报告 ${report.id} 已于 ${result.publication.publishedAt.toISOString()} 发布过（v${String(result.publication.version)}）；发布是一次性动作，不覆盖既有记录`,
      );
    return { published: true, publication: result.publication };
  },
});
