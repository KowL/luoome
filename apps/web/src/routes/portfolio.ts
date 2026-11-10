import {
  auditPortfolioPerformanceSnapshotsTool,
  getAccountPerformanceTool,
  listPortfolioPerformanceSnapshotsTool,
} from '@luoome/tools';
import type { Context, Hono } from 'hono';
import { jsonResult } from '../http/result.js';
import type { WebRouteDeps } from './types.js';

export const registerPortfolioRoutes = (app: Hono, deps: WebRouteDeps): void => {
  const {
    ctxRef,
    contextForRequest,
    callTool,
    invokeTool,
    requireMutationCapabilities,
    mutationPermission,
    targetMutation,
  } = deps;

  app.get('/api/accounts', () => callTool('list_accounts', {}));

  const accountPerformanceResponse = async (c: Context, accountId: string): Promise<Response> => {
    const denied = requireMutationCapabilities(c.req.raw, ['external']);
    if (denied !== null) return jsonResult(denied);
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from === undefined || to === undefined) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'from 和 to 必填（YYYY-MM-DD）',
          issues: [],
        },
      });
    }
    return jsonResult(
      await getAccountPerformanceTool.execute(
        {
          accountId,
          from,
          to,
          ...(c.req.query('benchmarkStockId') === undefined
            ? {}
            : { benchmarkStockId: c.req.query('benchmarkStockId') }),
        },
        contextForRequest(),
      ),
    );
  };
  app.get('/api/account/performance', (c) =>
    accountPerformanceResponse(c, contextForRequest().user.defaultAccountId),
  );
  app.get('/api/accounts/:id/performance', (c) => accountPerformanceResponse(c, c.req.param('id')));
  const accountPerformanceSnapshotsResponse = async (
    c: Context,
    accountId: string,
  ): Promise<Response> =>
    jsonResult(
      await listPortfolioPerformanceSnapshotsTool.execute(
        {
          accountId,
          ...(c.req.query('limit') === undefined ? {} : { limit: c.req.query('limit') }),
        },
        contextForRequest(),
      ),
    );
  app.get('/api/account/performance/snapshots', (c) =>
    accountPerformanceSnapshotsResponse(c, contextForRequest().user.defaultAccountId),
  );
  app.get('/api/accounts/:id/performance/snapshots', (c) =>
    accountPerformanceSnapshotsResponse(c, c.req.param('id')),
  );
  const accountPerformanceSnapshotAuditResponse = async (
    c: Context,
    accountId: string,
  ): Promise<Response> => {
    const from = c.req.query('from');
    const to = c.req.query('to');
    if (from === undefined || to === undefined) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'from 和 to 必填（YYYY-MM-DD）',
          issues: [],
        },
      });
    }
    return jsonResult(
      await auditPortfolioPerformanceSnapshotsTool.execute(
        {
          accountId,
          from,
          to,
          ...(c.req.query('limit') === undefined ? {} : { limit: c.req.query('limit') }),
        },
        contextForRequest(),
      ),
    );
  };
  app.get('/api/account/performance/snapshot-audit', (c) =>
    accountPerformanceSnapshotAuditResponse(c, contextForRequest().user.defaultAccountId),
  );
  app.get('/api/accounts/:id/performance/snapshot-audit', (c) =>
    accountPerformanceSnapshotAuditResponse(c, c.req.param('id')),
  );

  /**
   * 切换当前激活账户：浏览器把账户 id 保存到 localStorage，后续请求通过
   * X-Luoome-Account-Id 形成 request-scoped 账户上下文；无 header 的本地调用仍兼容共享默认账户。
   */
  app.post('/api/account/select', async (c) => {
    // 该路由不写 db，但仍是 mutation，应与 /api/tools/:name/call 的 write/external 守卫一致。
    const denied = mutationPermission(c.req.raw);
    if (denied !== null) return jsonResult(denied);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '请求体必须是合法 JSON',
          issues: [],
        },
      });
    }
    const parsed = body as { accountId?: unknown };
    if (typeof parsed.accountId !== 'string' || parsed.accountId.length === 0) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: 'accountId 必填且为非空字符串',
          issues: [],
        },
      });
    }
    const accountResult = await invokeTool('list_accounts', {});
    if (!accountResult.ok) return jsonResult(accountResult);
    const accounts = (accountResult.data as { accounts: Array<{ id: string; name: string }> })
      .accounts;
    const target = accounts.find((a) => a.id === parsed.accountId);
    if (target === undefined) {
      return jsonResult({
        ok: false,
        error: { kind: 'not_found', entity: 'Account', id: parsed.accountId },
      });
    }
    ctxRef.current = {
      ...ctxRef.current,
      user: { ...ctxRef.current.user, defaultAccountId: target.id },
    };
    return jsonResult({
      ok: true,
      data: { currentAccountId: target.id, account: target },
    });
  });

  // S4.1b：账户/账户事实/现金对账/创建账户改为专用路由（App Service 直执行）。
  app.get('/api/account', () => callTool('get_account', {}));
  app.get('/api/account/facts', () => callTool('get_account_facts', {}));
  app.post('/api/account/facts', () => callTool('get_account_facts', {}));
  app.post('/api/account/cash-reconcile', () => callTool('reconcile_account_cash', {}));
  app.post('/api/accounts', (c) => targetMutation(c.req.raw, 'write', 'create_account'));

  app.get('/api/holdings', () => callTool('list_holdings', {}));

  app.get('/api/trades', (c) => {
    const input: Record<string, unknown> = {};
    const stockId = c.req.query('stockId');
    const since = c.req.query('since');
    const until = c.req.query('until');
    const side = c.req.query('side');
    const limit = c.req.query('limit');
    const cursor = c.req.query('cursor');
    const asOf = c.req.query('asOf');
    if (cursor !== undefined) input.cursor = cursor;
    if (asOf !== undefined) input.asOf = asOf;
    if (stockId !== undefined) input.stockId = stockId;
    if (since !== undefined) input.since = since;
    if (until !== undefined) input.until = until;
    if (side !== undefined) input.side = side;
    if (limit !== undefined) input.limit = Number(limit);
    return callTool('list_trades', input);
  });
};
