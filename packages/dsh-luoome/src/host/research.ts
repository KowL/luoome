import type {
  Strategy,
  StrategyEvaluationSession,
  StrategyVersion,
  ToolResult,
} from '@luoome/core';
import type { PluginPrincipal } from '@luoome/tools';
import { z } from 'zod';
import { denied, invalidInput, type ReadSurface } from './read-surface.js';
import type { ResearchContinuity } from './research-status.js';
import type { RequestAdmission } from './routes.js';

const id = z.string().trim().min(1).max(200);
const date = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const stockIds = z
  .string()
  .max(12_000)
  .transform((value) => value.split(',').map((part) => part.trim()))
  .pipe(
    z
      .array(z.string().regex(/^\d{6}\.(SH|SZ)$/))
      .min(1)
      .max(500),
  );
const scope = { strategyId: id, accountId: id.optional() };
const contextScope = {
  baseVersionId: id.optional(),
  candidateVersionId: id.optional(),
  trainingSessionId: id.optional(),
  validationSessionId: id.optional(),
};

export const ResearchReadQuery = z.discriminatedUnion('view', [
  z.object({ view: z.literal('onboarding'), accountId: id.optional() }).strict(),
  z.object({ view: z.literal('context'), ...scope, ...contextScope }).strict(),
  z.object({ view: z.literal('state'), ...scope }).strict(),
  z.object({ view: z.literal('sessions'), ...scope }).strict(),
  z.object({ view: z.literal('validation'), ...scope, sessionId: id }).strict(),
  z.object({ view: z.literal('manifest'), ...scope, versionId: id }).strict(),
  z.object({ view: z.literal('backtests'), ...scope }).strict(),
  z.object({ view: z.literal('backtest'), ...scope, versionId: id, backtestRunId: id }).strict(),
  z.object({ view: z.literal('updates'), ...scope, versionId: id.optional() }).strict(),
  z
    .object({
      view: z.literal('preflight'),
      ...scope,
      versionId: id,
      from: date,
      to: date,
      stockIds: stockIds.optional(),
      revisionCutoff: instant.optional(),
      benchmarkStockId: z
        .string()
        .regex(/^\d{6}\.(SH|SZ)$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      view: z.literal('diagnostics'),
      ...scope,
      versionId: id,
      runId: id,
      kind: z.enum(['selected', 'rule-near-miss', 'ranking-near-miss', 'incomplete', 'excluded']),
      query: z.string().trim().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    })
    .strict(),
]);

export interface ResearchReadOptions {
  readonly read: ReadSurface;
  readonly principal: () => PluginPrincipal | null;
  readonly admit: RequestAdmission;
  readonly now: () => number;
  readonly continuity: (
    principal: PluginPrincipal,
    strategyId: string,
    signal: AbortSignal,
  ) => Promise<ResearchContinuity>;
  readonly jobStatus?: (sessionId: string) => 'running' | 'idle';
}

const respond = (result: ToolResult<unknown>, status = 200) =>
  Response.json(result, { status, headers: { 'cache-control': 'no-store' } });

const notFound = (entity: string, value: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'not_found', entity, id: value },
});

