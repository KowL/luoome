// Client 纯投影函数单测：验证浏览器只做 ToolResult→展示模型的形状转换，
// 不重算 PnL/统计、不推断用户跟随、不把未知写成零。
import { describe, expect, it } from 'vitest';
import {
  adviceFeedbackOf,
  calibrationRows,
  dataOf,
  decisionLoopSummary,
  decisionReviewRows,
  errorOf,
  mapStateBody,
  publishedRunsByStrategy,
  researchRequestFor,
  stateUrl,
  stockDetailUrl,
  stockResearchRequestFor,
  strategyExpression,
  strategyText,
} from './projection.js';

describe('client panel state projection', () => {
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
    expect(request.prompt).toContain('先让我确认');
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
});
