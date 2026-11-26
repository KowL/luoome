/* apps/web/public/js/market-room-rotation.test.js —— 题材轮动纯函数（无 DOM）。 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  ROTATION_SCALES,
  rotationBatchIndex,
  rotationBoards,
  rotationCardHeight,
  rotationHash,
  rotationLeadersOf,
  rotationParamsFromHash,
  rotationQuery,
} from './market-room-rotation.js';

const at = '2026-11-25T02:45:00.000Z';

const theme = (id, order, dayValue, windowValue) => ({
  themeId: id,
  name: id,
  order,
  memberCount: 6,
  day: { value: dayValue, warnings: [] },
  window15: { value: windowValue, warnings: [] },
  leaders: { day: [], window: [] },
});

const rotation = (themes) => ({ state: 'ready', themes });

describe('rotationBoards 分排与定序', () => {
  it('上排只收涨、下排只收跌，各自从第一列起按幅度排列', () => {
    const boards = rotationBoards(
      rotation([
        theme('a', 0, 3),
        theme('b', 1, -4),
        theme('c', 2, 1),
        theme('d', 3, -2),
        theme('e', 4, 0),
        theme('f', 5, null),
      ]),
      'day',
    );
    expect(boards.up.map((entry) => [entry.theme.themeId, entry.value])).toEqual([
      ['a', 3],
      ['c', 1],
    ]);
    expect(boards.down.map((entry) => [entry.theme.themeId, entry.value])).toEqual([
      ['b', -4],
      ['d', -2],
    ]);
    // 持平和缺数不占列，只计数
    expect(boards.flat.map((entry) => entry.theme.themeId)).toEqual(['e']);
    expect(boards.missing.map((entry) => entry.theme.themeId)).toEqual(['f']);
  });

  it('同值按维护顺序与稳定 ID 定序，口径切换只换数值来源', () => {
    const data = rotation([
      theme('z', 2, 1.5, -3),
      theme('y', 1, 1.5, -3),
      theme('x', 1, 1.5, -3),
      theme('w', 0, -0.5, 2),
    ]);
    expect(rotationBoards(data, 'day').up.map((entry) => entry.theme.themeId)).toEqual([
      'x',
      'y',
      'z',
    ]);
    expect(rotationBoards(data, 'w15').down.map((entry) => entry.theme.themeId)).toEqual([
      'x',
      'y',
      'z',
    ]);
    expect(rotationBoards(data, 'w15').up.map((entry) => entry.theme.themeId)).toEqual(['w']);
  });

  it('缺数进缺数名单并带原因，不补 0', () => {
    const boards = rotationBoards(
      rotation([{ ...theme('m', 0, null, null), day: { value: null, warnings: ['no_members'] } }]),
      'day',
    );
    expect(boards.up).toEqual([]);
    expect(boards.down).toEqual([]);
    expect(boards.flat).toEqual([]);
    expect(boards.missing[0]?.metric?.warnings).toEqual(['no_members']);
  });
});

describe('rotationCardHeight 标尺', () => {
  it('v₀ 以内不加高，超出后按每 pp 单调增长', () => {
    const { min, perPp, zero } = ROTATION_SCALES.day;
    expect(rotationCardHeight('day', 0.4)).toBe(min.desktop);
    expect(rotationCardHeight('day', -1)).toBe(min.desktop);
    expect(rotationCardHeight('day', 3)).toBe(min.desktop + perPp * (3 - zero));
    expect(rotationCardHeight('day', 2.2)).toBeGreaterThan(rotationCardHeight('day', 1.5));
  });

  it('同一幅度上下同高，封顶后数字仍可显示（高度停在 h_max）', () => {
    expect(rotationCardHeight('day', 4.4)).toBe(rotationCardHeight('day', -4.4));
    expect(rotationCardHeight('day', 99)).toBe(ROTATION_SCALES.day.max.desktop);
    expect(rotationCardHeight('w15', 99)).toBe(ROTATION_SCALES.w15.max.desktop);
  });

  it('窄屏一套常量，缺数取 h_min', () => {
    expect(rotationCardHeight('day', null, true)).toBe(ROTATION_SCALES.day.min.narrow);
    expect(rotationCardHeight('day', 3, true)).toBe(
      ROTATION_SCALES.day.min.narrow + ROTATION_SCALES.day.perPp * (3 - ROTATION_SCALES.day.zero),
    );
    expect(rotationCardHeight('w15', 0.3, true)).toBe(ROTATION_SCALES.w15.min.narrow);
  });

  it('高度只由题材自身幅度决定：与个股数量、其他题材极值无关', () => {
    const alone = rotationCardHeight('w15', 0.9);
    const besideExtremes = rotationCardHeight('w15', 0.9);
    expect(alone).toBe(besideExtremes);
    expect(rotationCardHeight('w15', 0.9)).toBeLessThan(rotationCardHeight('w15', 3));
  });
});

describe('时间轴批次', () => {
  const batches = [
    { sampledAt: '2026-11-25T01:30:00.000Z', complete: true },
    { sampledAt: '2026-11-25T01:45:00.000Z', complete: true },
    { sampledAt: '2026-11-25T02:45:00.000Z', complete: true },
  ];

  it('渲染时点对齐到批次下标', () => {
    expect(rotationBatchIndex(batches, { sampledAt: batches[1].sampledAt })).toBe(1);
    expect(rotationBatchIndex(batches, { sampledAt: '2026-11-25T02:10:00.000Z' })).toBe(1);
    expect(rotationBatchIndex(batches, null)).toBe(2);
    expect(rotationBatchIndex([], null)).toBe(0);
  });

  it('回拖后仍能向前选择当日更晚的已发布批次（批次清单独立于选中时点）', () => {
    const params = rotationParamsFromHash(
      `#market-room?tab=overview&metric=day&at=${encodeURIComponent('2026-11-25T01:45:00.000Z')}`,
    );
    expect(params).toMatchObject({ metric: 'day', theme: null });
    expect(rotationBatchIndex(batches, { sampledAt: params.at.toISOString() })).toBe(1);
    expect(batches.at(-1)?.sampledAt).toBe('2026-11-25T02:45:00.000Z');
  });
});

describe('轮动图深链接', () => {
  it('默认近 15 分钟，非法口径回退', () => {
    expect(rotationParamsFromHash('#market-room?tab=overview').metric).toBe('w15');
    expect(rotationParamsFromHash('#market-room?tab=overview&metric=w5').metric).toBe('w15');
    expect(rotationParamsFromHash(`#market-room?metric=day&at=${encodeURIComponent(at)}`)).toEqual({
      metric: 'day',
      theme: null,
      at: new Date(at),
    });
  });

  it('请求固定 15 分钟口径，展开题材时按需带成分 id', () => {
    expect(rotationQuery({ metric: 'day', theme: null, at: null })).toBe('?window=w15');
    const query = rotationQuery({ metric: 'day', theme: 'ai-computing', at: new Date(at) });
    expect(query).toContain('window=w15');
    expect(query).toContain('themeId=ai-computing');
    expect(query).toContain('at=');
  });

  it('切换口径只改 metric，保留 tab / theme / at', () => {
    const hash = rotationHash(
      { metric: 'day' },
      `#market-room?tab=overview&theme=ai&at=${encodeURIComponent(at)}`,
    );
    expect(hash).toContain('tab=overview');
    expect(hash).toContain('theme=ai');
    expect(hash).toContain('metric=day');
    expect(hash).toContain('at=');
  });

  it('卡内个股读当前口径的一侧列表', () => {
    const row = {
      themeId: 't',
      leaders: { day: [{ stockId: '600519.SH' }], window: [{ stockId: '000001.SZ' }] },
    };
    expect(rotationLeadersOf(row, 'day')).toEqual([{ stockId: '600519.SH' }]);
    expect(rotationLeadersOf(row, 'w15')).toEqual([{ stockId: '000001.SZ' }]);
    expect(rotationLeadersOf({ themeId: 't' }, 'w15')).toEqual([]);
  });
});

describe('总览题材区接线', () => {
  const source = readFileSync(new URL('./market-room.js', import.meta.url), 'utf8');
  const rotationSource = readFileSync(
    new URL('./market-room-rotation.js', import.meta.url),
    'utf8',
  );
  const styleSource = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

  it('总览挂载轮动图，时间轴改 hash 用 replaceState 且只让最新选择落屏', () => {
    expect(source).toContain('renderOverviewThemePane(rotation, rotationParamsFromHash()');
    expect(source).toContain('hashWithReplayAt(at)');
    expect(source).toContain('window.history.replaceState');
    expect(source).toContain('seekTimer = setTimeout');
    expect(source).toContain('options.token !== seekToken');
    // 迟到的轮询 / 拖动响应不能把另一个时点画进当前选择
    expect(source).toContain('isCurrentReplayAt(at)');
    expect(rotationSource).toContain("range.addEventListener('input'");
    expect(rotationSource).toContain('updateOverviewThemePane');
  });

  it('卡内个股与题材名都是原生 button，两排是有序列表', () => {
    expect(rotationSource).toContain("el('button', 'room-rotation-card-name')");
    expect(rotationSource).toContain("el('button', 'room-rotation-stock')");
    expect(rotationSource).toContain('room-rotation-board-up');
    expect(rotationSource).toContain('涨幅榜（');
    expect(rotationSource).toContain('跌幅榜（');
    expect(rotationSource).toContain("aria-label', '行情批次时间轴'");
    expect(rotationSource).toContain('aria-valuetext');
    // 只有真实指针拖动期间才不回写滑块位置
    expect(rotationSource).toContain('__pointerScrubbing');
  });

  it('题材名与涨幅固定在卡片顶部，不显示编号，个股不再被 CSS 反向', () => {
    expect(rotationSource).toContain("el('div', 'room-rotation-card-head'");
    expect(rotationSource).not.toContain('room-rotation-rank');
    expect(rotationSource).not.toContain('entry.rank');
    expect(styleSource).not.toContain('.room-rotation-card-up .room-rotation-stocks');
    expect(styleSource).not.toContain('flex-direction: column-reverse');
  });
});
