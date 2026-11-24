import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { ensureStockStub, STOCK_ID_PATTERN } from '../internal/manual-entry.js';
import {
  buildStockFactPack,
  StockFactPackSchema,
  StockFactSectionSchema,
} from '../internal/stock-facts.js';

export const GetStockFactsInput = z.object({
  stockId: z.string().trim().min(1),
  /** 取数锚点；缺省用当前时钟。 */
  asOf: z.coerce.date().optional(),
  /** 只取部分段；缺省返回全部十段。 */
  include: z.array(StockFactSectionSchema).min(1).optional(),
});

export const GetStockFactsOutput = StockFactPackSchema;

/**
 * 个股事实包（design.md §5.1 / §6.1）。
 * 只做信号、观察与研究用途；不产生 advice，也不修改账户或交易。
 */
export const getStockFactsTool = defineTool({
  name: 'get_stock_facts',
  description:
    '获取个股事实包：报价与开盘方向、日线（≥120 根完整）、技术指标门禁、分时、新闻、板块归属与板块行情、策略信号、账户事实、指数行情；' +
    '每段返回 ok（含 dataAsOf/source）或 unavailable（含原因），并附稳定 factDigest。' +
    '仅技术研究，不构成投资建议；分时只读 intraday-minutes，不做形态推断。',
  sideEffect: 'external',
  input: GetStockFactsInput,
  output: GetStockFactsOutput,
  handler: async (input, ctx) => {
    const normalized = input.stockId.trim().toUpperCase();
    let stock =
      (await ctx.repos.stock.findById(normalized)) ??
      (await ctx.repos.stock.findByCode(normalized));
    if (stock === null && STOCK_ID_PATTERN.test(normalized)) {
      await ensureStockStub(normalized, ctx);
      stock = await ctx.repos.stock.findById(normalized);
    } else if (stock !== null && STOCK_ID_PATTERN.test(stock.id)) {
      await ensureStockStub(stock.id, ctx);
      stock = await ctx.repos.stock.findById(stock.id);
    }
    if (stock === null) return errNotFound('Stock', input.stockId);

    const pack = await buildStockFactPack(ctx, {
      stockId: stock.id,
      ...(input.asOf === undefined ? {} : { asOf: input.asOf }),
      ...(input.include === undefined ? {} : { include: input.include }),
    });
    if (pack === null) return errNotFound('Stock', input.stockId);
    return pack;
  },
});
