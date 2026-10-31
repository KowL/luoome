import {
  assertDeliverableBodyPolicy,
  parseReportDocument,
  REPORT_DOCUMENT_RENDERER_VERSION,
  REPORT_DOCUMENT_SCHEMA_VERSION,
  type ReportDocument,
  ReportDocumentSchema,
  ReportKindSchema,
  ReportScopeSchema,
  renderReportDocument,
  reportArtifactFileName,
  reportDocumentFromReport,
  reportDocumentHash,
  reportDocumentHumanBody,
  reportScopeKey,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errAdapterError, errNotFound } from '../define-tool.js';

/**
 * 把报告写成可交付文件（REQ-M3-08 / S4）。
 *
 * 落盘由宿主注入的 `ctx.reportArtifacts` 完成——本工具不碰文件系统（载体 IO 不进 tools）。
 * 交付动作本身（`present`）由模型调用宿主工具完成；这里只给出机械化的 `presentArgs`。
 */
export const WriteReportArtifactInput = z
  .object({
    /** 按 id 定位已保存报告。 */
    reportId: z.string().min(1).optional(),
    /** 或按 kind + scope + periodEnd 定位。 */
    kind: ReportKindSchema.optional(),
    scope: ReportScopeSchema.optional(),
    periodEnd: z.string().date().optional(),
    /**
     * 可选：直接给文档（S5/S6 的 workflow 已经构造好 `ReportDocument` 时用）。
     * 缺省时从库里的 `Report` 映射，六槽取不到即失败并点名缺哪个槽。
     */
    document: ReportDocumentSchema.optional(),
    /** 已存在同名文件时是否覆盖；缺省 false（幂等）。 */
    overwrite: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, issue) => {
    // 直接给文档时不需要定位已保存报告；否则必须二选一定位。
    if (input.document !== undefined) {
      if (input.reportId !== undefined && input.document.reportId !== input.reportId) {
        issue.addIssue({
          code: 'custom',
          path: ['reportId'],
          message: 'document.reportId 与 reportId 不一致',
        });
      }
      return;
    }
    const byId = input.reportId !== undefined;
    const byKey =
      input.kind !== undefined && input.scope !== undefined && input.periodEnd !== undefined;
    if (byId === byKey) {
      issue.addIssue({
        code: 'custom',
        path: ['reportId'],
        message: 'reportId 与 (kind, scope, periodEnd) 必须二选一',
      });
    }
    if (
      byKey &&
      (input.kind === undefined || input.scope === undefined || input.periodEnd === undefined)
    ) {
      issue.addIssue({
        code: 'custom',
        path: ['kind'],
        message: 'kind/scope/periodEnd 必须同时提供',
      });
    }
  });
export type WriteReportArtifactInput = z.output<typeof WriteReportArtifactInput>;

/** DSH 宿主 `present` 的真实入参形状：`{ files: [{ path, description? }] }`（1–4 个文件）。 */
export const PresentArgsSchema = z
  .object({
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            description: z.string().min(1).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const WriteReportArtifactOutput = z.object({
  schemaVersion: z.literal(REPORT_DOCUMENT_SCHEMA_VERSION),
  rendererVersion: z.literal(REPORT_DOCUMENT_RENDERER_VERSION),
  /** 落盘后的绝对路径。 */
  deliverablePath: z.string().min(1),
  fileName: z.string().min(1),
  documentHash: z.string().length(64),
  bytes: z.number().int().nonnegative(),
  /** false = 已存在同内容文件，未重写（幂等）。 */
  written: z.boolean(),
  /** 喂给 DSH `present` 的确切参数。 */
  presentArgs: PresentArgsSchema,
  document: ReportDocumentSchema,
});
export type WriteReportArtifactOutput = z.output<typeof WriteReportArtifactOutput>;

export const writeReportArtifactTool = defineTool({
  name: 'write_report_artifact',
  description:
    '把已保存报告或给定 ReportDocument 渲染成可交付文件（Markdown + 内嵌 canonical JSON）写入 $LUOOME_HOME/reports/，返回绝对路径与 present 参数；不发送、不投递。',
  sideEffect: 'write',
  input: WriteReportArtifactInput,
  output: WriteReportArtifactOutput,
  handler: async (input, ctx) => {
    const writer = ctx.reportArtifacts;
    if (writer === undefined)
      return errAdapterError('report-artifact', 'report artifact writer is not configured', false);

    let document: ReportDocument;
    if (input.document !== undefined) {
      document = input.document;
    } else {
      const report =
        input.reportId !== undefined
          ? await ctx.repos.report.findById(input.reportId)
          : await ctx.repos.report.findByPeriod({
              kind: input.kind as NonNullable<typeof input.kind>,
              scopeKey: reportScopeKey(input.scope as NonNullable<typeof input.scope>),
              periodStart: input.periodEnd as string,
              periodEnd: input.periodEnd as string,
            });
      if (report === null)
        return errNotFound('Report', input.reportId ?? (input.periodEnd as string));
      document = reportDocumentFromReport(report);
    }

    const { content, documentHash } = renderReportDocument(document);
    // 写盘前复检**人读正文**：JSON 块保留原文，直接对整份文件跑正则会把 advice 原文误判。
    assertDeliverableBodyPolicy(reportDocumentHumanBody(content), 'report artifact');

    const fileName = reportArtifactFileName({
      kind: document.kind,
      periodEnd: document.periodEnd,
      scopeKey: reportScopeKey(document.scope),
    });
    const written = await writer.write({ fileName, content, overwrite: input.overwrite });

    const readBack = await writer.read(fileName);
    if (readBack === null)
      return errAdapterError(
        'report-artifact',
        'written report artifact cannot be read back',
        false,
      );
    const parsed = parseOrNull(readBack);
    if (parsed === null || reportDocumentHash(parsed) !== documentHash) {
      return errAdapterError(
        'report-artifact',
        'report artifact content does not round-trip to the rendered document',
        false,
      );
    }

    return {
      schemaVersion: REPORT_DOCUMENT_SCHEMA_VERSION,
      rendererVersion: REPORT_DOCUMENT_RENDERER_VERSION,
      deliverablePath: written.path,
      fileName,
      documentHash,
      bytes: written.bytes,
      written: written.written,
      presentArgs: {
        files: [
          {
            path: written.path,
            description: `${document.title}（${document.periodStart}）`,
          },
        ],
      },
      document,
    };
  },
});

const parseOrNull = (content: string): ReportDocument | null => {
  try {
    return parseReportDocument(content);
  } catch {
    return null;
  }
};
