import type { ToolResult, WatchTriggerSummary } from '@luoome/core';
import type { Hono } from 'hono';
import { z } from 'zod';
import { jsonResult } from '../http/result.js';
import { startOfTodayShanghai } from '../http/time.js';
import type { WebRouteDeps } from './types.js';

export const registerDashboardRoutes = (app: Hono, deps: WebRouteDeps): void => {
  const {
    ctxRef,
    contextForRequest,
    invokeTool,
    applyBatchQuotes,
    invokeIndexQuotes,
    exposeWrite,
  } = deps;

  app.get('/api/dashboard/stocks/:stockId', async (c) => {
    const stockId = c.req.param('stockId');
    const accountId = contextForRequest().user.defaultAccountId;
    const asOf = ctxRef.current.clock();
    const [plans, triggers] = await Promise.all([
      invokeTool('list_trading_plans', { stockId, accountId, activeOnly: false, limit: 200 }),
      invokeTool('list_watch_triggers', {
        stockId,
        since: startOfTodayShanghai(asOf),
        until: asOf,
        limit: 8,
      }),
    ]);
    return jsonResult({
      ok: true,
      data: { plans, triggers, accountId, asOf, canWrite: exposeWrite },
    });
  });

  app.get('/api/dashboard', async (c) => {
    const query = z
      .object({
        scope: z.enum(['all', 'holdings', 'watching', 'triggered']).default('all'),
        watchlistId: z.string().min(1).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(40).default(40),
      })
      .safeParse(c.req.query());
    if (!query.success)
      return jsonResult({
        ok: false,
        error: { kind: 'invalid_input', message: '无效的看板范围或分页参数', issues: [] },
      });
    const accountId = contextForRequest().user.defaultAccountId;
    const { scope, watchlistId, pageSize } = query.data;
    const asOf = ctxRef.current.clock();
    const todayStart = startOfTodayShanghai(asOf);
    const [holdings, watchlists, alertPlans, watch, triggers, advice, recentTriggers, indexQuotes] =
      await Promise.all([
        invokeTool('list_holdings', {}),
        invokeTool('list_watchlists', {}),
        invokeTool('list_alert_plans', { enabledOnly: false }),
        invokeTool('get_watch_status', {}),
        invokeTool('list_watch_triggers', { limit: 8 }),
        invokeTool('get_advice', { limit: 8 }),
        invokeTool('list_watch_triggers', {
          since: todayStart,
          until: asOf,
          limit: 8,
          orderBy: 'priority',
          includeSummary: true,
        }),
        invokeIndexQuotes(),
      ]);
    const warnings: string[] = [];
    const sectionErrors: Record<string, { kind: string }> = {};
    for (const [key, label, result] of [
      ['holdings', '持仓', holdings],
      ['watchlists', '关注列表', watchlists],
      ['alertPlans', '预警计划', alertPlans],
      ['watch', '盯盘状态', watch],
      ['triggers', '近期预警', triggers],
      ['advice', '建议', advice],
      ['todayTriggers', '今日预警', recentTriggers],
    ] as const) {
      if (!result.ok) {
        sectionErrors[key] = { kind: result.error.kind };
        warnings.push(`${label}读取失败（${result.error.kind}）`);
      }
    }
    let indices: { indices: unknown[]; unsupported?: boolean; stale?: boolean } = { indices: [] };
    if (indexQuotes.ok) {
      indices = indexQuotes.data as typeof indices;
    } else {
      warnings.push(`指数行情读取失败（${indexQuotes.error.kind}），指数卡暂不可用`);
    }

    const watchlistRows = (
      (watchlists.ok ? watchlists.data : { items: [] }) as {
        items: Array<{
          watchlist: { id: string; name: string; enabled: boolean };
          sourceHealth: { stale: number };
        }>;
      }
    ).items;
    // Watchlist 详情在一次请求内复用。
    const watchlistDetailCache = new Map<string, Promise<ToolResult<unknown>>>();
    const watchlistDetail = (id: string): Promise<ToolResult<unknown>> => {
      const cached = watchlistDetailCache.get(id);
      if (cached !== undefined) return cached;
      const pending = invokeTool('get_watchlist', { watchlistId: id, accountId });
      watchlistDetailCache.set(id, pending);
      return pending;
    };
    const staleWatchlistCount = watchlists.ok
      ? watchlistRows.filter(({ sourceHealth }) => sourceHealth.stale > 0).length
      : null;

    const todayData = recentTriggers.ok
      ? (recentTriggers.data as {
          triggers: unknown[];
          total: number;
          summary: WatchTriggerSummary;
        })
      : null;
    const todayTriggers = todayData?.triggers ?? [];
    const todaySummary = todayData?.summary;

    // 展示聚合：先合并和筛选身份，再按页请求行情。
    interface BoardItem {
      stockId: string;
      name: string;
      quote: {
        close: number;
        observedAt: unknown;
        retrieval: 'live' | 'local-fallback';
        freshness: 'fresh' | 'stale';
      } | null;
      /** 股价涨跌幅（%）：全行统一由 batch_quote 昨收基准换算，无昨收基准为 null。 */
      changePct: number | null;
      holding: {
        quantity: number;
        marketValue: number;
        todayPnl: number | null;
        todayPnlPct: number | null;
      } | null;
      watchlists: string[];
      watchlistIds: string[];
      sourceKinds: string[];
      todayTrigger: {
        count: number;
        latest: unknown;
        maxPriority: 'urgent' | 'important' | 'normal';
      } | null;
    }
    const holdingRows = (
      (holdings.ok ? holdings.data : { holdings: [] }) as {
        holdings: Array<{
          holding: { stockId: string; quantity: number };
          stockName: string;
          marketValue: number;
          todayPnl: number | null;
          todayPnlPct: number | null;
        }>;
      }
    ).holdings;
    const board = new Map<string, BoardItem>();
    let boardComplete = holdings.ok && watchlists.ok;
    for (const row of holdingRows) {
      board.set(row.holding.stockId, {
        stockId: row.holding.stockId,
        name: row.stockName,
        quote: null,
        changePct: null,
        holding: {
          quantity: row.holding.quantity,
          marketValue: row.marketValue,
          todayPnl: row.todayPnl,
          todayPnlPct: row.todayPnlPct,
        },
        watchlists: [],
        watchlistIds: [],
        sourceKinds: [],
        todayTrigger: null,
      });
    }
    const watchedWatchlists = watchlistRows.filter(({ watchlist }) => watchlist.enabled);
    const watchedDetails = await Promise.all(
      watchedWatchlists.map(async ({ watchlist }) => ({
        watchlist,
        detail: await watchlistDetail(watchlist.id),
      })),
    );
    for (const { watchlist: watchedWatchlist, detail } of watchedDetails) {
      if (!detail.ok) {
        boardComplete = false;
        warnings.push(
          `关注列表「${watchedWatchlist.name}」读取失败（${detail.error.kind}），看板跳过该列表`,
        );
        continue;
      }
      const { watchlist, members } = detail.data as {
        watchlist: { id: string; name: string };
        members: Array<{
          member: { stockId: string };
          sources: Array<{ kind: string; status: string }>;
        }>;
      };
      for (const { member, sources } of members) {
        const sourceKinds = sources
          .filter((source) => source.status !== 'ended')
          .map((source) => source.kind);
        const existing = board.get(member.stockId);
        if (existing !== undefined) {
          existing.watchlists.push(watchlist.name);
          existing.watchlistIds.push(watchlist.id);
          existing.sourceKinds = [...new Set([...existing.sourceKinds, ...sourceKinds])];
        } else {
          board.set(member.stockId, {
            stockId: member.stockId,
            name: '',
            quote: null,
            changePct: null,
            holding: null,
            watchlists: [watchlist.name],
            watchlistIds: [watchlist.id],
            sourceKinds: [...new Set(sourceKinds)],
            todayTrigger: null,
          });
        }
      }
    }
    for (const summary of todaySummary?.stocks ?? []) {
      const item = board.get(summary.stockId);
      const todayTrigger = {
        count: summary.count,
        maxPriority: summary.maxPriority,
        latest: summary.latest,
      };
      if (item !== undefined) {
        item.todayTrigger = todayTrigger;
      } else if (scope === 'triggered') {
        board.set(summary.stockId, {
          stockId: summary.stockId,
          name: '',
          quote: null,
          changePct: null,
          holding: null,
          watchlists: [],
          watchlistIds: [],
          sourceKinds: [],
          todayTrigger,
        });
      }
    }

    const filteredBoard = [...board.values()].filter(
      (item) =>
        (scope !== 'holdings' || item.holding !== null) &&
        (scope !== 'watching' || item.watchlists.length > 0) &&
        (scope !== 'triggered' || item.todayTrigger !== null) &&
        (watchlistId === undefined || item.watchlistIds.includes(watchlistId)),
    );
    filteredBoard.sort(
      (a, b) =>
        Number(b.holding !== null) - Number(a.holding !== null) ||
        a.stockId.localeCompare(b.stockId),
    );
    const page = Math.min(query.data.page, Math.max(1, Math.ceil(filteredBoard.length / pageSize)));
    const pageItems = filteredBoard.slice((page - 1) * pageSize, page * pageSize);
    await applyBatchQuotes(
      new Map(pageItems.map((item) => [item.stockId, item])),
      warnings,
      '看板行情降级为空',
      { updateName: true },
    );
    if (scope === 'triggered' && !recentTriggers.ok) boardComplete = false;
    const priorityCounts = todaySummary?.priorityCounts ?? {};
    const deliveryStatusCounts = todaySummary?.deliveryStatusCounts ?? {};
    const feedbackCounts = todaySummary?.feedbackCounts ?? {};

    // 噪声率（§11）：样本 ≥ 30 才展示，避免误读
    const feedbackTotal = Object.values(feedbackCounts).reduce((s, n) => s + n, 0);
    const noiseRate =
      feedbackTotal >= 30
        ? ((feedbackCounts.useless ?? 0) + (feedbackCounts.ignored ?? 0)) /
          Math.max(feedbackTotal, 1)
        : null;

    // watch.run 摘要（§11）：最近一轮的发送失败 / 抑制分项
    const watchData = (watch.ok ? watch.data : null) as {
      latest?: Record<string, unknown> | null;
    } | null;
    const latestRun = watchData?.latest ?? null;
    const latestSummary =
      typeof latestRun?.outputSummary === 'object' && latestRun.outputSummary !== null
        ? (latestRun.outputSummary as Record<string, unknown>)
        : {};
    const latestNumber = (key: string): number | undefined => {
      const value = latestSummary[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    };

    return jsonResult({
      ok: true,
      data: {
        asOf,
        holdings: holdings.ok ? holdings.data : null,
        watchlists: watchlists.ok ? watchlists.data : null,
        alertPlans: alertPlans.ok ? alertPlans.data : null,
        watch: watch.ok ? watch.data : null,
        triggers: triggers.ok ? triggers.data : null,
        advice: advice.ok ? advice.data : null,
        staleWatchlistCount,
        // 看盘主页：指数条 + 实时看板 + 今日预警列表
        indices,
        board: pageItems,
        boardQuery: { scope, watchlistId: watchlistId ?? null, page, pageSize },
        canWrite: exposeWrite,
        boardCoverage: {
          available:
            (watchlistId === undefined || watchlists.ok) &&
            (scope === 'holdings'
              ? holdings.ok
              : scope === 'watching'
                ? watchlists.ok
                : scope === 'triggered'
                  ? recentTriggers.ok
                  : holdings.ok || watchlists.ok),
          total: filteredBoard.length,
          displayed: pageItems.length,
          truncated: filteredBoard.length > pageItems.length,
          complete: boardComplete,
        },
        todayTriggerCoverage: {
          available: recentTriggers.ok,
          total: recentTriggers.ok ? (recentTriggers.data as { total: number }).total : null,
          sampled: todayTriggers.length,
          totalIsLowerBound: false,
        },
        todayTriggers,
        meta: { warnings, sectionErrors },
        // v0.7 策略预警 dashboard 指标（§11）
        metrics: {
          todayTotal: recentTriggers.ok ? (recentTriggers.data as { total: number }).total : null,
          priorityCounts,
          deliveryStatusCounts,
          feedbackCounts,
          feedbackTotal,
          noiseRate,
          latestRun: latestRun
            ? {
                status: latestRun.status ?? null,
                evaluatedPlans: latestNumber('evaluatedPlans') ?? 0,
                evaluatedStocks: latestNumber('evaluatedStocks') ?? 0,
                triggered: latestNumber('triggered') ?? 0,
                notified: latestNumber('notified') ?? 0,
                channelAccepted: latestNumber('delivered') ?? null,
                deviceDelivered: null,
                unknownRules: latestNumber('unknownRules') ?? null,
                suppressedByCooldown: latestNumber('suppressedByCooldown') ?? 0,
                suppressedByDailyLimit: latestNumber('suppressedByDailyLimit') ?? 0,
                notifyFailed: latestNumber('notifyFailed') ?? 0,
                startedAt: latestRun.startedAt ?? null,
                finishedAt: latestRun.finishedAt ?? null,
                error: latestRun.error ?? null,
              }
            : null,
        },
      },
    });
  });
};