export const createResearchReadHandler = (options: ResearchReadOptions) => {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      const response = respond(invalidInput('GET required'), 405);
      response.headers.set('allow', 'GET');
      return response;
    }
    let principal: PluginPrincipal | null;
    try {
      const rejection = await options.admit(request);
      if (rejection) return rejection;
      principal = options.principal();
    } catch {
      return respond(denied('host authentication'), 403);
    }
    if (!principal) return respond(denied('host authentication'), 403);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some((key) => query.getAll(key).length !== 1))
      return respond(invalidInput('Duplicate research query parameter'), 400);
    const parsed = ResearchReadQuery.safeParse(Object.fromEntries(query));
    if (!parsed.success) return respond(invalidInput('Invalid research query'), 400);
    const input = parsed.data;
    if (input.accountId !== undefined && input.accountId !== principal.accountId)
      return respond(denied('current owner account'), 403);
    const signal = request.signal;
    const invoke = (tool: string, args: Record<string, unknown> = {}) =>
      options.read.invoke(tool, args, signal);
    const envelope = (data: Record<string, unknown>) =>
      respond({
        ok: true,
        data: {
          view: input.view,
          accountId: principal.accountId,
          asOf: new Date(options.now()).toISOString(),
          ...('strategyId' in input ? { strategyId: input.strategyId } : {}),
          ...data,
        },
      });
    if (input.view === 'onboarding') {
      const [account, strategies, market, universe] = await Promise.all([
        invoke('get_account', { accountId: principal.accountId }),
        invoke('list_strategies'),
        invoke('get_market_data_status'),
        invoke('get_stock_universe_status'),
      ]);
      return envelope({
        account,
        strategies,
        market,
        universe,
        steps: [
          {
            action: 'choose-question',
            title: '写下一条可被反证的研究问题',
            requiresApproval: false,
          },
          {
            action: 'choose-baseline',
            title: '选择已有策略与不可变基线版本',
            requiresApproval: false,
          },
          { action: 'check-data', title: '检查样本、区间及数据资格', requiresApproval: false },
          { action: 'save-candidate', title: '保存候选并独立校验', requiresApproval: true },
          { action: 'compare', title: '用同一事实快照对照并保存结论', requiresApproval: true },
        ],
        limitations: ['初始化不会创建账户、持仓、示例投资资产、日程、授权或通知。'],
      });
    }

    const definition = await invoke('get_strategy', { strategyId: input.strategyId });
    if (!definition.ok) return respond(definition);
    const { strategy, versions } = definition.data as {
      strategy: Strategy;
      versions: StrategyVersion[];
    };
    const checkVersion = (versionId: string): ToolResult<never> | null =>
      versions.some((version) => version.id === versionId && version.strategyId === strategy.id)
        ? null
        : notFound('StrategyVersion', versionId);
    for (const key of ['versionId', 'baseVersionId', 'candidateVersionId'] as const) {
      if (key in input) {
        const versionId = input[key as keyof typeof input];
        if (typeof versionId === 'string') {
          const rejection = checkVersion(versionId);
          if (rejection) return respond(rejection, 400);
        }
      }
    }
    const sessionIds =
      input.view === 'validation'
        ? [input.sessionId]
        : input.view === 'context'
          ? [input.trainingSessionId, input.validationSessionId].filter(
              (value): value is string => value !== undefined,
            )
          : [];
    let checkedSession: ToolResult<unknown> | undefined;
    for (const sessionId of sessionIds) {
      const result = await invoke('get_strategy_evaluation_session', { sessionId });
      if (!result.ok) return respond(result);
      const session = (result.data as { session: StrategyEvaluationSession | null }).session;
      if (session === null || session.strategyId !== input.strategyId)
        return respond(notFound('StrategyEvaluationSession', sessionId), 404);
      if (
        input.view === 'context' &&
        input.validationSessionId === sessionId &&
        input.candidateVersionId !== undefined &&
        session.strategyVersionId !== input.candidateVersionId
      )
        return respond(
          invalidInput('Validation session does not match the candidate version'),
          400,
        );
      checkedSession = result;
    }

    switch (input.view) {
      case 'context': {
        const { view: _view, accountId: _accountId, ...args } = input;
        return envelope({ context: await invoke('get_strategy_experiment_context', args) });
      }
      case 'state':
        return envelope({
          state: await invoke('get_strategy_research_state', {
            strategyId: input.strategyId,
            accountId: principal.accountId,
          }),
        });
      case 'sessions':
        return envelope({
          sessions: await invoke('list_strategy_evaluation_sessions', {
            strategyId: input.strategyId,
            limit: 50,
          }),
        });
      case 'validation': {
        const [days, progress] = await Promise.all([
          invoke('list_strategy_evaluation_days', { sessionId: input.sessionId }),
          invoke('get_strategy_evaluation_progress', {
            strategyId: input.strategyId,
            sessionId: input.sessionId,
          }),
        ]);
        return envelope({
          session: checkedSession,
          days,
          progress,
          worker: options.jobStatus?.(input.sessionId) ?? 'idle',
          recovery: 'An idle running session requires an explicitly approved resume operation.',
        });
      }
      case 'manifest':
        return envelope({
          manifest: await invoke('export_strategy_manifest', { versionId: input.versionId }),
        });
      case 'backtests':
        return envelope({
          backtests: await invoke('list_strict_strategy_backtests', {
            strategyId: input.strategyId,
            limit: 50,
          }),
        });
      case 'backtest': {
        const result = await invoke('get_strict_strategy_backtest', {
          backtestRunId: input.backtestRunId,
        });
        if (!result.ok) return respond(result);
        const run = (
          result.data as { run: { spec: { strategyId: string; strategyVersionId: string } } | null }
        ).run;
        if (run === null)
          return respond(notFound('StrictStrategyBacktest', input.backtestRunId), 404);
        if (
          run.spec.strategyId !== input.strategyId ||
          run.spec.strategyVersionId !== input.versionId
        )
          return respond(
            invalidInput('Strict backtest does not match the bound strategy version'),
            400,
          );
        return envelope({
          backtest: result,
          worker: options.jobStatus?.(`strict:${input.backtestRunId}`) ?? 'idle',
        });
      }
      case 'preflight': {
        if (input.from > input.to) return respond(invalidInput('from must be before to'), 400);
        const { view: _view, accountId: _accountId, ...args } = input;
        return envelope({ preflight: await invoke('get_strategy_data_preflight', args) });
      }
      case 'diagnostics': {
        const run = await invoke('get_strategy_run', { runId: input.runId });
        if (!run.ok) return respond(run);
        const identity = (run.data as { run: { strategyId: string; strategyVersionId: string } })
          .run;
        if (
          identity.strategyId !== input.strategyId ||
          identity.strategyVersionId !== input.versionId
        )
          return respond(invalidInput('Run does not match the bound strategy version'), 400);
        const diagnostics = await invoke('get_strategy_selection_diagnostics', {
          strategyId: input.strategyId,
          runId: input.runId,
          view: input.kind,
          offset: input.offset,
          limit: input.limit,
          ...(input.query === undefined ? {} : { query: input.query }),
        });
        return envelope({
          diagnostics,
          evidenceSemantics:
            'Diagnostics use immutable run facts and do not refresh market quotes.',
        });
      }
      case 'updates': {
        const [context, runs, continuity, comparison] = await Promise.all([
          invoke('get_strategy_experiment_context', {
            strategyId: input.strategyId,
            ...(input.versionId === undefined ? {} : { candidateVersionId: input.versionId }),
          }),
          invoke('list_strategy_runs', {
            strategyId: input.strategyId,
            scope: 'operational',
            publication: 'published',
            limit: 10,
          }),
          options.continuity(principal, input.strategyId, signal),
          invoke('compare_strategy_runs', { strategyId: input.strategyId }),
        ]);
        return envelope({
          context,
          runs,
          comparison,
          continuity,
          evidenceSemantics:
            'T+1/T+3/T+5 are signal observations; run changes are not a portfolio backtest.',
        });
      }
    }
  };
};
