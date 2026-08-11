/* apps/web/public/js/market.test.js —— 行情页纯函数测试（设计 §14.4）。
 * 覆盖 hash 解析/序列化、range 归一化、requestId 防旧响应覆盖、
 * 最近查看去重限 8、来源 / 时段 / 获取时间 / 成交量展示 helper。
 */

import { describe, expect, it } from 'bun:test';

import {
  buildMarketHash,
  buildMarketLink,
  changeClass,
  createRequestTracker,
  fetchedAtLabel,
  formatAmount,
  formatVolume,
  normalizeMarketGranularity,
  normalizeMarketRange,
  parseRouteHash,
  pushRecentView,
  sessionLabel,
  sourceLabel,
  sourceSummary,
} from './market.js';

describe('hash 参数解析与序列化', () => {
  it('深链接解析：? 前为 route，后为参数', () => {
    const { route, params } = parseRouteHash('#market?stockId=002594.SZ&range=3m');
    expect(route).toBe('market');
    expect(params.get('stockId')).toBe('002594.SZ');
    expect(params.get('range')).toBe('3m');
  });

  it('兼容现有纯 hash 路由（无参数）', () => {
    const { route, params } = parseRouteHash('#dashboard');
    expect(route).toBe('dashboard');
    expect(params.get('stockId')).toBeNull();
  });

  it('空 hash / 缺 # 前缀也可解析', () => {
    expect(parseRouteHash('').route).toBe('');
    expect(parseRouteHash('market?range=1y').route).toBe('market');
  });

  it('序列化与解析互逆', () => {
    const hash = buildMarketHash('002594.SZ', '6m');
    const { route, params } = parseRouteHash(`#${hash}`);
    expect(route).toBe('market');
    expect(params.get('stockId')).toBe('002594.SZ');
    expect(params.get('range')).toBe('6m');
  });

  it('历史复盘日期会保留在深链接中', () => {
    const hash = buildMarketHash('002594.SZ', '6m', '2026-07-24');
    const { params } = parseRouteHash(`#${hash}`);
    expect(params.get('date')).toBe('2026-07-24');
  });

  it('持仓 / 分组入口链接：完整 id + 默认 3m', () => {
    expect(buildMarketLink('002594.SZ')).toBe('#market?stockId=002594.SZ&range=3m');
    const { route, params } = parseRouteHash(buildMarketLink('600519.SH'));
    expect(route).toBe('market');
    expect(params.get('stockId')).toBe('600519.SH');
    expect(params.get('range')).toBe('3m');
  });

  it('granularity 深链接互逆：周 / 月保留在 hash 中', () => {
    for (const g of ['week', 'month']) {
      const hash = buildMarketHash('002594.SZ', '1y', null, g);
      const { route, params } = parseRouteHash(`#${hash}`);
      expect(route).toBe('market');
      expect(params.get('stockId')).toBe('002594.SZ');
      expect(params.get('range')).toBe('1y');
      expect(params.get('granularity')).toBe(g);
    }
  });

  it('granularity 为 day 时不出现在 hash（默认口径）', () => {
    const hash = buildMarketHash('002594.SZ', '3m', null, 'day');
    expect(hash).toBe('market?stockId=002594.SZ&range=3m');
    expect(parseRouteHash(`#${hash}`).params.get('granularity')).toBeNull();
  });
});

describe('range 归一化', () => {
  it('合法值原样保留', () => {
    for (const r of ['1m', '3m', '6m', '1y']) expect(normalizeMarketRange(r)).toBe(r);
  });

  it('非法 / 缺失值回退 3m', () => {
    expect(normalizeMarketRange(null)).toBe('3m');
    expect(normalizeMarketRange('1d')).toBe('3m');
    expect(normalizeMarketRange('')).toBe('3m');
  });
});

