/* apps/web/public/js/market-room-themes.test.js —— 系统题材视图纯函数。 */

import { describe, expect, it } from 'bun:test';

import {
  themeLibraryEmptyText,
  themeLibraryHash,
  themeLibraryMetaText,
  themeLibraryParamsFromHash,
  themeLibraryQuery,
  trendPolyline,
} from './market-room-themes.js';

const at = '2026-11-25T02:00:00.000Z';

describe('theme library view params', () => {
  it('keeps window, expanded theme and replay at from the hash', () => {
    const params = themeLibraryParamsFromHash(
      `#market-room?tab=overview&window=w5&theme=ai-computing&at=${at}`,
    );
    expect(params).toEqual({ window: 'w5', theme: 'ai-computing', at: new Date(at) });
    expect(themeLibraryQuery(params)).toBe(
      `?window=w5&themeId=ai-computing&at=${encodeURIComponent('2026-11-25T02:00:00.000Z')}`,
    );
  });

  it('falls back to w15 for unknown windows', () => {
    expect(themeLibraryParamsFromHash('#market-room?tab=sectors&window=bad')).toMatchObject({
      window: 'w15',
      theme: null,
    });
  });

  it('only changes the theme parameter and keeps the current tab', () => {
    const hash = '#market-room?tab=sectors&kind=concept&window=w15&at=2026-11-25T02%3A00%3A00.000Z';
    const expanded = themeLibraryHash('ai-computing', hash);
    expect(expanded).toContain('tab=sectors');
    expect(expanded).toContain('kind=concept');
    expect(expanded).toContain('theme=ai-computing');
    expect(expanded).toContain('at=2026-11-25T02%3A00%3A00.000Z');
    expect(themeLibraryHash(null, `#${expanded}`)).not.toContain('theme=');
  });
});

describe('theme library copy', () => {
  it('explains empty states without fabricating data', () => {
    expect(themeLibraryEmptyText(null)).toContain('读取系统题材行情失败');
    expect(themeLibraryEmptyText({ state: 'empty', emptyReason: 'no_theme_library' })).toContain(
      '设置 → 题材库',
    );
    expect(themeLibraryEmptyText({ state: 'empty', emptyReason: 'no_members' })).toContain(
      '没有生效成分',
    );
  });

  it('summarises ready state with fixed order count', () => {
    const text = themeLibraryMetaText({
      state: 'ready',
      tradingDate: '2026-11-25',
      anchor: { sampledAt: at },
      themes: [{}, {}],
    });
    expect(text).toContain('2026-11-25');
    expect(text).toContain('固定顺序 2 个');
  });
});

describe('trendPolyline', () => {
  it('skips missing points without interpolation and scales available values', () => {
    const result = trendPolyline([{ value: null }, { value: 0 }, { value: 2 }, { value: 1 }]);
    expect(result.line).toEqual([
      [40, 28],
      [80, 0],
      [120, 14],
    ]);
    expect(result).toMatchObject({ min: 0, max: 2 });
  });

  it('returns an empty line when every point is missing', () => {
    expect(trendPolyline([{ value: null }])).toEqual({ line: [], min: null, max: null });
  });
});
