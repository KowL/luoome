import { MarketDumpKindSchema, MarketDumpRunViewSchema } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput } from '../define-tool.js';
import { marketDumpManagerOf } from '../internal/market-dump.js';

/**
 * dump 同步状态查询工具（设计 §5.1，read）。
 *
 * 返回 dumpId、文件 hash、行数、日期范围、checkpoint、状态与错误；
 * 绝不返回下载 URL / 本地文件路径（MarketDumpRun 实体本身不携带这些字段）。
 */

export const GetMarketDumpStatusInput = z.object({
  /** 按 kind 过滤；缺省返回全部 kind 的最近运行。 */
  kind: MarketDumpKindSchema.optional(),
  /** 返回最近 N 条 run（按 requestedAt 降序），默认 10，最大 50。 */
  limit: z.number().int().min(1).max(50).default(10),
});

export const GetMarketDumpStatusOutput = z.object({
  runs: z.array(MarketDumpRunViewSchema),
});

export const getMarketDumpStatusTool = defineTool({
  name: 'get_market_dump_status',
  description:
    '查询全市场 dump 同步运行状态：dumpId、artifact SHA-256、已导入行数、日期范围、' +
    'checkpoint（nextRowOffset/processedRows）、recordedAt、状态与脱敏错误。' +
    '不返回预签名下载 URL 或本地文件路径。',
  sideEffect: 'read',
  input: GetMarketDumpStatusInput,
  output: GetMarketDumpStatusOutput,
  handler: async (input, ctx) => {
    const manager = marketDumpManagerOf(ctx);
    if (manager === undefined) {
      return errInvalidInput(
        'get_market_dump_status tool 需要 ctx.marketDump 注入；当前 surface 未配置 market-dump manager（LUOOME_MARKET_DUMP_SOURCES 默认不装配）',
      );
    }
    const runs = await manager.status();
    const filtered = runs
      .filter((run) => input.kind === undefined || run.kind === input.kind)
      .slice(0, input.limit);
    return { runs: filtered };
  },
});
