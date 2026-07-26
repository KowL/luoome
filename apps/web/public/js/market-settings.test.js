import { describe, expect, it } from 'bun:test';

import { activeSourceIds } from './market-settings.js';

describe('行情源路由排序', () => {
  it('只返回启用源并按 priority 排序', () => {
    expect(
      activeSourceIds([
        { id: 'eastmoney', enabled: true, priority: 2 },
        { id: 'adshare', enabled: false, priority: null },
        { id: 'tencent', enabled: true, priority: 1 },
      ]),
    ).toEqual(['tencent', 'eastmoney']);
  });
});
