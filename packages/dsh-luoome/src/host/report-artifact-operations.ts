// 报告交付物写盘的精确 Operation policy（REQ-M3-08 / S4）。
//
// `write_report_artifact` 是 write 工具：不进 read/market allowlist，只经
// `luoome_confirmed_operation` 的 prepare → confirm 执行。receipt 用「文件存在且
// 回环 hash 与文档一致」作为已提交证据，不重新推理、不重写文件。
import { join } from 'node:path';
import type { ToolContext } from '@luoome/core';
import {
  parseReportDocument,
  type Report,
  reportArtifactFileName,
  reportDocumentFromReport,
  reportDocumentHash,
  reportScopeKey,
} from '@luoome/core';
import {
  type ConfirmablePluginTool,
  WriteReportArtifactInput,
  WriteReportArtifactOutput,
  writeReportArtifactTool,
} from '@luoome/tools';

const loadReport = async (
  input: WriteReportArtifactInput,
  ctx: ToolContext,
): Promise<Report | null> =>
  input.reportId !== undefined
    ? ctx.repos.report.findById(input.reportId)
    : ctx.repos.report.findByPeriod({
        kind: input.kind as NonNullable<WriteReportArtifactInput['kind']>,
        scopeKey: reportScopeKey(input.scope as NonNullable<WriteReportArtifactInput['scope']>),
        periodStart: input.periodEnd as string,
        periodEnd: input.periodEnd as string,
      });

export const createWriteReportArtifactOperation = (): ConfirmablePluginTool => ({
  tool: writeReportArtifactTool,
  scheduled: false,
  bind(raw) {
    return WriteReportArtifactInput.parse(raw);
  },
  async receipt(raw, ctx) {
    const input = WriteReportArtifactInput.parse(raw);
    const writer = ctx.reportArtifacts;
    if (writer === undefined) return null;
    const report = await loadReport(input, ctx);
    if (report === null) return null;
    const document = input.document ?? reportDocumentFromReport(report);
    const fileName = reportArtifactFileName({
      kind: document.kind,
      periodEnd: document.periodEnd,
      scopeKey: reportScopeKey(document.scope),
    });
    const content = await writer.read(fileName);
    if (content === null) return null;
    let parsed: ReturnType<typeof parseReportDocument>;
    try {
      parsed = parseReportDocument(content);
    } catch {
      return null;
    }
    const documentHash = reportDocumentHash(parsed);
    if (documentHash !== reportDocumentHash(document)) return null;
    const deliverablePath = join(writer.directory, fileName);
    const data = WriteReportArtifactOutput.parse({
      schemaVersion: document.schemaVersion,
      rendererVersion: document.rendererVersion,
      deliverablePath,
      fileName,
      documentHash,
      bytes: Buffer.byteLength(content, 'utf8'),
      written: false,
      presentArgs: {
        files: [
          {
            path: `${writer.directory}/${fileName}`,
            description: `${document.title}（${document.periodStart}）`,
          },
        ],
      },
      document,
    });
    return { ok: true, data };
  },
});
