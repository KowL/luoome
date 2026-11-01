import { describe, expect, it } from 'vitest';

import { parsePositiveInteger, parsePositiveMegabytes } from './retention.js';

// task-37：保留参数判据——与 task-36 的 LUOOME_BACKUP_KEEP 共用同一套。
describe('保留参数校验', () => {
  it('正整数：合法值通过，空值走默认', () => {
    expect(parsePositiveInteger('7', { name: 'X', fallback: 5 })).toBe(7);
    expect(parsePositiveInteger(undefined, { name: 'X', fallback: 5 })).toBe(5);
    expect(parsePositiveInteger('', { name: 'X', fallback: 5 })).toBe(5);
    expect(parsePositiveInteger('  9  ', { name: 'X', fallback: 5 })).toBe(9);
  });

  it('0 / 负数 / 非数字 / 小数 一律抛出（绝不当成「全清」）', () => {
    // 注意：纯空白 trim 后等于未设置，走默认值（不算错误）——下面单独断言。
    for (const bad of ['0', '-1', 'abc', '3.5', '1e3'])
      expect(() => parsePositiveInteger(bad, { name: 'X', fallback: 5 }), bad).toThrow();
    expect(() => parsePositiveInteger('0', { name: 'LUOOME_EXPORT_KEEP', fallback: 20 })).toThrow(
      '必须 ≥ 1',
    );
    // 纯空白 = 未设置 → 默认值，不是错误。
    expect(parsePositiveInteger(' ', { name: 'X', fallback: 20 })).toBe(20);
  });

  it('体积阈值允许小数（测试要把上限调到 0.001 才跑得动轮转）', () => {
    expect(parsePositiveMegabytes('0.001', { name: 'X', fallback: 20 })).toBe(0.001);
    expect(parsePositiveMegabytes('20', { name: 'X', fallback: 20 })).toBe(20);
    expect(parsePositiveMegabytes(undefined, { name: 'X', fallback: 20 })).toBe(20);
    for (const bad of ['0', '-1', 'abc'])
      expect(() => parsePositiveMegabytes(bad, { name: 'X', fallback: 20 }), bad).toThrow();
  });
});
