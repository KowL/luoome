import { describe, expect, it } from 'vitest';

import { collectKeys, firstDiffPath, VENDOR_HISTORICAL_KEYS } from './entity/report-document.js';

/**
 * REQ-M5-02：字段级 diff **返回具体路径**，以及 manifest 的自证扫描。
 */
describe('firstDiffPath：返回具体路径，不是「不相等」', () => {
  const doc = () => ({
    title: '报告',
    sections: [
      {
        key: 's0',
        blocks: [{ kind: 'text', text: '当日摘要', tone: 'factual' }],
      },
    ],
  });

  it('完全相同 → null', () => {
    expect(firstDiffPath(doc(), doc())).toBeNull();
  });

  it('**嵌套字段改一个字 → 返回那个具体路径**', () => {
    const changed = doc();
    const blocks = changed.sections[0]?.blocks ?? [];
    // 显式替换该 block，避免可选链赋值（TS 不允许 `a?.b = c`）
    blocks[0] = { kind: 'text', text: '当日摘要（改）', tone: 'factual' };
    // 这正是你要的具体化：不是「不相等」，是能定位的路径
    expect(firstDiffPath(doc(), changed)).toBe('sections[0].blocks[0].text');
  });

  it('顶层字段 → 返回字段名', () => {
    expect(firstDiffPath(doc(), { ...doc(), title: '别的' })).toBe('title');
  });

  it('数组长度不同 → 返回缺失的下标', () => {
    const shorter = { sections: [] as unknown[] };
    expect(firstDiffPath({ sections: [1, 2] }, shorter)).toBe('sections[0]');
  });

  it('**键顺序不同 → null**（不被序列化顺序骗到）', () => {
    // `JSON.stringify` 会认为两者不等，它们其实是同一份内容 —— 这正是不能全串比较的原因
    expect(firstDiffPath({ a: 1, b: 2 }, { b: 2, a: 1 })).toBeNull();
    expect(JSON.stringify({ a: 1, b: 2 })).not.toBe(JSON.stringify({ b: 2, a: 1 }));
  });

  it('类型不同 → 返回路径', () => {
    expect(firstDiffPath({ v: 1 }, { v: '1' })).toBe('v');
  });

  it('一边缺键 → 返回该键', () => {
    expect(firstDiffPath({ a: 1 }, {})).toBe('a');
  });
});

describe('manifest 自证：扫描导出内容里的键', () => {
  it('正常文档 → 扫不到供应商历史字段', () => {
    const keys = collectKeys({ title: 'x', sections: [{ blocks: [{ text: 'y' }] }] });
    const leaked = [...keys].filter((key) =>
      (VENDOR_HISTORICAL_KEYS as readonly string[]).includes(key),
    );
    expect(leaked).toEqual([]);
  });

  it('**塞入 vendorHistory → 必须扫得到**（声明才有意义）', () => {
    const keys = collectKeys({ title: 'x', vendorHistory: [{ close: 1 }] });
    const leaked = [...keys].filter((key) =>
      (VENDOR_HISTORICAL_KEYS as readonly string[]).includes(key),
    );
    expect(leaked).toEqual(['vendorHistory']);
  });

  it('嵌套很深的供应商字段同样扫得到', () => {
    const keys = collectKeys({ a: { b: [{ c: { providerHistory: [] } }] } });
    expect(
      [...keys].filter((k) => (VENDOR_HISTORICAL_KEYS as readonly string[]).includes(k)),
    ).toEqual(['providerHistory']);
  });
});
