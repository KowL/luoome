/* apps/web/public/js/market-facts.test.js —— 图表事实纯函数测试（设计 §14.4）。
 * renderMarkers 的 DOM 构造 / 展开交互由浏览器验收覆盖，不在此处断言。 */

import { describe, expect, it } from 'bun:test';

import { collapseSignalRuns, groupMarkers, markerLabel } from './market-facts.js';

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

describe('连续信号合并', () => {
  const signal = (date, id, ruleId = 'rule-a', direction = 'bearish') => ({
    ...marker(date, 'strategy-signal', id),
    direction,
    ruleId: ruleId,
  });

  it('同规则同方向相邻交易日（含周末间隔）合并为一条 run', () => {
    const { runs, rest } = collapseSignalRuns([
      signal('2026-09-03', 's1'), // 周四
      signal('2026-09-04', 's2'), // 周五
      signal('2026-09-07', 's3'), // 下周一，间隔 3 天仍在连续口径内
      signal('2026-09-08', 's4'),
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ start: '2026-09-03', end: '2026-09-08', days: 4 });
    expect(rest).toHaveLength(0);
  });

  it('间隔超过 4 个自然日断开为两段；不足 3 天的段回到按日分组', () => {
    const { runs, rest } = collapseSignalRuns([
      signal('2026-09-01', 's1'),
      signal('2026-09-02', 's2'),
      signal('2026-09-10', 's3'), // 间隔 8 天（如长假），断开
      signal('2026-09-11', 's4'),
      signal('2026-09-14', 's5'),
    ]);
    expect(runs.map((run) => [run.start, run.end, run.days])).toEqual([
      ['2026-09-10', '2026-09-14', 3],
    ]);
    expect(rest.map((m) => m.factId)).toEqual(['s1', 's2']);
  });

  it('不同规则 / 不同方向不互相合并；非信号与缺 ruleId 的事实不参与', () => {
    const { runs, rest } = collapseSignalRuns([
      signal('2026-09-03', 's1', 'rule-a'),
      signal('2026-09-04', 's2', 'rule-a'),
      signal('2026-09-07', 's3', 'rule-a'),
      signal('2026-09-03', 's4', 'rule-b'),
      signal('2026-09-04', 's5', 'rule-a', 'bullish'),
      marker('2026-09-03', 'advice', 'a1', 'advice', 'Advice buy'),
      marker('2026-09-04', 'strategy-signal', 's6'), // 旧数据无 ruleId
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0].items.map((m) => m.factId)).toEqual(['s1', 's2', 's3']);
    expect(rest.map((m) => m.factId)).toEqual(['a1', 's6', 's4', 's5']);
  });
});
