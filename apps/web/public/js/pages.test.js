import { describe, expect, it } from 'bun:test';

import { errorKindLabel } from './pages.js';

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
