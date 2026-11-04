import { MarketDumpKindSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errAdapterError, errInvalidInput } from '../define-tool.js';
import { marketDumpManagerOf } from '../internal/market-dump.js';

/**
 * 全市场 dump 同步工具（设计 §5.1）。
 *
 * - sideEffect: 'external' + requiredCapabilities ['external','write']：
 *   访问外部 download-url 与预签名 artifact 下载，同时写本地 dump 事实链；
 * - 一次只同步一种 dump、一次有界运行；支持 resumeRunId 显式断点续传；
 * - 结果绝不携带 presignedUrl / 本地文件路径；错误消息已由 manager 脱敏；
 * - raw 日 K 只写 raw_daily_bar_revisions，公司行动只写 corporate_action_event_revisions；
 *   不触碰账户账本、规范 daily_bars 或回测门禁。
 */

export const SyncMarketDumpInput = z.object({
  kind: MarketDumpKindSchema,
  /** 显式指定要恢复的 running run；缺省按 kind 自动发现最新 running run。 */
  resumeRunId: z.string().trim().min(1).optional(),
});

export const SyncMarketDumpOutput = z.object({
  runId: z.string(),
  kind: MarketDumpKindSchema,
  dumpId: z.string(),
  artifactSha256: z.string(),
  status: z.enum(['complete', 'failed']),
  resumed: z.boolean(),
  processedRows: z.number().int().nonnegative(),
  nextRowOffset: z.number().int().nonnegative(),
  minDate: z.coerce.date().nullable(),
  maxDate: z.coerce.date().nullable(),
  recordedAt: z.coerce.date(),
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date(),
  errorKind: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

export const syncMarketDumpTool = defineTool({
  name: 'sync_market_dump',
  description:
    '同步一种全市场 dump（daily-k 约 10 年全 A 原始日 K / daily-k-10d 最近 10 交易日增量 / ' +
    'adjustment-factors 全量分红送股配股事件）到本地 append-only 事实链。' +
    '下载 → 分批导入 → checkpoint 恢复；同 artifact 重跑幂等，内容变化开新 run。' +
    '原始日 K 与公司行动事件带 recordedAt PIT 记录时间，不回改过去 cutoff 已可见的数据。',
  sideEffect: 'external',
  requiredCapabilities: ['external', 'write'],
  input: SyncMarketDumpInput,
  output: SyncMarketDumpOutput,
  handler: async (input, ctx) => {
    const manager = marketDumpManagerOf(ctx);
    if (manager === undefined) {
      return errInvalidInput(
        'sync_market_dump tool 需要 ctx.marketDump 注入；当前 surface 未配置 market-dump manager（LUOOME_MARKET_DUMP_SOURCES 默认不装配）',
      );
    }
    try {
      return await manager.sync({
        kind: input.kind,
        ...(input.resumeRunId === undefined ? {} : { resumeRunId: input.resumeRunId }),
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return errAdapterError('market-dump', cause, true);
    }
  },
});

// 注册：`toolRegistry` 与 `WorkflowToolMap` 都需要补这一行。
export const _MarketDumpWorkflowToolMapEntries = {
  sync_market_dump: syncMarketDumpTool,
} as const satisfies Record<string, ReturnType<typeof defineTool>>;
