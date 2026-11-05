import { z } from 'zod';

/**
 * 全市场 dump 运行事实（设计 docs/ddd/fuyao-data-expansion-and-tushare-retirement-design.md §5）。
 *
 * MarketDumpRun 是一次 dump 同步的可审计生命周期记录：
 * - 身份：runId + kind + dumpId + artifactSha256（内容寻址，内容变化即新身份）；
 * - checkpoint：nextRowOffset/processedRows 支持进程中断后按相同 recordedAt 重放；
 * - 时间：requestedAt（tool 受理）/ downloadedAt（artifact 落盘）/ startedAt（首批导入开始）
 *   / finishedAt（终态）分开；recordedAt 是导入批次的统一本地记录时间，run 首次开始
 *   导入时冻结，恢复时沿用，保证同一 run 的 revision 具有同一 PIT 记录时间。
 *
 * 预签名 URL、API Key 不进入本实体；错误消息必须已脱敏。
 */

export const MarketDumpKindSchema = z.enum(['daily-k', 'daily-k-10d', 'adjustment-factors']);
export type MarketDumpKind = z.infer<typeof MarketDumpKindSchema>;

export const MarketDumpRunStatusSchema = z.enum(['running', 'complete', 'failed']);
export type MarketDumpRunStatus = z.infer<typeof MarketDumpRunStatusSchema>;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'artifactSha256 必须是 sha256 hex');

export const MarketDumpRunSchema = z
  .object({
    runId: z.string().min(1),
    kind: MarketDumpKindSchema,
    /** 从 URL 路径解析的 dump 身份；取票前失败用 unresolved:<kind>:<runId> 标记本地失败请求。 */
    dumpId: z.string().min(1),
    source: z.literal('fuyao'),
    /** 完整 artifact 的 SHA-256；下载完成前为 null。 */
    artifactSha256: Sha256Schema.nullable(),
    status: MarketDumpRunStatusSchema,
    /** 统一本地记录时间；首次开始导入时冻结，checkpoint 恢复沿用。 */
    recordedAt: z.coerce.date().nullable(),
    requestedAt: z.coerce.date(),
    downloadedAt: z.coerce.date().nullable(),
    startedAt: z.coerce.date().nullable(),
    finishedAt: z.coerce.date().nullable(),
    /** 下一条待导入的全文件行号（0 基，不含表头概念；parquet 行序）。 */
    nextRowOffset: z.number().int().nonnegative(),
    processedRows: z.number().int().nonnegative(),
    /** 已导入行的最小/最大交易日（上海零点）；尚无行时为 null。 */
    minDate: z.coerce.date().nullable(),
    maxDate: z.coerce.date().nullable(),
    /** artifact 总字节数（Range 探测或下载实测）；未知为 null。 */
    artifactBytes: z.number().int().nonnegative().nullable(),
    /** 终态错误归类（SourceErrorKind 词表）与脱敏消息。 */
    errorKind: z.string().min(1).nullable(),
    errorMessage: z.string().max(2000).nullable(),
  })
  .superRefine((run, ctx) => {
    if (run.processedRows > run.nextRowOffset) {
      ctx.addIssue({
        code: 'custom',
        path: ['processedRows'],
        message: 'processedRows 不能大于 nextRowOffset',
      });
    }
    if (run.status === 'complete') {
      if (run.artifactSha256 === null || run.finishedAt === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'complete run 必须有 artifactSha256 与 finishedAt',
        });
      }
    }
    if (run.status === 'failed' && run.errorKind === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['errorKind'],
        message: 'failed run 必须记录 errorKind',
      });
    }
    if (
      run.minDate !== null &&
      run.maxDate !== null &&
      run.minDate.getTime() > run.maxDate.getTime()
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['minDate'],
        message: 'minDate 不能晚于 maxDate',
      });
    }
  });
export type MarketDumpRun = z.infer<typeof MarketDumpRunSchema>;

/** status tool 的对外投影：不含任何下载 URL，只暴露审计字段。 */
export const MarketDumpRunViewSchema = MarketDumpRunSchema;
export type MarketDumpRunView = z.infer<typeof MarketDumpRunViewSchema>;
