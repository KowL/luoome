import {
  assertDeliverableBodyPolicy,
  collectKeys,
  InvariantError,
  parseReportDocument,
  publicationMatchesCurrent,
  REPORT_ARTIFACT_MANIFEST,
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
  VENDOR_HISTORICAL_KEYS,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, errAdapterError, errInvalidInput, errNotFound } from '../define-tool.js';

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
     * **不存在直传文档的入口**（REQ-M5-02）。
     *
     * 这里曾有一个 `document` 可选入参，且校验里为它留了一条**提前返回的短路**：
     * 传了 `document` 就跳过「必须定位到已保存报告」的检查。
     * 那不是一个「检查不够严」的问题——那是**结构上留了一个后门**：
     * 任何内容都能被导出，而验收会显示「文件与传入内容一致」（证明序列化正确，
     * 却完全没有证明「这份内容已被发布」）。
     *
     * ⇒ 内容**永远从仓储读**，且必须已有发布记录。
     */
    /** 已存在同名文件时是否覆盖；缺省 false（幂等）。 */
    overwrite: z.boolean().default(false),
  })
  .strict()
  .superRefine((input, issue) => {
    // **没有直传文档的短路了**：必须二选一定位到已保存报告。
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
  /**
   * 交付物 manifest（REQ-M5-02）。**声明 + 自证**：
   * 声明的每一条都在同一结构里给出可核对的扫描结果。
   */
  manifest: z
    .object({
      containsVendorHistoricalData: z.literal(false),
      replayableAcrossMachines: z.literal(false),
      contentSource: z.literal('persisted-report'),
      /** 本次导出内容里**实际扫到**的键（用于自证「不含供应商历史数据」）。 */
      scannedKeys: z.array(z.string()),
    })
    .strict(),
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

    // **内容永远从仓储读**（没有直传入口）。
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

    const document: ReportDocument = reportDocumentFromReport(report);
    const { content, documentHash } = renderReportDocument(document);

    /**
     * **只导出已发布且内容未变的内容**（REQ-M5-02）。
     *
     * 两道关，缺一不可：
     * 1. 必须存在发布记录 —— 否则「已发布」这个概念形同虚设
     * 2. 发布时的哈希必须等于**当前渲染**的哈希 —— 否则内容在发布后被改过，
     *    那份发布记录不再代表现在要导出的东西
     */
    const publication = await ctx.repos.reportPublication.findByReportId(report.id);
    if (publication === null)
      return errInvalidInput(
        `报告 ${report.id} 尚未发布：只有已发布的报告才能导出为交付物（先调用 publish_report）`,
      );
    if (
      !publicationMatchesCurrent({
        publication,
        currentReportId: report.id,
        currentDocumentHash: documentHash,
      })
    )
      return errInvalidInput(
        `报告 ${report.id} 在发布后内容已变更（发布时 ${publication.documentHash.slice(0, 12)}…，当前 ${documentHash.slice(0, 12)}…）：` +
          '该发布记录已不代表当前内容，请重新发布后再导出',
      );
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

    /**
     * 自证：扫描导出内容里实际出现的键，**若命中供应商历史数据字段名就报错**。
     * 这条不是「声明」，是「当场验」。
     */
    const scannedKeys = [...collectKeys(document)].sort();
    const leaked = scannedKeys.filter((key) =>
      (VENDOR_HISTORICAL_KEYS as readonly string[]).includes(key),
    );
    if (leaked.length > 0)
      throw new InvariantError(
        `交付物含供应商历史数据字段：${leaked.join(', ')}——与 manifest 声明不符`,
      );

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
      manifest: { ...REPORT_ARTIFACT_MANIFEST, scannedKeys },
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
