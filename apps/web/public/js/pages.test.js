import { describe, expect, it } from 'bun:test';

import { errorKindLabel, filterAdvices, routeStockId } from './pages.js';

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
