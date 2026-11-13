import { executeStrictStrategyBacktestTool } from '@luoome/tools';
import type { Hono } from 'hono';
import { z } from 'zod';

const StrictStrategyBacktestRequest = z.object({
  strategyVersionId: z.string().min(1),
  from: z.coerce.date(),
  to: z.coerce.date(),
  initialCash: z.number().positive().default(1_000_000),
  benchmarkStockId: z.string().min(1).default('000300.SH'),
  benchmarkDatasetVersion: z.string().min(1).default('000300.SH:qfq:daily:v1'),
  lotSize: z.number().int().positive().default(100),
  maxPositions: z.number().int().min(1).max(100).default(20),
  costs: z.object({
    commissionBps: z.number().nonnegative().max(100),
    minimumCommission: z.number().nonnegative(),
    sellStampDutyBps: z.number().nonnegative().max(100),
    buySlippageBps: z.number().nonnegative().max(500),
    sellSlippageBps: z.number().nonnegative().max(500),
  }),
});

import { BUILTIN_STRATEGY_TEMPLATES } from '@luoome/core';
import {
  createStrategyObservationCandidatesTool,
  createStrictStrategyBacktestTool,
  syncStrategyWatchlistSubscriptionsTool,
} from '@luoome/tools';
import { jsonResult, notFound } from '../http/result.js';
import type { WebRouteDeps } from './types.js';

