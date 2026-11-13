import {
  closingReportOperation,
  openingReportOperation,
  weeklyReportOperation,
} from '@luoome/workflows';
import type { Hono } from 'hono';
import { jsonResult, notFound } from '../http/result.js';
import type { WebRouteDeps } from './types.js';

export const registerResearchRoutes = (app: Hono, deps: WebRouteDeps): void => {
  const {
    contextForRequest,
    callTool,
    invokeTool,
    requireMutationCapabilities,
    targetMutation,
    decisionMutation,
    bindDecisionAccount,
  } = deps;

  app.get('/api/research/documents', (c) =>
    callTool('list_research_documents', {
      ...(c.req.query('kind') ? { kind: c.req.query('kind') } : {}),
      ...(c.req.query('stockCode') ? { stockCode: c.req.query('stockCode') } : {}),
      ...(c.req.query('tag') ? { tags: [c.req.query('tag')] } : {}),
      limit: Number(c.req.query('limit') ?? '50'),
    }),
  );
  app.get('/api/research/documents/:id', (c) =>
    callTool('get_research_document', {
      documentId: c.req.param('id'),
      includeContent: c.req.query('content') === '1',
    }),
  );
  app.get('/api/research/search', (c) =>
    callTool('search_research_documents', {
      text: c.req.query('q') ?? '',
      limit: Number(c.req.query('limit') ?? '50'),
    }),
  );
  app.get('/api/advice', (c) => {
    const subjectId = c.req.query('subjectId');
    const subjectKind = c.req.query('subjectKind');
    const includeExpired = c.req.query('includeExpired');
    const limitRaw = c.req.query('limit');
    const input: Record<string, unknown> = {
      includeExpired: includeExpired === 'true' || includeExpired === '1',
    };
    if (subjectId !== undefined && subjectId.length > 0) input.subjectId = subjectId;
    if (subjectKind !== undefined && subjectKind.length > 0) input.subjectKind = subjectKind;
    if (limitRaw !== undefined) {
      const limit = Number(limitRaw);
      if (Number.isInteger(limit) && limit > 0) input.limit = limit;
    }
    return callTool('get_advice', input);
  });

  app.get('/api/advice/stats', (c) => {
    const subjectId = c.req.query('subjectId');
    const input: Record<string, unknown> = {};
    if (subjectId !== undefined && subjectId.length > 0) input.subjectId = subjectId;
    return callTool('get_advice_stats', input);
  });

  // 建议删除（单个 = 单元素 ids）；write 能力门控与 delete_report 一致。
  app.post('/api/advice/delete', (c) => targetMutation(c.req.raw, 'write', 'delete_advice'));

  app.get('/api/reports', (c) => {
    const input: Record<string, unknown> = {};
    for (const key of ['kind', 'from', 'to', 'status'] as const) {
      const value = c.req.query(key);
      if (value !== undefined && value.length > 0) input[key] = value;
    }
    const scopeKind = c.req.query('scope');
    const accountId = c.req.query('accountId');
    if (scopeKind === 'all-accounts') input.scope = { kind: 'all-accounts' };
    if (scopeKind === 'account' && accountId !== undefined) {
      input.scope = { kind: 'account', accountId };
    }
    const limit = Number(c.req.query('limit'));
    if (Number.isInteger(limit) && limit > 0) input.limit = limit;
    return callTool('list_reports', input);
  });

  app.post('/api/reports/run/:kind', async (c) => {
    const denied = requireMutationCapabilities(c.req.raw, ['write', 'external']);
    if (denied !== null) return jsonResult(denied);
    const kind = c.req.param('kind');
    const workflow =
      kind === 'opening'
        ? openingReportOperation
        : kind === 'closing'
          ? closingReportOperation
          : kind === 'weekly'
            ? weeklyReportOperation
            : undefined;
    if (workflow === undefined) return jsonResult(notFound('ReportWorkflow', kind));
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const raw =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const input = {
      ...raw,
      mode: 'manual' as const,
      ...(kind === 'weekly' && typeof raw.date === 'string'
        ? { periodEnd: raw.date, date: undefined }
        : {}),
    };
    return jsonResult(await workflow.run(input, contextForRequest()));
  });

  app.get('/api/reports/:id/render', (c) =>
    callTool('render_report', {
      reportId: c.req.param('id'),
      format:
        c.req.query('format') === 'notification'
          ? 'notification'
          : c.req.query('format') === 'plain-text'
            ? 'plain-text'
            : 'markdown',
    }),
  );

  app.get('/api/reports/:id', (c) => callTool('get_report', { id: c.req.param('id') }));

  app.delete('/api/reports/:id', (c) =>
    targetMutation(c.req.raw, 'write', 'delete_report', { reportId: c.req.param('id') }),
  );

  app.get('/api/decision-reviews', (c) => {
    const bound = bindDecisionAccount(c.req.raw, {
      accountId: c.req.query('accountId'),
      subjectKind: c.req.query('subjectKind'),
      subjectId: c.req.query('subjectId'),
      stockId: c.req.query('stockId'),
      since: c.req.query('since'),
      until: c.req.query('until'),
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit') === undefined ? undefined : Number(c.req.query('limit')),
    });
    if ('denied' in bound) return jsonResult(bound.denied);
    return callTool(
      'list_decision_reviews',
      Object.fromEntries(Object.entries(bound.input).filter(([, value]) => value !== undefined)),
    );
  });
  app.post('/api/decision-reviews', (c) => decisionMutation(c.req.raw, 'save_decision_review'));

  // 复盘趋势图：按天聚合当前账户明确 followed 且填有盈亏的样本。
  // 默认 30 天窗口；advice 不足则返回空序列（前端 fallback 显示 byDecision）。
  app.get('/api/review/trend', async (c) => {
    const daysRaw = c.req.query('days');
    const days = daysRaw === undefined ? 30 : Math.max(1, Math.min(180, Number(daysRaw) || 30));
    const since = new Date(Date.now() - days * 86_400_000);
    const adviceResult = await invokeTool('get_advice', {
      since,
      includeExpired: true,
      limit: 500,
    });
    if (!adviceResult.ok) return jsonResult(adviceResult);
    interface AdviceRow {
      createdAt: Date;
      outcome?: { outcome: string; pnl?: number };
    }
    const rows = adviceResult.data as { advices: AdviceRow[] };
    // 与 V2 统计使用同一已填盈亏样本分母。
    const buckets = new Map<string, { total: number; hits: number }>();
    for (const a of rows.advices) {
      const d = new Date(a.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const cur = buckets.get(key) ?? { total: 0, hits: 0 };
      if (a.outcome?.outcome !== 'followed' || a.outcome.pnl === undefined) continue;
      cur.total += 1;
      if (a.outcome.pnl > 0) cur.hits += 1;
      buckets.set(key, cur);
    }
    const series = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date,
        total: v.total,
        hits: v.hits,
        hitRate: v.total === 0 ? null : v.hits / v.total,
      }));
    return jsonResult({ ok: true, data: { days, series } });
  });

  // 复盘页：近期 advice + 准确率统计（read）
  app.get('/api/review', async () => {
    const adviceResult = await invokeTool('get_advice', {
      includeExpired: true,
      limit: 20,
    });
    if (!adviceResult.ok) return jsonResult(adviceResult);
    const statsResult = await invokeTool('get_advice_stats', {});
    if (!statsResult.ok) return jsonResult(statsResult);
    return jsonResult({
      ok: true,
      data: { advices: adviceResult.data, stats: statsResult.data },
    });
  });

  // 全局决策闭环复盘（read）：直接消费 get_decision_loop_review，保留 unknown/partial 语义。
  app.get('/api/review/decision-loop', (c) => {
    const accountId = c.req.query('accountId');
    const stockId = c.req.query('stockId');
    const since = c.req.query('since');
    const until = c.req.query('until');
    const limit = c.req.query('limit');
    return callTool('get_decision_loop_review', {
      ...(accountId === undefined ? {} : { accountId }),
      ...(stockId === undefined ? {} : { stockId }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    });
  });

  // confidence 自校准（v0.5 W4）：把历史 advice 按 confidence 桶聚合 hitRate / avgPnl，
  // 复盘页右侧渲染成本表 + 整体命中率。
  app.get('/api/review/calibration', async () => callTool('get_confidence_calibration', {}));
};
