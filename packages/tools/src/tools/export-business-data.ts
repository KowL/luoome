import { type DataArchiveWriter, type DataImportTables, dataArchiveFileName } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError } from '../define-tool.js';

/** 与搬迁前 `apps/web/src/data-transfer.ts:497` 的 `LuoomeDataArchive` 形状兼容（该文件已随 M3-01 删除；导出物要被 restore 吃回去）。 */
export const BusinessDataArchiveSchema = z
  .object({
    format: z.literal('luoome-data'),
    version: z.literal(1),
    exportedAt: z.string(),
    categories: z.array(z.string().min(1)),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  })
  .strict();

export const ExportBusinessDataInput = z
  .object({
    /** 人类可读备注，写进返回的说明里；不参与归档内容。 */
    note: z.string().trim().max(200).optional(),
  })
  .strict();

const PresentArgsSchema = z
  .object({
    files: z
      .array(z.object({ path: z.string().min(1), description: z.string().min(1).optional() }))
      .min(1)
      .max(4),
  })
  .strict();

export const ExportBusinessDataOutput = z
  .object({
    format: z.literal('luoome-data'),
    version: z.literal(1),
    exportedAt: z.string(),
    /** 表→行数。**不含内容**：全库归档可能 MB 级，塞进工具输出会吃掉上下文预算。 */
    tables: z.record(z.string(), z.number().int().nonnegative()),
    totalRows: z.number().int().nonnegative(),
    /** 归档摘要（与喂给 `restore_data_import` 的那份同口径）。 */
    archiveDigest: z.string().length(64),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    /** false = 已存在同内容文件，未重写（同一份数据导两次只有一个文件）。 */
    written: z.boolean(),
    presentArgs: PresentArgsSchema,
  })
  .strict();

export type ExportBusinessDataOutputValue = z.output<typeof ExportBusinessDataOutput>;

/** 表→行数（供输出与测试复用）。 */
export const tableCounts = (tables: DataImportTables): Readonly<Record<string, number>> =>
  Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length]));

export const exportBusinessDataTool = defineTool({
  name: 'export_business_data',
  description:
    '把业务事实导出为 `luoome-data` 归档文件（与 restore_data_import 同一套业务表集合）写入 $LUOOME_HOME/exports/，返回绝对路径与 present 参数；不发送、不投递、不改库。',
  // **write 不是 read**：判据是「有没有改变任何外部状态」——它会留下文件。
  // 标 read 等于给模型一个错误的安全担保（`list_holdings` 那次的判决书）。
  sideEffect: 'write',
  input: ExportBusinessDataInput,
  output: ExportBusinessDataOutput,
  handler: async (input, ctx) => {
    const writer: DataArchiveWriter | undefined = ctx.dataArchives;
    if (writer === undefined)
      return errAdapterError('data-archive', 'data archive writer is not configured', false);
    const repository = ctx.repos.dataImport;
    if (repository === undefined)
      return errAdapterError('data-import', 'data import repository is unavailable', false);

    const { tables, digest } = await repository.exportBusinessTables();
    const exportedAt = ctx.clock();
    const archive = {
      format: 'luoome-data' as const,
      version: 1 as const,
      exportedAt: exportedAt.toISOString(),
      // 全量导出，不做分类挑选：restore_data_import 是全量语义，
      // 挑出来的子集**恢复不回去**，那是假的安全感。
      categories: ['all'],
      tables,
    };
    const content = `${JSON.stringify(archive)}\n`;
    const written = await writer.write({
      fileName: dataArchiveFileName({ exportedAt, digest }),
      content,
      // 幂等：同 digest 同名 → 已存在即不重写（返回 written:false）。
      overwrite: false,
    });
    const counts = tableCounts(tables);
    const totalRows = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return ExportBusinessDataOutput.parse({
      format: archive.format,
      version: archive.version,
      exportedAt: archive.exportedAt,
      tables: counts,
      totalRows,
      archiveDigest: digest,
      path: written.path,
      bytes: written.bytes,
      written: written.written,
      presentArgs: {
        files: [
          {
            path: written.path,
            description:
              input.note ??
              `业务数据导出包（${String(Object.keys(counts).length)} 张业务表，${String(totalRows)} 行）`,
          },
        ],
      },
    });
  },
});
