// Client 纯投影函数单测：验证浏览器只做 ToolResult→展示模型的形状转换，
// 不重算 PnL/统计、不推断用户跟随、不把未知写成零。
import { describe, expect, it } from 'vitest';
import {
  adviceCardEntriesOf,
  adviceCardEntry,
  adviceFeedbackOf,
  calibrationRows,
  dataOf,
  decisionLoopSummary,
  decisionReviewRows,
  errorOf,
  mapStateBody,
  marketObservationOf,
  mergeOverviewSection,
  metricTimeText,
  panelHealthBadge,
  publishedRunsByStrategy,
  researchRequestFor,
  stateUrl,
  stockDetailUrl,
  stockResearchRequestFor,
  strategyExpression,
  strategyOperationRequestFor,
  strategyPartDataOf,
  strategyPartErrorOf,
  strategyPartOf,
  strategyText,
} from './projection.js';

describe('client panel state projection', () => {
  it('preserves successful section data and its timestamp on tool failure, then recovers', () => {
    const previous = {
      identity: 'news:1',
      loading: true,
      loadedAt: '2026-10-25T04:00:00Z',
      results: { fetch_news: { ok: true, data: { items: [{ title: '旧要闻' }] } } },
    };
    const error = { kind: 'adapter_error', cause: 'timeout', recoverable: true };
    const failed = mergeOverviewSection(
      previous,
      mapStateBody({
        tools: [{ name: 'fetch_news', ok: false, error }],
        asOf: '2026-10-25T04:01:00Z',
      }),
    );
    expect(failed.results).toEqual(previous.results);
    expect(failed.loadedAt).toBe(previous.loadedAt);
    expect(failed.error).toEqual(error);
    expect(failed.loading).toBe(false);
    const recovered = mergeOverviewSection(
      failed,
      mapStateBody({
        tools: [{ name: 'fetch_news', ok: true, data: { items: [] } }],
        asOf: '2026-10-25T04:02:00Z',
      }),
    );
    expect(recovered.results.fetch_news.data.items).toEqual([]);
    expect(recovered.loadedAt).toBe('2026-10-25T04:02:00Z');
    expect(recovered.error).toBeNull();
  });

  it('does not fabricate data or a successful timestamp on initial section failure', () => {
    const state = mergeOverviewSection(
      { results: {}, loadedAt: null },
      mapStateBody({
        tools: [{ name: 'batch_quote', ok: false, error: { kind: 'permission_denied' } }],
      }),
    );
    expect(dataOf(state.results, 'batch_quote')).toBeNull();
    expect(state.loadedAt).toBeNull();
    expect(state.error.kind).toBe('permission_denied');
  });

  it('builds prefixed section URLs and overview analysis without invented strategy provenance', () => {
    expect(new URL(stateUrl('overview', 'watchlist', 2), 'https://example.test/dsh/').href).toBe(
      'https://example.test/dsh/api/luoome/state?panel=overview&section=watchlist&page=2',
    );
    const request = stockResearchRequestFor({
      stockId: '600519.SH',
      stockName: '贵州茅台',
      sourceKind: 'overview',
      sourceLabel: '自选行情',
    });
    expect(request.prompt).toContain('自选行情');
    expect(request.prompt).toContain('直接执行并回显结果');
    expect(request.prompt).not.toContain('已发布匹配');
    expect(request.prompt).not.toContain('undefined');
    expect(request.strategyId).toBeUndefined();
  });

  it('maps tools into the legacy results shape and keeps ToolResult errors verbatim', () => {
    const state = mapStateBody({
      panel: 'review',
      asOf: '2026-10-25T04:00:00.000Z',
      tools: [
        { name: 'get_advice_stats', ok: true, data: { totalAdvices: 2 } },
        {
          name: 'get_confidence_calibration',
          ok: false,
          error: { kind: 'not_found', entity: 'Account', id: 'x' },
        },
      ],
      strategies: [
        {
          strategyId: 's1',
          workspace: { name: 'get_strategy_workspace', ok: true, data: { health: 'ready' } },
          continuity: {
            status: 'waiting',
            factCutoff: '2026-10-24T07:00:00.000Z',
            reasons: ['等待真实回执'],
            limitations: [],
            tasks: [],
          },
        },
        {
          strategyId: 's2',
          workspace: {
            name: 'get_strategy_workspace',
            ok: false,
            error: { kind: 'permission_denied' },
          },
        },
      ],
    });
    expect(state.panel).toBe('review');
    expect(state.asOf).toBe('2026-10-25T04:00:00.000Z');
    expect(dataOf(state.results, 'get_advice_stats')).toEqual({ totalAdvices: 2 });
    expect(errorOf(state.results, 'get_confidence_calibration')).toEqual({
      kind: 'not_found',
      entity: 'Account',
      id: 'x',
    });
    expect(state.strategies).toHaveLength(2);
    expect(state.strategies[0]?.workspace?.ok).toBe(true);
    expect(state.strategies[0]?.continuity).toEqual({
      status: 'waiting',
      factCutoff: '2026-10-24T07:00:00.000Z',
      reasons: ['等待真实回执'],
      limitations: [],
      tasks: [],
    });
    expect(state.strategies[1]?.continuity).toBeUndefined();
    expect(state.strategies[1]?.workspace?.error).toEqual({ kind: 'permission_denied' });
    expect(stateUrl('strategies')).toBe('api/luoome/state?panel=strategies');
  });

  it('rejects invalid state bodies and ignores malformed tool entries', () => {
    expect(() => mapStateBody(null)).toThrow('面板响应无效');
    const state = mapStateBody({ tools: [null, { name: 'x' }, { name: 'y', ok: true, data: 1 }] });
    expect(Object.keys(state.results)).toEqual(['x', 'y']);
    expect(state.results.x).toEqual({ ok: false, error: { kind: 'unavailable' } });
  });

  it.each(['http://localhost:3080/', 'https://example.test/dsh/'])(
    'keeps panel requests under the DSH document base %s',
    (base) => {
      expect(new URL(stateUrl('overview'), base).href).toBe(
        `${base}api/luoome/state?panel=overview`,
      );
      expect(new URL(stockDetailUrl('600519.SH'), base).href).toBe(
        `${base}api/luoome/stock?stockId=600519.SH`,
      );
    },
  );

  it('builds a stock analysis request with the selected stock and exact readable strategy provenance', () => {
    const request = stockResearchRequestFor({
      stockId: '600519.SH',
      stockName: '贵州茅台',
      strategyId: 'strategy-early-breakout-20260809',
      runId: 'strategy-run-old',
      strategyName: '早期突破',
      version: 6,
      dataAsOf: '2026-10-23T07:00:00Z',
    });
    expect(request).toMatchObject({
      stockId: '600519.SH',
      strategyId: 'strategy-early-breakout-20260809',
      runId: 'strategy-run-old',
    });
    expect(request.prompt).toContain('贵州茅台（600519.SH）');
    expect(request.prompt).toContain('早期突破');
    expect(request.prompt).toContain('第 6 版');
    expect(request.prompt).toContain('2026-10-23T07:00:00Z');
    expect(request.prompt).not.toContain(request.strategyId);
    expect(request.prompt).not.toContain(request.runId);
    expect(request.prompt).toContain('缺失或过期数据');
    expect(request.prompt).toContain('明确提出保存建议');
  });

  it('does not infer user follow-up: outcome only comes from explicit advice.outcome', () => {
    expect(adviceFeedbackOf({})).toBeNull();
    expect(adviceFeedbackOf({ outcome: { outcome: 'watched' } })?.outcome).toBe('watched');
    const followed = adviceFeedbackOf({
      outcome: {
        outcome: 'followed',
        pnl: 12.5,
        notes: '已分批',
        recordedAt: '2026-10-24T00:00:00Z',
      },
    });
    expect(followed).toEqual({
      label: '已跟随',
      tone: 'accent',
      outcome: 'followed',
      // 存量回填没有来源戳：面板显示为未知，不假定是用户填的。
      origin: null,
      pnl: 12.5,
      notes: '已分批',
      recordedAt: '2026-10-24T00:00:00Z',
    });
    expect(adviceFeedbackOf({ outcome: { outcome: 'partially_followed' } })?.label).toBe(
      '部分跟随',
    );
    expect(adviceFeedbackOf({ outcome: { outcome: 'ignored' } })?.label).toBe('已忽略');
  });

  it('keeps only non-empty calibration buckets and does not fabricate hit rates', () => {
    const rows = calibrationRows({
      buckets: [
        {
          range: { min: 0, max: 9 },
          total: 0,
          withOutcome: 0,
          followedWithPnl: 0,
          hitRate: null,
          avgConfidence: 0,
        },
        {
          range: { min: 50, max: 59 },
          total: 3,
          withOutcome: 1,
          followedWithPnl: 1,
          hitRate: 1,
          avgConfidence: 55,
        },
      ],
    });
    expect(rows).toEqual([
      {
        key: '50-59',
        range: '50–59',
        total: 3,
        withOutcome: 1,
        followedWithPnl: 1,
        hitRate: 1,
        avgConfidence: 55,
      },
    ]);
    expect(
      calibrationRows({ buckets: [{ range: { min: 0, max: 9 }, total: 0, hitRate: null }] })[0]
        ?.hitRate,
    ).toBeUndefined();
  });

  it('projects decision reviews with subject source and revision without recomputing content', () => {
    const rows = decisionReviewRows({
      records: [
        {
          review: {
            id: 'review-1',
            subject: { kind: 'advice', id: 'advice-1' },
            stockId: '600519.SH',
            sourceOccurredAt: '2026-10-22T02:00:00.000Z',
            currentRevision: 2,
          },
          revision: {
            reviewId: 'review-1',
            revision: 2,
            recordedAt: '2026-10-23T02:00:00.000Z',
            changeNote: '用户确认',
          },
        },
      ],
    });
    expect(rows).toEqual([
      {
        key: 'review-1',
        kind: 'advice',
        kindLabel: '建议',
        subjectId: 'advice-1',
        stockId: '600519.SH',
        sourceOccurredAt: '2026-10-22T02:00:00.000Z',
        currentRevision: 2,
        revision: 2,
        recordedAt: '2026-10-23T02:00:00.000Z',
        changeNote: '用户确认',
      },
    ]);
  });

  it('groups published operational runs by strategy and keeps tool order', () => {
    const byStrategy = publishedRunsByStrategy({
      runs: [
        { id: 'r2', strategyId: 's1', status: 'complete' },
        { id: 'r1', strategyId: 's1', status: 'partial' },
        { id: 'r3', strategyId: 's2', status: 'complete' },
      ],
    });
    expect(byStrategy.get('s1')?.map((run) => run.id)).toEqual(['r2', 'r1']);
    expect(byStrategy.get('s2')?.map((run) => run.id)).toEqual(['r3']);
  });

  it('projects decision-loop window, unknowns and limitations without causal claims', () => {
    expect(decisionLoopSummary(null)).toBeNull();
    const summary = decisionLoopSummary({
      dataAsOf: '2026-10-22T02:00:00.000Z',
      window: { since: '2026-09-22T00:00:00.000Z' },
      unknowns: ['未核验公告'],
      limitations: ['仅账户范围'],
      evidenceIds: ['e1', 'e2'],
      decisionRecords: { total: 1 },
      signalObservations: { total: 4, complete: 2 },
    });
    expect(summary).toMatchObject({
      dataAsOf: '2026-10-22T02:00:00.000Z',
      since: '2026-09-22T00:00:00.000Z',
      until: null,
      evidenceCount: 2,
      unknowns: ['未核验公告'],
      limitations: ['仅账户范围'],
    });
  });

  it('keeps exact research references outside the visible draft and uses readable facts for lookup', () => {
    const withRun = researchRequestFor('strategy-a', 'run-a', {
      strategyName: '早期突破',
      version: 7,
      dataAsOf: '2026-10-23T07:00:00Z',
    });
    expect(withRun.strategyId).toBe('strategy-a');
    expect(withRun.runId).toBe('run-a');
    expect(withRun.prompt).not.toContain('strategy-a');
    expect(withRun.prompt).not.toContain('run-a');
    expect(withRun.prompt).toContain('早期突破');
    expect(withRun.prompt).toContain('第 7 版');
    expect(withRun.prompt).toContain('2026-10-23T07:00:00Z');
    expect(withRun.prompt).toContain('存在同名或版本不符时先核对');
    expect(withRun.prompt).not.toContain('自动发布策略');
    const withoutRun = researchRequestFor('strategy-a');
    expect(withoutRun.runId).toBeNull();
    expect(withoutRun.prompt).not.toContain('strategy-a');
    expect(withoutRun.prompt).not.toContain('已发布匹配结果');
  });

  it('replaces internal strategy, run, version and rule references without hiding stock codes', () => {
    const text = strategyText(
      'strategy-early-breakout-20260809-v7 / strategy-early-breakout-20260809 / run-20261023-001 / positive-price / 600519.SH',
      [
        { id: 'strategy-early-breakout-20260809', label: '早期突破' },
        { id: 'strategy-early-breakout-20260809-v7', label: '第 7 版' },
        { id: 'positive-price', label: '价格有效' },
      ],
    );
    expect(text).toBe('第 7 版 / 早期突破 / 相关记录 / 价格有效 / 600519.SH');
    expect(strategyText('版本 527bb68d-814e-4477-9959-54b3094d984e')).toBe('版本 相关记录');
  });

  it('translates expression fields while retaining thresholds and operator grouping', () => {
    expect(
      strategyExpression(
        `\${indicators.ma5} > \${indicators.ma20} && (quote.close >= 20 || meta.limitUpToday)`,
      ),
    ).toBe('5 日均线 > 20 日均线  且  (收盘价 ≥ 20  或  今日涨停)');
    expect(strategyExpression(`Math.min(100, \${indicators.volRatio5_20} * 30)`)).toBe(
      'Math.min(100, 5 / 20 日量比 * 30)',
    );
  });

  it('keeps the server market session and tolerates older servers without it', () => {
    expect(
      mapStateBody({
        panel: 'overview',
        session: { marketSession: 'trading', nextSessionStart: '2026-10-26T05:30:00.000Z' },
      }).session,
    ).toEqual({ marketSession: 'trading', nextSessionStart: '2026-10-26T05:30:00.000Z' });
    expect(mapStateBody({ panel: 'overview' }).session).toBeNull();
    expect(
      mapStateBody({ panel: 'overview', session: { nextSessionStart: null } }).session,
    ).toBeNull();
    expect(
      mapStateBody({ panel: 'overview', session: { marketSession: 'closed' } }).session,
    ).toEqual({ marketSession: 'closed', nextSessionStart: null });
  });

  it('maps per-strategy schedule/subscriptions parts and exposes them through part helpers', () => {
    const scheduleData = { schedule: { cron: '30 16 * * 1-5', enabled: true } };
    const subscriptionsData = { total: 1, subscriptions: [{ status: 'active' }] };
    const state = mapStateBody({
      panel: 'strategies',
      tools: [],
      strategies: [
        {
          strategyId: 's1',
          workspace: { name: 'get_strategy_workspace', ok: true, data: {} },
          schedule: { name: 'get_strategy_schedule', ok: true, data: scheduleData },
          subscriptions: {
            name: 'list_strategy_watchlist_subscriptions',
            ok: true,
            data: subscriptionsData,
          },
        },
        {
          strategyId: 's2',
          workspace: { name: 'get_strategy_workspace', ok: true, data: {} },
          // 无 schedule 是合法空配置：ok=true 且 schedule 为 null，不是读取失败。
          schedule: { name: 'get_strategy_schedule', ok: true, data: { schedule: null } },
          subscriptions: {
            name: 'list_strategy_watchlist_subscriptions',
            ok: false,
            error: { kind: 'permission_denied' },
          },
        },
        // 老服务端没有派生字段：part 一律为 null，不能伪造成空配置或错误。
        { strategyId: 's3' },
      ],
    });
    expect(state.strategies).toHaveLength(3);
    expect(state.strategies[0]?.schedule).toEqual({ ok: true, data: scheduleData });
    expect(state.strategies[0]?.subscriptions).toEqual({ ok: true, data: subscriptionsData });
    expect(strategyPartOf(state, 's1', 'schedule')).toEqual(state.strategies[0]?.schedule);
    expect(strategyPartDataOf(state, 's1', 'schedule')).toEqual(scheduleData);
    expect(strategyPartErrorOf(state, 's1', 'schedule')).toBeNull();
    expect(strategyPartDataOf(state, 's1', 'subscriptions')).toEqual(subscriptionsData);
    expect(strategyPartDataOf(state, 's2', 'schedule')).toEqual({ schedule: null });
    expect(strategyPartErrorOf(state, 's2', 'schedule')).toBeNull();
    expect(strategyPartDataOf(state, 's2', 'subscriptions')).toBeNull();
    expect(strategyPartErrorOf(state, 's2', 'subscriptions')).toEqual({
      kind: 'permission_denied',
    });
    expect(strategyPartOf(state, 's3', 'workspace')).toBeNull();
    expect(strategyPartOf(state, 's3', 'schedule')).toBeNull();
    expect(strategyPartDataOf(state, 's3', 'schedule')).toBeNull();
    expect(strategyPartErrorOf(state, 's3', 'schedule')).toBeNull();
    expect(strategyPartOf(state, 'unknown', 'schedule')).toBeNull();
  });

  it('builds a strategy operations request with structured id and two-layer scheduling rules', () => {
    const request = strategyOperationRequestFor('strategy-early-breakout-20260809', {
      strategyName: '早期突破',
    });
    // strategyId 留在结构化字段里供调用使用；可见草稿只用可读名称定位策略。
    expect(request.strategyId).toBe('strategy-early-breakout-20260809');
    expect(request.prompt).toContain('早期突破');
    expect(request.prompt).not.toContain('strategy-early-breakout-20260809');
    // 两层调度：StrategySchedule 只决定到期，必须由 DSH 定时任务执行日周期才真正运行。
    expect(request.prompt).toContain('StrategySchedule');
    expect(request.prompt).toContain('run_strategy_daily_cycle');
    // 禁止绕过编排或在用户未提出意图时写入。
    expect(request.prompt).toContain('不要直接调用 run_strategy');
    expect(request.prompt).toContain('不要自动创建重复日程或自动发布');
    expect(request.prompt).toContain('明确提出调度、暂停、恢复、订阅或任务授权意图');
    const fallback = strategyOperationRequestFor('strategy-x');
    expect(fallback.strategyId).toBe('strategy-x');
    expect(fallback.prompt).toContain('所选策略');
    expect(fallback.prompt).not.toContain('strategy-x');
  });
});

