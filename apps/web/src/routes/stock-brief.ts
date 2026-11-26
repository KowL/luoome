import { StockBriefPhaseSchema } from '@luoome/core';
import {
  type GenerateStockBriefsOutput,
  type GetForumDigestOutput,
  type GetStockBriefOutput,
  type ListStockBriefsOutput,
  type StockBriefListDegradation,
  stockBriefDegradationOf,
  stockBriefListViewOf,
  stockBriefViewOfDetail,
} from '@luoome/tools';
import type { Hono } from 'hono';
import { z } from 'zod';
import { jsonResult } from '../http/result.js';
import type { WebRouteDeps } from './types.js';

/**
 * 每日个股观察 Web API（design.md §5.2）。
 *
 * 读接口只走 `get_stock_brief` / `list_stock_briefs`（只读本地，不触发生成）；
 * 生成只有一个入口 `POST /api/stock-briefs/generate`，write + external 双闸 + 同源 Origin。
 * 展示投影统一由 `stockBriefViewOf*` 装配，与 CLI 同形。
 */

const DateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional();

const ListQuerySchema = z.object({
  stockId: z.string().trim().min(1).optional(),
  stockIds: z.string().trim().optional(),
  watchlistId: z.string().trim().min(1).optional(),
  date: DateSchema,
  phase: StockBriefPhaseSchema.optional(),
  accountId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const TodayQuerySchema = z.object({
  accountId: z.string().trim().min(1).optional(),
});

const GenerateRequestSchema = z.object({
  scope: z.enum(['all', 'holdings', 'watchlist', 'signals', 'stock']).default('all'),
  stockIds: z.array(z.string().trim().min(1)).max(50).optional(),
  phase: StockBriefPhaseSchema.default('post-market'),
  force: z.boolean().default(false),
});

const pluginDegradation = (deps: WebRouteDeps): StockBriefListDegradation | undefined =>
  stockBriefDegradationOf(deps.ctxRef.current.executionPolicy);

const okData = (data: unknown): Response => jsonResult({ ok: true, data });

/** 讨论摘要只读本地事实；读取失败不阻塞观察列表，只让该区块缺省。 */
const forumOf = async (
  deps: WebRouteDeps,
  input: {
    readonly date?: string;
    readonly phase?: string | undefined;
    readonly stockIds?: readonly string[];
  },
): Promise<GetForumDigestOutput | undefined> => {
  const result = await deps.invokeTool('get_forum_digest', {
    ...(input.date === undefined ? {} : { date: input.date }),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    ...(input.stockIds === undefined ? {} : { stockIds: [...input.stockIds] }),
  });
  return result.ok ? (result.data as GetForumDigestOutput) : undefined;
};

export const registerStockBriefRoutes = (app: Hono, deps: WebRouteDeps): void => {
  const { invokeTool, requireMutationCapabilities } = deps;

  const listOf = async (
    input: Record<string, unknown>,
    degradation?: StockBriefListDegradation,
  ): Promise<ReturnType<typeof stockBriefListViewOf> | Awaited<ReturnType<typeof invokeTool>>> => {
    const listed = await invokeTool('list_stock_briefs', input);
    if (!listed.ok) return listed;
    return stockBriefListViewOf(listed.data as ListStockBriefsOutput, degradation);
  };

  app.get('/api/stock-briefs', async (c) => {
    const parsed = ListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return jsonResult({
        ok: false,
        error: { kind: 'invalid_input', message: '无效的个股观察查询参数', issues: [] },
      });
    }
    const query = parsed.data;
    const stockIds =
      query.stockIds === undefined
        ? undefined
        : query.stockIds
            .split(',')
            .map((id) => id.trim())
            .filter((id) => id.length > 0)
            .slice(0, 50);
    const base = {
      ...(query.date === undefined ? {} : { date: query.date }),
      ...(query.phase === undefined ? {} : { phase: query.phase }),
      ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    };
    const degradation = pluginDegradation(deps);

    if (query.stockId === undefined) {
      const listed = await listOf(
        {
          ...base,
          ...(query.watchlistId === undefined ? {} : { watchlistId: query.watchlistId }),
          ...(stockIds === undefined ? {} : { stockIds }),
        },
        degradation,
      );
      if (!('items' in listed)) return jsonResult(listed);
      const forum = await forumOf(deps, {
        ...(query.date === undefined ? {} : { date: query.date }),
        phase: query.phase ?? listed.items[0]?.phase,
        stockIds: listed.items.map((item) => item.stockId).slice(0, 12),
      });
      return okData({ ...listed, ...(forum === undefined ? {} : { forum }) });
    }

    const detailInput = {
      stockId: query.stockId,
      ...(query.date === undefined ? {} : { date: query.date }),
      ...(query.phase === undefined ? {} : { phase: query.phase }),
      ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
    };
    const [detail, listed] = await Promise.all([
      invokeTool('get_stock_brief', detailInput),
      invokeTool('list_stock_briefs', { ...base, stockIds: [query.stockId] }),
    ]);
    if (!detail.ok) return jsonResult(detail);
    const budget = listed.ok ? (listed.data as ListStockBriefsOutput).budget : undefined;
    const detailDate = (detail.data as GetStockBriefOutput).date ?? budget?.date ?? query.date;
    const forum = await forumOf(deps, {
      ...(detailDate === undefined ? {} : { date: detailDate }),
      phase: query.phase ?? (detail.data as GetStockBriefOutput).phase,
      stockIds: [query.stockId],
    });
    return okData({
      date: (detail.data as GetStockBriefOutput).date ?? budget?.date,
      view: stockBriefViewOfDetail(detail.data as GetStockBriefOutput, budget),
      warnings: (detail.data as GetStockBriefOutput).warnings,
      ...(budget === undefined ? {} : { budget }),
      ...(degradation === undefined ? {} : { degradation }),
      ...(forum === undefined ? {} : { forum }),
    });
  });

  app.get('/api/stock-briefs/today', async (c) => {
    const parsed = TodayQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return jsonResult({
        ok: false,
        error: { kind: 'invalid_input', message: '无效的账户参数', issues: [] },
      });
    }
    const degradation = pluginDegradation(deps);
    const listed = await listOf(
      parsed.data.accountId === undefined ? {} : { accountId: parsed.data.accountId },
      degradation,
    );
    if (!('items' in listed)) return jsonResult(listed);
    const forum = await forumOf(deps, {
      date: listed.date,
      phase: listed.items[0]?.phase,
      stockIds: listed.items.map((item) => item.stockId).slice(0, 12),
    });
    return okData({ ...listed, ...(forum === undefined ? {} : { forum }) });
  });

  app.post('/api/stock-briefs/generate', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied !== null) return jsonResult(denied);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const parsed = GenerateRequestSchema.safeParse(
      typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {},
    );
    if (!parsed.success) {
      return jsonResult({
        ok: false,
        error: { kind: 'invalid_input', message: '无效的生成参数', issues: [] },
      });
    }
    // 手动 Web 入口：source 固定 manual，其余口径与 tool 默认一致。
    const result = await invokeTool('generate_stock_briefs', {
      ...parsed.data,
      source: 'manual',
    });
    // 预算耗尽不是整批失败：仍返回部分结果，仅用 429 标注降级语义。
    if (
      result.ok &&
      (result.data as GenerateStockBriefsOutput).degradation?.reason === 'rate_limited'
    ) {
      return jsonResult(result, 429);
    }
    return jsonResult(result);
  });
};
