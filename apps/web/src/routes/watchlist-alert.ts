import type { ToolResult } from '@luoome/core';
import { resolveWatchNotificationTool } from '@luoome/tools';
import { runIntradayWatchObserved } from '@luoome/workflows';
import type { Hono } from 'hono';
import { intQuery } from '../http/query.js';
import { jsonResult } from '../http/result.js';
import type { WebRouteDeps } from './types.js';

export const registerWatchlistAlertRoutes = (app: Hono, deps: WebRouteDeps): void => {
  const {
    ctxRef,
    contextForRequest,
    callTool,
    invokeTool,
    requireMutationCapabilities,
    targetMutation,
    bindDecisionAccount,
    applyBatchQuotes,
  } = deps;

  app.get('/api/watch/notifications/:triggerId', async (c) =>
    jsonResult(
      await resolveWatchNotificationTool.execute(
        { triggerId: c.req.param('triggerId') },
        contextForRequest(),
      ),
    ),
  );
  app.get('/api/trading-plans', (c) => {
    const input: Record<string, unknown> = {
      accountId: contextForRequest().user.defaultAccountId,
      activeOnly: c.req.query('activeOnly') !== 'false' && c.req.query('currentOnly') !== 'true',
      includeMonitoring: c.req.query('includeMonitoring') === 'true',
      currentOnly: c.req.query('currentOnly') === 'true',
    };
    for (const key of ['accountId', 'stockId', 'status'] as const) {
      const value = c.req.query(key);
      if (value !== undefined && value.length > 0) input[key] = value;
    }
    const limit = Number(c.req.query('limit'));
    if (Number.isInteger(limit) && limit > 0) input.limit = Math.min(limit, 500);
    // S4：list_watch_plans 合并 trading plan 查询；includeAlertPlans=false 保持原响应形状。
    return callTool('list_watch_plans', { ...input, includeAlertPlans: false });
  });

  app.get('/api/trading-plans/:versionId', (c) =>
    callTool('get_trading_plan', { versionId: c.req.param('versionId') }),
  );

  app.get('/api/watchlists', () => callTool('list_watchlists', {}));
  app.post('/api/watchlists', (c) => targetMutation(c.req.raw, 'write', 'create_watchlist'));

  /**
   * Watchlist 总览聚合（PRD §10.1）：一次请求组装主视图与已归档弹窗所需数据，
   * 前端按 tab 派生，切换视图不重复拉取。照 /api/dashboard 模式：
   * invokeTool + 请求内缓存；单列表 detail/changes 失败降级为警告，不拖垮整个端点。
   * 「已归档列表」= enabled=false：core Watchlist 无 archivedAt，repo.archive 即停用。
   */
  app.get('/api/watchlists/overview', async () => {
    interface OverviewWatchlist {
      id: string;
      name: string;
      kind: string;
      membershipPolicy: string;
      enabled: boolean;
    }
    interface OverviewMember {
      member: {
        id: string;
        watchlistId: string;
        stockId: string;
        stage: string;
        priority: string;
        archivedAt?: unknown;
        firstAddedAt?: string | Date;
      };
      sources: Array<{ kind: string; status: string; dataAsOf?: unknown }>;
    }
    interface OverviewRun {
      startedAt: string | Date;
      finishedAt?: string | Date;
      enteredCount?: number;
      exitedCount?: number;
    }
    const warnings: string[] = [];
    // 「今日」按服务器本地日期（与快照的落库时间同一口径）。
    const now = ctxRef.current.clock();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const [watchlistsResult, triggersResult] = await Promise.all([
      invokeTool('list_watchlists', {}),
      invokeTool('list_watch_triggers', { limit: 200 }),
    ]);
    if (!watchlistsResult.ok) return jsonResult(watchlistsResult);
    const rows = (
      watchlistsResult.data as {
        items: Array<{
          watchlist: OverviewWatchlist;
          memberCount: number;
          sourceHealth: { active: number; stale: number };
        }>;
      }
    ).items;

    // Watchlist 详情 / 同步变化在一次请求内复用。
    const detailCache = new Map<string, Promise<ToolResult<unknown>>>();
    const detailOf = (id: string): Promise<ToolResult<unknown>> => {
      const cached = detailCache.get(id);
      if (cached !== undefined) return cached;
      const pending = invokeTool('get_watchlist', {
        watchlistId: id,
        includeArchivedMembers: true,
      });
      detailCache.set(id, pending);
      return pending;
    };
    const changesCache = new Map<string, Promise<ToolResult<unknown>>>();
    const changesOf = (id: string): Promise<ToolResult<unknown>> => {
      const cached = changesCache.get(id);
      if (cached !== undefined) return cached;
      const pending = invokeTool('list_watchlist_changes', { watchlistId: id, limit: 50 });
      changesCache.set(id, pending);
      return pending;
    };

    interface TodayChange {
      watchlistId: string;
      watchlistName: string;
      stockId: string;
      direction: 'entered' | 'exited';
      reason: string;
      at: string;
    }
    interface StockMembership {
      watchlistId: string;
      watchlistName: string;
      stage: string;
      priority: string;
      sources: OverviewMember['sources'];
      holding: boolean;
    }
    const lists: Array<Record<string, unknown>> = [];
    interface OverviewStock {
      stockId: string;
      /** 股票名称；batch_quote 成功前暂为 stockId。 */
      name: string;
      quote: {
        close: number;
        observedAt: unknown;
        retrieval: 'live' | 'local-fallback';
        freshness: 'fresh' | 'stale';
      } | null;
      /** 涨跌幅（%）：与 dashboard 看板同口径，batch_quote 昨收基准换算，无基准为 null。 */
      changePct: number | null;
      memberships: StockMembership[];
    }
    const stocksById = new Map<string, OverviewStock>();
    const todayChanges: TodayChange[] = [];
    const archivedLists: OverviewWatchlist[] = [];
    const archivedMembers: Array<Record<string, unknown>> = [];

    for (const { watchlist, memberCount, sourceHealth } of rows) {
      if (!watchlist.enabled) archivedLists.push(watchlist);
      let members: OverviewMember[] = [];
      const detail = await detailOf(watchlist.id);
      if (detail.ok) {
        members = (detail.data as { members: OverviewMember[] }).members;
      } else {
        warnings.push(
          `get_watchlist(${watchlist.id}) 失败（${detail.error.kind}），总览跳过该列表成员`,
        );
      }
      let todayEntered = 0;
      let todayExited = 0;
      const changes = await changesOf(watchlist.id);
      if (changes.ok) {
        // S4：WatchlistSyncRun 只保留计数，不再复制逐股 snapshot；
        // 今日变化按当日新增成员补充（含方向与来源说明）。
        for (const run of (changes.data as { runs: OverviewRun[] }).runs) {
          const at = new Date(run.finishedAt ?? run.startedAt);
          if (at < todayStart) continue;
          todayEntered += run.enteredCount ?? 0;
          todayExited += run.exitedCount ?? 0;
        }
        for (const { member } of members) {
          if (member.stage === 'archived') continue;
          if (member.firstAddedAt === undefined) continue;
          const addedAt = new Date(member.firstAddedAt);
          if (addedAt < todayStart) continue;
          todayEntered += 1;
          todayChanges.push({
            watchlistId: watchlist.id,
            watchlistName: watchlist.name,
            stockId: member.stockId,
            direction: 'entered',
            reason: '今日新增成员',
            at: addedAt.toISOString(),
          });
        }
      } else if (changes.error.kind !== 'not_found') {
        warnings.push(
          `list_watchlist_changes(${watchlist.id}) 失败（${changes.error.kind}），今日变化降级为空`,
        );
      }
      const activeMembers = members.filter(({ member }) => member.stage !== 'archived');
      lists.push({
        watchlist,
        memberCount,
        discoveredCount: activeMembers.filter(({ member }) => member.stage === 'discovered').length,
        sourceHealth,
        todayEntered,
        todayExited,
      });
      for (const { member, sources } of members) {
        if (member.stage === 'archived') {
          archivedMembers.push({
            watchlistId: watchlist.id,
            watchlistName: watchlist.name,
            member,
          });
          continue;
        }
        const entry = stocksById.get(member.stockId) ?? {
          stockId: member.stockId,
          name: member.stockId,
          quote: null,
          changePct: null,
          memberships: [],
        };
        entry.memberships.push({
          watchlistId: watchlist.id,
          watchlistName: watchlist.name,
          stage: member.stage,
          priority: member.priority,
          sources,
          holding: sources.some(
            (source) => source.kind === 'portfolio' && source.status === 'active',
          ),
        });
        stocksById.set(member.stockId, entry);
      }
    }

    interface OverviewTrigger {
      stockId: string;
      priority: string;
      ruleKind: string;
      reason: string;
      createdAt: string;
    }
    let triggers: OverviewTrigger[] = [];
    if (triggersResult.ok) {
      triggers = (triggersResult.data as { triggers: OverviewTrigger[] }).triggers;
    } else {
      warnings.push(`list_watch_triggers 失败（${triggersResult.error.kind}），触发摘要降级为空`);
    }
    // list_watch_triggers 按 createdAt 倒序，首次出现即该股最新一条。
    const latestByStock: Record<
      string,
      { at: string; ruleKind: string; priority: string; reason: string }
    > = {};
    for (const trigger of triggers) {
      if (latestByStock[trigger.stockId] !== undefined) continue;
      latestByStock[trigger.stockId] = {
        at: trigger.createdAt,
        ruleKind: trigger.ruleKind,
        priority: trigger.priority,
        reason: trigger.reason,
      };
    }

    // 成员股票行情：照 /api/dashboard 看板模式一次 batch_quote 聚合，
    // 整体失败降级为 quote=null，不拖垮总览端点。
    await applyBatchQuotes(stocksById, warnings, '总览行情降级为空', { updateName: true });

    return jsonResult({
      ok: true,
      data: {
        lists,
        stocks: [...stocksById.values()],
        todayChanges,
        archived: { lists: archivedLists, members: archivedMembers },
        triggers: {
          urgentImportantCount: triggers.filter(
            (trigger) => trigger.priority === 'urgent' || trigger.priority === 'important',
          ).length,
          latestByStock,
        },
        meta: { warnings },
      },
    });
  });

  app.get('/api/watchlist-changes', (c) => {
    const watchlistId = c.req.query('watchlistId');
    if (typeof watchlistId !== 'string' || watchlistId.trim().length === 0) {
      return jsonResult({
        ok: false,
        error: { kind: 'invalid_input', message: '缺少 watchlistId 参数', issues: [] },
      });
    }
    return callTool('list_watchlist_changes', {
      watchlistId,
      limit: intQuery(c.req.query('limit'), 50, 1),
    });
  });

  app.get('/api/watchlists/:id', (c) =>
    callTool('get_watchlist', { watchlistId: c.req.param('id') }),
  );
  app.patch('/api/watchlists/:id', (c) =>
    targetMutation(c.req.raw, 'write', 'update_watchlist', {
      watchlistId: c.req.param('id'),
    }),
  );
  app.post('/api/watchlists/:id/archive', (c) =>
    targetMutation(c.req.raw, 'write', 'archive_watchlist', {
      watchlistId: c.req.param('id'),
    }),
  );
  app.post('/api/watchlists/:id/members', (c) =>
    targetMutation(c.req.raw, 'write', 'add_watchlist_member', {
      watchlistId: c.req.param('id'),
    }),
  );
  app.post('/api/watchlists/:id/members/batch', (c) =>
    targetMutation(c.req.raw, 'write', 'add_watchlist_members', {
      watchlistId: c.req.param('id'),
    }),
  );
  app.patch('/api/watchlists/:id/members/:stockId', (c) =>
    targetMutation(c.req.raw, 'write', 'update_watchlist_member', {
      watchlistId: c.req.param('id'),
      stockId: c.req.param('stockId'),
    }),
  );
  app.post('/api/watchlists/:id/members/:stockId/archive', (c) =>
    targetMutation(c.req.raw, 'write', 'archive_watchlist_member', {
      watchlistId: c.req.param('id'),
      stockId: c.req.param('stockId'),
    }),
  );

  app.get('/api/alert-plans', (c) =>
    callTool('list_alert_plans', {
      enabledOnly: c.req.query('enabledOnly') === 'true',
      ...(c.req.query('watchlistId') === undefined
        ? {}
        : { watchlistId: c.req.query('watchlistId') }),
    }),
  );
  app.post('/api/alert-plans', (c) => targetMutation(c.req.raw, 'write', 'save_alert_plan'));
  app.patch('/api/alert-plans/:id', (c) =>
    targetMutation(c.req.raw, 'write', 'save_alert_plan', {
      alertPlanId: c.req.param('id'),
    }),
  );
  app.delete('/api/alert-plans/:id', (c) =>
    targetMutation(c.req.raw, 'write', 'delete_alert_plan', {
      alertPlanId: c.req.param('id'),
    }),
  );

  app.get('/api/watch/status', (c) => {
    const interval = Number(c.req.query('interval') ?? 60);
    return callTool('get_watch_status', {
      expectedIntervalSeconds: Number.isFinite(interval) ? interval : 60,
    });
  });
  app.get('/api/watch/triggers', (c) => {
    const input: Record<string, unknown> = {};
    for (const key of [
      'alertPlanId',
      'poolId',
      'stockId',
      'ruleKind',
      'ruleId',
      'since',
      'until',
      'priority',
      'feedback',
      'triggerType',
    ]) {
      const value = c.req.query(key);
      if (value !== undefined) input[key] = value;
    }
    const notified = c.req.query('notified');
    if (notified !== undefined) {
      input.notified =
        notified === 'true' || notified === '1'
          ? true
          : notified === 'false' || notified === '0'
            ? false
            : notified;
    }
    const deliveryStatus = c.req.query('deliveryStatus');
    if (deliveryStatus !== undefined) input.deliveryStatus = deliveryStatus.split(',');
    for (const key of ['limit', 'offset']) {
      const value = c.req.query(key);
      if (value !== undefined) input[key] = value.trim() === '' ? value : Number(value);
    }
    return callTool('list_watch_triggers', input);
  });

  /**
   * 反馈写入（v0.7 策略预警）。
   * 调 set_watch_trigger_feedback；幂等；triggerId 不存在 → 404。
   */
  app.post('/api/watch/triggers/:id/feedback', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    const id = c.req.param('id');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const feedback = (body as { feedback?: unknown }).feedback;
    if (
      feedback !== 'handled' &&
      feedback !== 'useful' &&
      feedback !== 'useless' &&
      feedback !== 'ignored'
    ) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'feedback 必须是 handled / useful / useless / ignored',
          issues: [],
        },
      });
    }
    const bound = bindDecisionAccount(c.req.raw, { triggerId: id, feedback });
    if ('denied' in bound) return jsonResult(bound.denied);
    return jsonResult(await invokeTool('set_watch_trigger_feedback', bound.input));
  });

  app.post('/api/watch/run-once', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['external']);
    if (denied !== null) return jsonResult(denied);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const input =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>) }
        : { notify: false };
    return jsonResult(await runIntradayWatchObserved(input, contextForRequest(), 'once'));
  });
};