export const registerStrategyRoutes = (app: Hono, deps: WebRouteDeps): void => {
  const {
    contextForRequest,
    callTool,
    invokeTool,
    parseJsonObject,
    requireMutationCapabilities,
    targetMutation,
  } = deps;

  const strictBacktestJobs = new Map<string, Promise<void>>();
  const startStrictBacktestJob = (backtestRunId: string, strategyId: string): void => {
    const key = backtestRunId;
    if (strictBacktestJobs.has(key)) return;
    const job = executeStrictStrategyBacktestTool
      .execute({ backtestRunId }, deps.ctxRef.current)
      .then((result) => {
        if (!result.ok || result.data.run.status === 'failed') {
          deps.ctxRef.current.logger.error('web strict backtest job failed', {
            backtestRunId,
            strategyId,
            errorKind: result.ok ? result.data.run.error : result.error.kind,
          });
        }
      })
      .catch((error: unknown) => {
        deps.ctxRef.current.logger.error('web strict backtest job crashed', {
          backtestRunId,
          strategyId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        strictBacktestJobs.delete(key);
      });
    strictBacktestJobs.set(key, job);
  };

  app.get('/api/strategies', (c) => {
    const status = c.req.query('status');
    const owner = c.req.query('owner');
    const filter = {
      ...(status === undefined ? {} : { status }),
      ...(owner === undefined ? {} : { owner }),
    };
    return callTool('list_strategies', {
      ...(Object.keys(filter).length === 0 ? {} : { filter }),
    });
  });
  app.get('/api/strategy-templates', (c) =>
    c.json({
      ok: true,
      data: {
        templates: BUILTIN_STRATEGY_TEMPLATES,
      },
    }),
  );
  app.get('/api/strategy/dsl-catalog', () => callTool('get_strategy_dsl_catalog', {}));
  app.post('/api/strategies', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    const body = await parseJsonObject(c.req.raw);
    if (!('parsed' in body)) return jsonResult(body);
    // 兼容旧 create_strategy 的显式 id：save_strategy_version 用 strategyId 字段归属。
    const { id, ...rest } = body.data;
    return jsonResult(
      await invokeTool('save_strategy_version', {
        ...rest,
        action: 'create-strategy',
        ...(typeof id === 'string' && rest.strategyId === undefined ? { strategyId: id } : {}),
      }),
    );
  });
  app.delete('/api/strategies/:id', (c) =>
    targetMutation(c.req.raw, 'write', 'delete_strategy', {
      strategyId: c.req.param('id'),
    }),
  );
  app.get('/api/strategies/:id', (c) =>
    callTool('get_strategy', { strategyId: c.req.param('id') }),
  );
  app.get('/api/strategies/:id/workspace', (c) =>
    callTool('get_strategy_workspace', { strategyId: c.req.param('id') }),
  );
  app.get('/api/strategies/:id/decision-cycles', (c) => {
    const runId = c.req.query('runId');
    const stockId = c.req.query('stockId');
    const accountId = c.req.query('accountId');
    const limit = c.req.query('limit');
    return callTool('get_strategy_decision_cycles', {
      strategyId: c.req.param('id'),
      ...(accountId === undefined ? {} : { accountId }),
      ...(runId === undefined ? {} : { runId }),
      ...(stockId === undefined ? {} : { stockId }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    });
  });
  app.get('/api/strategies/:id/insights', (c) => {
    const windowDays = c.req.query('windowDays');
    const scope = c.req.query('scope');
    const evaluationSessionId = c.req.query('evaluationSessionId');
    return callTool('get_strategy_insight_facts', {
      strategyId: c.req.param('id'),
      ...(windowDays === undefined ? {} : { windowDays: Number(windowDays) }),
      ...(scope === undefined ? {} : { scope }),
      ...(evaluationSessionId === undefined ? {} : { evaluationSessionId }),
    });
  });
  app.get('/api/strategies/:id/definition-diff', (c) =>
    callTool('compare_strategy_definitions', {
      strategyId: c.req.param('id'),
      ...(c.req.query('fromVersionId') === undefined
        ? {}
        : { fromVersionId: c.req.query('fromVersionId') }),
      ...(c.req.query('toVersionId') === undefined
        ? {}
        : { toVersionId: c.req.query('toVersionId') }),
    }),
  );
  app.post('/api/strategies/:id/insights/generate', (c) =>
    targetMutation(c.req.raw, 'external', 'generate_strategy_insight', {
      strategyId: c.req.param('id'),
    }),
  );
  app.get('/api/strategies/:id/results', (c) => {
    const runId = c.req.query('runId');
    const view = c.req.query('view') ?? 'selected';
    const rankingWindow = c.req.query('rankingWindow');
    const query = c.req.query('query');
    const sort = c.req.query('sort');
    const order = c.req.query('order');
    const offset = c.req.query('offset');
    const limit = c.req.query('limit');
    return callTool('list_strategy_result_views', {
      strategyId: c.req.param('id'),
      view,
      ...(runId === undefined ? {} : { runId }),
      ...(rankingWindow === undefined ? {} : { rankingWindow: Number(rankingWindow) }),
      ...(query === undefined ? {} : { query }),
      ...(sort === undefined ? {} : { sort }),
      ...(order === undefined ? {} : { order }),
      ...(offset === undefined ? {} : { offset: Number(offset) }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    });
  });
  app.post('/api/strategies/:id/versions', (c) =>
    targetMutation(c.req.raw, 'write', 'save_strategy_version', {
      action: 'save-version',
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/validate', (c) =>
    targetMutation(c.req.raw, 'write', 'save_strategy_version', {
      action: 'validate',
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/publish', (c) =>
    targetMutation(c.req.raw, 'write', 'save_strategy_version', {
      action: 'publish',
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/pause', (c) =>
    targetMutation(c.req.raw, 'write', 'pause_strategy', {
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/resume', (c) =>
    targetMutation(c.req.raw, 'write', 'resume_strategy', {
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/run', async (c) => {
    const body = await parseJsonObject(c.req.raw);
    if (!('parsed' in body)) return jsonResult(body);
    const isTrial = body.data.persist === false;
    const denied = requireMutationCapabilities(
      c.req.raw,
      isTrial ? ['external'] : ['write', 'external'],
    );
    if (denied !== null) return jsonResult(denied);
    const run = await invokeTool(isTrial ? 'trial_strategy' : 'run_strategy', {
      ...body.data,
      strategyId: c.req.param('id'),
    });
    if (!run.ok || typeof run.data !== 'object' || run.data === null) return jsonResult(run);
    const payload = run.data as {
      readonly run?: { readonly id?: unknown; readonly status?: unknown };
      readonly persisted?: unknown;
    } & Record<string, unknown>;
    if (
      payload.persisted !== true ||
      typeof payload.run?.id !== 'string' ||
      payload.run.status === 'failed'
    ) {
      return jsonResult(run);
    }
    const observed = await createStrategyObservationCandidatesTool.execute(
      { runId: payload.run.id },
      contextForRequest(),
    );
    const observations = observed.ok
      ? observed.data
      : {
          status: 'failed',
          error:
            'message' in observed.error
              ? observed.error.message
              : 'cause' in observed.error
                ? observed.error.cause
                : observed.error.kind,
        };
    const synced = await syncStrategyWatchlistSubscriptionsTool.execute(
      { strategyId: c.req.param('id'), producerRunId: payload.run.id },
      contextForRequest(),
    );
    return jsonResult({
      ...run,
      data: {
        ...payload,
        observations,
        watchlistSync: synced.ok
          ? synced.data
          : {
              status: 'failed',
              error:
                'message' in synced.error
                  ? synced.error.message
                  : 'cause' in synced.error
                    ? synced.error.cause
                    : synced.error.kind,
            },
      },
    });
  });
  app.get('/api/strategies/:id/watchlists', (c) =>
    callTool('list_strategy_watchlist_subscriptions', {
      strategyId: c.req.param('id'),
      status: c.req.query('status') ?? 'active',
    }),
  );
  app.post('/api/strategies/:id/watchlists', (c) =>
    targetMutation(c.req.raw, 'write', 'subscribe_strategy_to_watchlist', {
      strategyId: c.req.param('id'),
    }),
  );
  app.delete('/api/strategies/:id/watchlists/:watchlistId', (c) =>
    targetMutation(c.req.raw, 'write', 'unsubscribe_strategy_from_watchlist', {
      strategyId: c.req.param('id'),
      watchlistId: c.req.param('watchlistId'),
    }),
  );
  app.get('/api/strategies/:id/strict-backtests', async (c) => {
    const result = await invokeTool('run_strategy_backtest', {
      action: 'list',
      strategyId: c.req.param('id'),
      limit: 50,
    });
    return jsonResult(result);
  });
  app.get('/api/strategies/:id/strict-backtests/:backtestRunId', async (c) => {
    const result = await invokeTool('run_strategy_backtest', {
      action: 'get',
      backtestRunId: c.req.param('backtestRunId'),
    });
    if (!result.ok) return jsonResult(result);
    const data = result.data as { run?: { spec: { strategyId: string } } | null };
    if (data.run == null || data.run.spec.strategyId !== c.req.param('id')) {
      return jsonResult(notFound('StrictStrategyBacktest', c.req.param('backtestRunId')));
    }
    const { action: _action, ...rest } = result.data as Record<string, unknown>;
    return jsonResult({ ok: true, data: rest });
  });
  app.post('/api/strategies/:id/strict-backtests', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write']);
    if (denied !== null) return jsonResult(denied);
    const body = await parseJsonObject(c.req.raw);
    if (!('parsed' in body)) return jsonResult(body);
    const parsed = StrictStrategyBacktestRequest.safeParse(body.data);
    if (!parsed.success) {
      return jsonResult({
        ok: false,
        error: {
          kind: 'invalid_input',
          message: '严格回测参数无效',
          issues: parsed.error.issues,
        },
      });
    }
    const created = await createStrictStrategyBacktestTool.execute(
      { strategyId: c.req.param('id'), ...parsed.data },
      contextForRequest(),
    );
    if (!created.ok) return jsonResult(created);
    if (created.data.run.status === 'queued') {
      startStrictBacktestJob(created.data.run.id, c.req.param('id'));
    }
    return jsonResult(
      { ok: true, data: { run: created.data.run } },
      created.data.run.status === 'queued' ? 202 : 200,
    );
  });
  app.post('/api/strategies/:id/draft', (c) =>
    targetMutation(c.req.raw, 'external', 'propose_strategy_version_draft', {
      strategyId: c.req.param('id'),
    }),
  );
  app.post('/api/strategies/:id/trial', (c) =>
    targetMutation(c.req.raw, 'external', 'trial_strategy_version', {
      strategyId: c.req.param('id'),
    }),
  );
  app.get('/api/strategies/:id/runs', (c) => {
    const scope = c.req.query('scope');
    const publication = c.req.query('publication');
    return callTool('list_strategy_runs', {
      strategyId: c.req.param('id'),
      limit: 50,
      ...(scope === undefined ? {} : { scope }),
      ...(publication === undefined ? {} : { publication }),
    });
  });
  app.get('/api/strategy-runs/compare', (c) => {
    const fromRunId = c.req.query('fromRunId');
    const toRunId = c.req.query('toRunId');
    return callTool('compare_strategy_runs', {
      strategyId: c.req.query('strategyId'),
      ...(fromRunId === undefined ? {} : { fromRunId }),
      ...(toRunId === undefined ? {} : { toRunId }),
    });
  });
  app.get('/api/strategy-runs/:id', (c) =>
    callTool('get_strategy_run', { runId: c.req.param('id') }),
  );

  app.get('/api/strategy/reliability-summary', (c) => {
    const targetTradingDays = Number(c.req.query('targetTradingDays') ?? '30');
    const limit = Number(c.req.query('limit') ?? '1000');
    const strategyId = c.req.query('strategyId')?.trim();
    const scheduleId = c.req.query('scheduleId')?.trim();
    const since = c.req.query('since')?.trim();
    const until = c.req.query('until')?.trim();
    return callTool('get_strategy_reliability_summary', {
      ...(strategyId === undefined || strategyId.length === 0 ? {} : { strategyId }),
      ...(scheduleId === undefined || scheduleId.length === 0 ? {} : { scheduleId }),
      ...(since === undefined || since.length === 0 ? {} : { since }),
      ...(until === undefined || until.length === 0 ? {} : { until }),
      targetTradingDays: Number.isFinite(targetTradingDays) ? targetTradingDays : 30,
      limit: Number.isFinite(limit) ? limit : 1000,
    });
  });
};
