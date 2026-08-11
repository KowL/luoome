import { describe, expect, it } from 'bun:test';

import {
  boardStats,
  errorKindLabel,
  filterAdvices,
  routeStockId,
  sortBoardItems,
  watchRunSummaryText,
} from './pages.js';

describe('盯盘最近一轮摘要', () => {
  it('读取 WatchRunSchema 的 evaluatedPools 字段', () => {
    const latest = {
      evaluatedPools: 3,
      evaluatedStocks: 12,
      triggered: 2,
      notified: 1,
    };
    expect(watchRunSummaryText(latest)).toBe('评估 3 个方案 / 12 只股票 · 触发 2 · 通知 1');
  });

  it('尚无运行记录时给占位文案', () => {
    expect(watchRunSummaryText(null)).toBe('跑一轮后显示评估指标');
  });
});

describe('分析错误提示中文化', () => {
  it('已知 kind 映射为中文文案', () => {
    expect(errorKindLabel({ kind: 'llm_error' })).toBe('AI 分析服务异常');
    expect(errorKindLabel({ kind: 'adapter_error' })).toBe('行情或外部服务异常');
    expect(errorKindLabel({ kind: 'not_found' })).toBe('记录不存在');
  });

  it('未知 kind 回退原始值，不查原型链', () => {
    expect(errorKindLabel({ kind: 'weird_kind' })).toBe('weird_kind');
    expect(errorKindLabel({ kind: 'toString' })).toBe('toString');
  });

  it('缺 kind 时给兜底文案', () => {
    expect(errorKindLabel(undefined)).toBe('未知错误');
    expect(errorKindLabel({})).toBe('未知错误');
  });
});

describe('行情关联深链接', () => {
  it('解析并规范化 stockId', () => {
    expect(routeStockId('#research?stockId=002594.sz')).toBe('002594.SZ');
    expect(routeStockId('#holdings')).toBeNull();
    expect(routeStockId('#advice?stockId=%20')).toBeNull();
  });

  it('Advice 同时按 stockId 和 decision 过滤', () => {
    const advices = [
      { subjectId: '002594.SZ', decision: 'buy' },
      { subjectId: '002594.SZ', decision: 'hold' },
      { subjectId: '600519.SH', decision: 'buy' },
    ];
    expect(filterAdvices(advices, 'all', '002594.SZ')).toHaveLength(2);
    expect(filterAdvices(advices, 'buy', '002594.SZ')).toEqual([advices[0]]);
    expect(filterAdvices(advices, 'buy', null)).toEqual([advices[0], advices[2]]);
  });
});

describe('看板纯函数', () => {
  const item = (stockId, changePct, holding = null) => ({
    stockId,
    name: stockId,
    quote: null,
    changePct,
    holding,
    watchlists: [],
    todayTrigger: null,
  });

  it('持仓置顶（保持原顺序），其余按 |changePct| 降序，null 排最后', () => {
    const input = [
      item('A', 1.5),
      item('H1', -0.2, { quantity: 100 }),
      item('B', null),
      item('H2', 3.0, { quantity: 200 }),
      item('C', -5.0),
      item('D', 0),
    ];
    expect(sortBoardItems(input).map((i) => i.stockId)).toEqual(['H1', 'H2', 'C', 'A', 'D', 'B']);
    // 不改动原数组
    expect(input[0].stockId).toBe('A');
  });

  it('涨 / 跌 / 平计数（null 计入平）', () => {
    const stats = boardStats([item('A', 1.5), item('B', -2), item('C', 0), item('D', null)]);
    expect(stats).toEqual({ up: 1, down: 1, flat: 2 });
  });
});
