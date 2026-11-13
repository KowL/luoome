/* apps/web/public/js/market-room-return.test.js —— 作战室 ↔ 个股页返回现场（ticket #44）。 */

import { describe, expect, it } from 'bun:test';

import { appendReturnTo, returnLabel, returnToFromHash, stockHref } from './market-room-return.js';
import {
  memberRowCells,
  sectorDetailHash,
  sectorDetailParamsFromHash,
} from './market-room-sector-detail.js';

const at = new Date('2026-09-28T10:15:00+08:00');
const ROOM_HASH =
  'market-room?tab=sectors&kind=concept&sort=window5&window=w5&sector=concept-ai&compare=industry-bank&at=2026-09-28T02%3A15%3A00.000Z';

describe('返回链接与现场编码', () => {
  it('个股页链接默认不带 returnTo，保持既有口径', () => {
    expect(stockHref('600519.SH')).toBe('#market?stockId=600519.SH&range=3m');
    expect(stockHref('600519.SH', null)).toBe('#market?stockId=600519.SH&range=3m');
  });

  it('returnTo 完整编码当前作战室 hash（含 at / 分类 / 排序 / 窗口 / 板块 / 对照）', () => {
    const href = stockHref('600519.SH', ROOM_HASH);
    expect(href).toBe(
      `#market?stockId=600519.SH&range=3m&returnTo=${encodeURIComponent(ROOM_HASH)}`,
    );
    expect(returnToFromHash(href)).toBe(ROOM_HASH);
  });

  it('从个股页返回后，板块详情现场逐项还原', () => {
    const restored = returnToFromHash(stockHref('600519.SH', ROOM_HASH));
    const params = new URLSearchParams((restored ?? '').split('?')[1] ?? '');
    expect(params.get('tab')).toBe('sectors');
    expect(params.get('kind')).toBe('concept');
    expect(params.get('sort')).toBe('window5');
    expect(params.get('window')).toBe('w5');
    expect(sectorDetailParamsFromHash(`#${restored}`)).toEqual({
      sectorId: 'concept-ai',
      compareSectorIds: ['industry-bank'],
      at,
    });
    // 板块详情深链接本身也保留同一组现场，两个方向都可复制。
    expect(
      sectorDetailParamsFromHash(
        `#${sectorDetailHash({
          kind: 'concept',
          sort: 'window5',
          window: 'w5',
          sectorId: 'concept-ai',
          compareSectorIds: ['industry-bank'],
          at,
        })}`,
      ),
    ).toEqual({ sectorId: 'concept-ai', compareSectorIds: ['industry-bank'], at });
    expect(memberRowCells({ ...memberFixture() }, restored).href).toBe(
      `#market?stockId=${encodeURIComponent('600519.SH')}&range=3m&returnTo=${encodeURIComponent(ROOM_HASH)}`,
    );
  });

  it('只接受作战室深链接，其它 returnTo 一律忽略', () => {
    expect(returnToFromHash('#market?stockId=600519.SH&range=3m')).toBeNull();
    expect(returnToFromHash('#market?returnTo=dashboard')).toBeNull();
    expect(returnToFromHash('#market?returnTo=https%3A%2F%2Fevil.example')).toBeNull();
    expect(returnToFromHash('#market?returnTo=market-room-other%3Ftab%3Devents')).toBeNull();
    expect(returnToFromHash('#market?returnTo=%20%20')).toBeNull();
    expect(returnToFromHash('')).toBeNull();
    expect(returnToFromHash(undefined)).toBeNull();
  });

  it('保留 returnTo 切换行情周期 / 粒度，退出战场时丢弃', () => {
    expect(appendReturnTo('market?stockId=600519.SH&range=1m', ROOM_HASH)).toBe(
      `market?stockId=600519.SH&range=1m&returnTo=${encodeURIComponent(ROOM_HASH)}`,
    );
    expect(appendReturnTo('market?stockId=600519.SH&range=3m&granularity=week', null)).toBe(
      'market?stockId=600519.SH&range=3m&granularity=week',
    );
    expect(appendReturnTo('market?stockId=600519.SH&range=3m', '')).toBe(
      'market?stockId=600519.SH&range=3m',
    );
  });
});

describe('返回入口文案', () => {
  it('按 tab / 选中板块 / 回放时点生成可读文案', () => {
    expect(returnLabel('market-room')).toBe('返回作战室');
    expect(returnLabel('market-room?tab=turnover')).toBe('返回作战室 · 成交分布');
    expect(returnLabel('market-room?tab=sectors')).toBe('返回作战室 · 板块追踪');
    expect(returnLabel('market-room?tab=sectors&sector=concept-ai')).toBe('返回作战室 · 板块详情');
    expect(returnLabel(ROOM_HASH)).toBe('返回作战室 · 板块详情 · 回放 10:15');
    expect(returnLabel('market-room?tab=events&at=2026-09-28T02%3A15%3A00.000Z')).toBe(
      '返回作战室 · 盘中事件 · 回放 10:15',
    );
  });

  it('非法 or 缺省现场只给基础文案', () => {
    expect(returnLabel(null)).toBe('返回作战室');
    expect(returnLabel('market-room?tab=unknown')).toBe('返回作战室 · 总览');
    expect(returnLabel('market-room?at=oops')).toBe('返回作战室 · 总览');
  });
});

const memberFixture = () => ({
  stockId: '600519.SH',
  code: '600519',
  name: '贵州茅台',
  memberStatus: 'listed',
  inBatch: true,
  dayChangePct: 1.23,
  windowChangePct: -0.45,
  windowAmountDelta: 150_000_000,
  windowAmountSharePct: 42.5,
  sealed: true,
  ladderLevel: 2,
  warnings: [],
});