describe('REQ-M3-09 事实缺口投影（client 侧唯一实现，判定全在服务端）', () => {
  it('角标只读服务端 health：三档映射到配色，缺 health 时返回 null（不伪造健康）', () => {
    expect(panelHealthBadge(null)).toBeNull();
    expect(panelHealthBadge({ status: 'weird' })).toBeNull();
    expect(
      panelHealthBadge({ status: 'available', checkedTools: ['a'], issues: [] }),
    ).toMatchObject({
      status: 'available',
      tone: 'ok',
      label: '数据健康',
      asOf: null,
      checkedTools: 1,
    });
    const partial = panelHealthBadge({
      status: 'partial',
      asOf: '2026-10-20T00:00:00.000Z',
      issues: [{ tool: 'list_holdings', detail: '缺价', remedy: '先跑 batch_quote' }],
    });
    expect(partial.tone).toBe('warn');
    expect(partial.asOf).toBe('2026-10-20T00:00:00.000Z');
    expect(partial.detail[0]).toContain('batch_quote');
    expect(panelHealthBadge({ status: 'unavailable' }).tone).toBe('bad');
  });

  it('缺时点渲染「时点未知」而不是省略（PRD「出现即带」）', () => {
    expect(metricTimeText(null)).toBe('时点未知');
    expect(metricTimeText(undefined)).toBe('时点未知');
    expect(metricTimeText('')).toBe('时点未知');
    expect(metricTimeText('2026-10-30T00:00:00.000Z')).toBe('2026-10-30T00:00:00.000Z');
  });

  it('卡片条目：renderable 给五段；blocked 给 warning 文案且列出缺段', () => {
    expect(adviceCardEntry(null)).toBeNull();
    const blocked = adviceCardEntry({
      status: 'blocked',
      adviceId: 'a1',
      missing: ['counterEvidence', 'risks'],
      available: ['conclusion', 'validity', 'disclaimer'],
      note: '不可渲染：缺反证 / 风险',
    });
    expect(blocked).toMatchObject({ status: 'blocked', tone: 'warning', adviceId: 'a1' });
    expect(blocked.text).toContain('不可渲染');
    expect(blocked.missing).toEqual(['counterEvidence', 'risks']);

    const renderable = adviceCardEntry({
      status: 'renderable',
      adviceId: 'a2',
      conclusion: 'c',
      counterEvidence: ['ce'],
      risks: ['r'],
      validity: { validUntil: '2026-11-01T00:00:00.000Z', expired: false },
      disclaimer: ['d1', 'd2', 'd3'],
      dataAsOf: '2026-10-30T00:00:00.000Z',
    });
    expect(renderable).toMatchObject({ status: 'renderable', tone: 'factual' });
    expect(renderable.counterEvidence).toEqual(['ce']);
    expect(renderable.disclaimer).toHaveLength(3);
  });

  it('cards 按 advice id 对齐，坏条目被跳过而不是伪造', () => {
    const entries = adviceCardEntriesOf({
      cards: [
        {
          status: 'renderable',
          adviceId: 'a1',
          conclusion: 'c',
          counterEvidence: ['x'],
          risks: ['y'],
          validity: null,
          disclaimer: ['d'],
          dataAsOf: null,
        },
        { status: 'blocked', adviceId: 'a2', missing: ['risks'], note: '不可渲染：缺风险' },
        { status: 'unknown', adviceId: 'a3' },
      ],
    });
    expect([...entries.keys()]).toEqual(['a1', 'a2']);
  });

  it('市场观察三档：只挑服务端字段，current 静默、其余 warn', () => {
    expect(marketObservationOf({})).toBeNull();
    expect(
      marketObservationOf({ marketObservation: { scope: 'current', label: '观测于 X' } }),
    ).toMatchObject({
      tone: 'quiet',
      label: '观测于 X',
    });
    expect(
      marketObservationOf({
        marketObservation: { scope: 'prior-session', label: '上一交易日收盘观察（观测于 X）' },
      }),
    ).toMatchObject({ tone: 'warn', scope: 'prior-session' });
  });

  it('mapStateBody 透传服务端 health 与 marketObservation（不在 client 重算）', () => {
    const mapped = mapStateBody({
      panel: 'overview',
      asOf: '2026-10-31T00:00:00.000Z',
      tools: [],
      health: { status: 'partial', checkedTools: ['a'], issues: [] },
      marketObservation: { scope: 'historical', label: '历史观察（观测于 X）', observedAt: 'X' },
    });
    expect(mapped.health).toMatchObject({ status: 'partial' });
    expect(mapped.marketObservation).toMatchObject({ scope: 'historical' });
  });
});

