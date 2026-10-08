/* apps/web/public/js/market-facts.test.js —— 图表事实纯函数测试（设计 §14.4）。
 * renderMarkers 的 DOM 构造 / 展开交互由浏览器验收覆盖，不在此处断言。 */

import { describe, expect, it } from 'bun:test';

import { groupMarkers, markerLabel } from './market-facts.js';

const marker = (date, factKind, factId, tone = 'fact', title = '策略信号 buy') => ({
  date,
  factKind,
  factId,
  title,
  href: '#strategy',
  tone,
});

describe('图表事实分组', () => {
  it('同日同类合并为一组，组顺序保持首条出现顺序', () => {
    const groups = groupMarkers([
      marker('2026-07-24', 'strategy-signal', 's1'),
      marker('2026-07-23', 'trade', 't1', 'action', '交易 buy'),
      marker('2026-07-24', 'strategy-signal', 's2'),
    ]);
    expect(groups.map((group) => [group.date, group.factKind, group.items.length])).toEqual([
      ['2026-07-24', 'strategy-signal', 2],
      ['2026-07-23', 'trade', 1],
    ]);
  });

  it('同日不同类不合并', () => {
    const groups = groupMarkers([
      marker('2026-07-24', 'strategy-signal', 's1'),
      marker('2026-07-24', 'advice', 'a1', 'advice', 'Advice buy'),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('同日同类不同方向拆成两组，方向随组透出', () => {
    const groups = groupMarkers([
      { ...marker('2026-07-24', 'strategy-signal', 's1'), direction: 'bullish' },
      { ...marker('2026-07-24', 'strategy-signal', 's2'), direction: 'bearish' },
      { ...marker('2026-07-24', 'strategy-signal', 's3'), direction: 'bullish' },
    ]);
    expect(groups.map((group) => [group.direction, group.items.length])).toEqual([
      ['bullish', 2],
      ['bearish', 1],
    ]);
  });
});

describe('事实标签', () => {
  it('chip 文案为「日期 · 类型 · 标题」', () => {
    expect(markerLabel(marker('2026-07-24', 'strategy-signal', 's1'))).toBe(
      '2026-07-24 · 信号 · 策略信号 buy',
    );
  });

  it('未知类型回退「研究」，不凭空造类型名', () => {
    expect(markerLabel(marker('2026-07-24', 'research', 'r1'))).toContain('· 研究 · ');
  });
});
