import { describe, expect, it } from 'bun:test';

import { activeSourceIds, canEnableMore, MAX_ACTIVE_SOURCES } from './market-settings.js';

describe('行情源路由排序', () => {
  it('只返回启用源并按 priority 排序', () => {
    expect(
      activeSourceIds([
        { id: 'eastmoney', enabled: true, priority: 2 },
        { id: 'tushare', enabled: false, priority: null },
        { id: 'tencent', enabled: true, priority: 1 },
      ]),
    ).toEqual(['tencent', 'eastmoney']);
  });
});

describe('启用数量上限', () => {
  it('已启用 3 个源时不允许再启用第 4 个', () => {
    const three = [
      { id: 'eastmoney', enabled: true, priority: 1 },
      { id: 'tencent', enabled: true, priority: 2 },
      { id: 'sina', enabled: true, priority: 3 },
      { id: 'tushare', enabled: false, priority: null },
    ];
    expect(MAX_ACTIVE_SOURCES).toBe(3);
    expect(canEnableMore(three)).toBe(false);
    expect(canEnableMore(three.map((s) => (s.id === 'sina' ? { ...s, enabled: false } : s)))).toBe(
      true,
    );
  });
});