import { money, ratio, signedMoney } from './format.js';
// REQ-M3-09 S3 client 侧：缺价渲染「缺价」，绝不渲染 0；真实 0 盈亏仍显示 0.00%。
import { holdingPriceView, holdingsTotalsView } from './projection.js';

const renderHolding = (item) => {
  const view = holdingPriceView(item);
  if (!view.canShowNumbers) {
    return { price: view.unavailableText, pnl: view.unavailableText, pnlPct: view.unavailableText };
  }
  return {
    price: money(item.currentPrice),
    pnl: signedMoney(item.pnl),
    pnlPct: ratio(item.pnlPct),
  };
};

describe('S3 缺价渲染', () => {
  it('renders the reason instead of numbers when the server says unpriced', () => {
    const rendered = renderHolding({
      priceStatus: 'unpriced',
      priceUnavailableReason: '缺价：该标的没有可用行情，成本价不代表现价',
    });
    const text = JSON.stringify(rendered);
    expect(text).not.toContain('0.00%');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
    expect(rendered.pnlPct).toContain('缺价');
  });

  it('still renders a genuine zero when the server says priced', () => {
    const rendered = renderHolding({
      priceStatus: 'priced',
      currentPrice: 10,
      marketValue: 1000,
      pnl: 0,
      pnlPct: 0,
    });
    expect(rendered.pnlPct).toBe('0.00%');
    expect(rendered.pnl).toBe('0.00');
  });

  it('never falls back to a zero when the field is missing but no status is given', () => {
    // 服务端没给 priceStatus（老载荷）时同样不许编数字。
    const view = holdingPriceView({});
    expect(view.canShowNumbers).toBe(false);
  });

  it('surfaces the unpriced count on the summary layer', () => {
    const view = holdingsTotalsView({ unpricedCount: 2 });
    expect(view.partiallyUnpriced).toBe(true);
    expect(view.note).toContain('含缺价持仓（2）');
    expect(view.canShowTotals).toBe(false);
    const ok = holdingsTotalsView({ unpricedCount: 0, totalValue: 1000, totalPnL: 0 });
    expect(ok.note).toBeNull();
    expect(ok.canShowTotals).toBe(true);
  });
});

