/* apps/web/public/js/dragon-tiger-flow.test.js —— 资金流向拓扑视图纯函数单测。 */

import { describe, expect, it } from 'bun:test';

import {
  assignConceptColors,
  axisRange,
  dayLabel,
  flowErrorHint,
  flowWarningText,
  formatSignedYi,
  formatYi,
  layoutLabels,
  nearestPoint,
  topConcepts,
} from './dragon-tiger-flow.js';

const concept = (name, netAmount, extra = {}) => ({
  name,
  netAmount,
  orgNetAmount: 0,
  hotNetAmount: 0,
  otherNetAmount: netAmount,
  series: [],
  stocks: [],
  stockCount: 0,
  ...extra,
});

describe('formatYi / formatSignedYi', () => {
  it('元 → 亿元，带符号', () => {
    expect(formatYi(123_000_000)).toBe('1.23亿');
    expect(formatSignedYi(123_000_000)).toBe('+1.23亿');
    expect(formatSignedYi(-45_000_000)).toBe('-0.45亿');
    expect(formatSignedYi(0)).toBe('0.00亿');
  });

  it('非数字 → --', () => {
    expect(formatYi(Number.NaN)).toBe('--');
    expect(formatSignedYi(undefined)).toBe('--');
    expect(formatSignedYi(null)).toBe('--');
  });
});

describe('topConcepts', () => {
  it('按净额绝对值降序截断，不改写原数组', () => {
    const list = [concept('A', 10), concept('B', -50), concept('C', 30)];
    const top = topConcepts(list, 2);
    expect(top.map((item) => item.name)).toEqual(['B', 'C']);
    expect(list.map((item) => item.name)).toEqual(['A', 'B', 'C']);
  });

  it('非数组 / 含 null → 安全降级', () => {
    expect(topConcepts(null)).toEqual([]);
    expect(topConcepts([null, concept('A', 1)])).toHaveLength(1);
  });
});

describe('assignConceptColors', () => {
  it('净流入用红系、净流出用绿系，同色系内按排名换色', () => {
    const colors = assignConceptColors([concept('A', 10), concept('B', -10), concept('C', 5)]);
    expect(colors.get('A')).toBe('#e0484f');
    expect(colors.get('B')).toBe('#0f9d58');
    expect(colors.get('C')).toBe('#c62f3c');
  });

  it('0 归入流入色系（与后端 >= 0 口径一致）', () => {
    expect(assignConceptColors([concept('Z', 0)]).get('Z')).toBe('#e0484f');
  });
});

describe('axisRange', () => {
  it('包含 0 并留出余量', () => {
    const range = axisRange([10, 30]);
    expect(range.min).toBeLessThan(0);
    expect(range.max).toBeGreaterThan(30);
  });

  it('全 0 / 空输入 → 对称区间，避免除零', () => {
    expect(axisRange([0, 0])).toEqual({ min: -1.16, max: 1.16 });
    expect(axisRange([])).toEqual({ min: -1.16, max: 1.16 });
  });
});

describe('layoutLabels', () => {
  it('压开最小间距并保持在绘图区内', () => {
    const labels = layoutLabels(
      [
        { name: 'A', y: 100 },
        { name: 'B', y: 102 },
        { name: 'C', y: 104 },
      ],
      { top: 10, bottom: 200, minGap: 18 },
    );
    const ys = labels.map((label) => label.y);
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(18);
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(18);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...ys)).toBeLessThanOrEqual(200);
  });

  it('底部越界 → 整体上推，顶部仍不越界', () => {
    const labels = layoutLabels(
      [
        { name: 'A', y: 190 },
        { name: 'B', y: 195 },
        { name: 'C', y: 198 },
      ],
      { top: 10, bottom: 200, minGap: 18 },
    );
    expect(Math.max(...labels.map((label) => label.y))).toBeLessThanOrEqual(200);
    expect(Math.min(...labels.map((label) => label.y))).toBeGreaterThanOrEqual(10);
  });
});

describe('nearestPoint', () => {
  const points = [
    { x: 10, y: 10, concept: 'A' },
    { x: 100, y: 100, concept: 'B' },
  ];

  it('命中半径内最近点', () => {
    expect(nearestPoint(points, 12, 12)?.concept).toBe('A');
    expect(nearestPoint(points, 96, 104)?.concept).toBe('B');
  });

  it('超出半径 → null', () => {
    expect(nearestPoint(points, 200, 200)).toBeNull();
    expect(nearestPoint([], 0, 0)).toBeNull();
  });
});

describe('flowErrorHint', () => {
  it('404 → 提示重启 luoome web（旧进程没有新路由）', () => {
    const hint = flowErrorHint({ kind: 'internal', cause: 'HTTP 404' });
    expect(hint.kind).toBe('route-missing');
    expect(hint.title).toContain('接口未加载');
    expect(hint.detail).toContain('luoome restart');
  });

  it('缺 FUYAO_API_KEY → 配置引导', () => {
    const hint = flowErrorHint({
      kind: 'invalid_input',
      message: '... 需要 FUYAO_API_KEY',
    });
    expect(hint.kind).toBe('config');
  });

  it('上游失败 → adapter_error 文案', () => {
    const hint = flowErrorHint({ kind: 'adapter_error', message: 'down' });
    expect(hint.detail).toContain('暂不可用');
  });
});

describe('flowWarningText', () => {
  it('warning 码 → 中文文案', () => {
    expect(flowWarningText(['calendar-fallback'])).toContain('回退内置节假日历');
    expect(flowWarningText(['non-trading-day:2026-11-08'])).toContain('2026-11-08 非交易日');
    expect(flowWarningText(['partial-data:2'])).toContain('2 个交易日');
    expect(flowWarningText(['latest-day-pending:1'])).toContain('1 个最近交易日');
    expect(flowWarningText(['future-date:2026-12-01'])).toContain('2026-12-01 晚于今天');
    expect(flowWarningText(['calendar-short:3'])).toContain('3 个交易日');
    expect(flowWarningText(['empty-list'])).toContain('无上榜数据');
    expect(flowWarningText([])).toBe('');
    expect(flowWarningText(undefined)).toBe('');
  });
});

describe('dayLabel', () => {
  it('右端为 D-0', () => {
    expect(dayLabel(0, 10)).toBe('D-9');
    expect(dayLabel(9, 10)).toBe('D-0');
    expect(dayLabel(15, 10)).toBe('D-0');
  });
});