describe('granularity 归一化', () => {
  it('合法值原样保留', () => {
    for (const g of ['day', 'week', 'month']) expect(normalizeMarketGranularity(g)).toBe(g);
  });

  it('非法 / 缺失值回退 day', () => {
    expect(normalizeMarketGranularity(null)).toBe('day');
    expect(normalizeMarketGranularity('year')).toBe('day');
    expect(normalizeMarketGranularity('')).toBe('day');
  });
});

describe('requestId 防旧响应覆盖', () => {
  it('只有最新 requestId 是 current', () => {
    const tracker = createRequestTracker();
    const first = tracker.next();
    const second = tracker.next();
    expect(tracker.isCurrent(second)).toBe(true);
    expect(tracker.isCurrent(first)).toBe(false);
  });
});

describe('最近查看', () => {
  const stock = (id) => ({ id, code: id.split('.')[0], name: `股票${id}`, exchange: 'SZ' });

  it('新条目置顶，同 id 去重', () => {
    let list = pushRecentView([], stock('000001.SZ'));
    list = pushRecentView(list, stock('002594.SZ'));
    list = pushRecentView(list, stock('000001.SZ'));
    expect(list.map((s) => s.id)).toEqual(['000001.SZ', '002594.SZ']);
  });

  it('最多保留 8 条', () => {
    let list = [];
    for (let i = 0; i < 12; i += 1) list = pushRecentView(list, stock(`00000${i}.SZ`));
    expect(list.length).toBe(8);
    expect(list[0].id).toBe('0000011.SZ');
  });
});

describe('展示 helper', () => {
  it('来源文案：主源 / 备用源 / 未知', () => {
    expect(sourceLabel('eastmoney')).toBe('东方财富');
    expect(sourceLabel('tencent')).toBe('腾讯行情（备用源）');
    expect(sourceLabel('other')).toBe('other');
    expect(sourceLabel(undefined)).toBe('--');
  });

  it('混合来源展示 Quote 与日线的全部实际 provider', () => {
    expect(sourceSummary(['eastmoney', 'tencent'], 'eastmoney')).toBe(
      '东方财富 / 腾讯行情（备用源）',
    );
    expect(sourceSummary([], 'eastmoney')).toBe('东方财富');
    expect(sourceSummary(['tencent', 'tencent'], 'eastmoney')).toBe('腾讯行情（备用源）');
  });

  it('marketSession 文案；closed 是「已收盘」而非故障', () => {
    expect(sessionLabel('trading')).toBe('交易中');
    expect(sessionLabel('closed')).toBe('已收盘');
    expect(sessionLabel('non-trading-day')).toBe('非交易日');
    expect(sessionLabel('weird')).toBe('--');
  });

  it('获取时间只写「行情获取于 HH:mm:ss」，null 显示 --', () => {
    expect(fetchedAtLabel(null)).toBe('--');
    expect(fetchedAtLabel('not-a-date')).toBe('--');
    const label = fetchedAtLabel('2026-07-26T04:30:00.000Z');
    expect(label.startsWith('行情获取于 ')).toBe(true);
    expect(label).not.toContain('实时');
    expect(label).not.toContain('成交于');
  });

  it('成交量按股格式化为万 / 亿', () => {
    expect(formatVolume(12_345)).toBe('1.23万');
    expect(formatVolume(123_456_789)).toBe('1.23亿');
    expect(formatVolume(999)).toBe('999');
    expect(formatVolume(null)).toBe('--');
  });

  it('成交额按元格式化为万 / 亿', () => {
    expect(formatAmount(2_193_664_806)).toBe('21.94亿');
    expect(formatAmount(12_345)).toBe('1.23万');
    expect(formatAmount(999)).toBe('999');
    expect(formatAmount(undefined)).toBe('--');
  });

  it('涨跌配色：红涨绿跌沿用 text-pos / text-neg', () => {
    expect(changeClass(0.5)).toBe('text-pos');
    expect(changeClass(-0.5)).toBe('text-neg');
    expect(changeClass(0)).toBe('');
    expect(changeClass(null)).toBe('');
  });
});