// 静态守卫（S3）：client 不许把缺席的盈亏字段补成 0。
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('S3 静态守卫：缺席字段不得被补成 0', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(root).filter(
    (name) => name.endsWith('.js') && !name.endsWith('.test.js'),
  );

  it('client 里没有对持仓盈亏字段的 `?? 0` / `|| 0` 兜底', () => {
    const offenders = [];
    for (const name of files) {
      const text = readFileSync(join(root, name), 'utf8');
      for (const pattern of [
        /(pnlPct|todayPnlPct|currentPrice|marketValue|totalPnL|totalPnLPct|totalValue)\s*\?\?\s*0\b/g,
        /(pnlPct|todayPnlPct|currentPrice|marketValue|totalPnL|totalPnLPct|totalValue)\s*\|\|\s*0\b/g,
      ]) {
        for (const match of text.matchAll(pattern)) {
          offenders.push(`${name}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('渲染盈亏的组件都过 holdingPriceView 判据', () => {
    const withPnl = files.filter((name) => {
      const text = readFileSync(join(root, name), 'utf8');
      return /ratio\(item\.pnlPct\)|signedMoney\(item\.pnl\)/.test(text);
    });
    expect(withPnl.length).toBeGreaterThan(0);
    for (const name of withPnl) {
      const text = readFileSync(join(root, name), 'utf8');
      expect(text, name).toContain('holdingPriceView');
      // 直接渲染（不经过 canShowNumbers）就会把缺价渲染成 0.00%。
      expect(text, name).not.toMatch(/(?<!canShowNumbers \? )ratio\(item\.pnlPct\)/);
    }
  });
});
