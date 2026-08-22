import type { Logger } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { invalidPayloadError } from '../source-error.js';
import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { DragonTigerManager } from './manager.js';
import type { DragonTigerCapabilityMap, DragonTigerFetchResult } from './types.js';

/**
 * DragonTigerManager 集成测试：fake binding 注入 registry，
 * 验证降级顺序、实际 source provenance、status() 输出与 §6.2 dataAsOf 口径。
 */

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CLOCK = () => new Date('2026-08-21T08:00:00.000Z'); // 上海 16:00，已收盘
const TRADING_DAY = '2026-08-21';

const fetchResult = (date: string): DragonTigerFetchResult => ({
  date,
  observedAt: new Date(`${date}T07:00:00.000Z`),
  entries: [
    {
      code: '600547',
      name: '山东黄金',
      close: 37.05,
      change_pct: 0.049575,
      turnover_rate: 0.041323,
      reason: '涨幅偏离',
      net_amount: 855648751.87,
      buy_amount: 3371674861.76,
      sell_amount: 2516026109.89,
      amount: 17302349779,
      trade_date: date,
    },
  ],
});

/** 生产 binding 的观测与信封口径（§6.2）：错日 invalid_payload，成功带 observedAt。 */
const mkBinding = (
  name: string,
  impl: (date: string) => Promise<DragonTigerFetchResult>,
): AnyBinding<DragonTigerCapabilityMap> => ({
  capability: 'dragon-tiger-list',
  source: name,
  coverage: ['CN_A_SHARES_SH_SZ'],
  configurationReady: true,
  execute: async ({ date }) => {
    const result = await impl(date);
    if (result.date !== date) {
      throw invalidPayloadError(`dragon-tiger 信封日期错配: 返回 ${result.date}，请求 ${date}`);
    }
    return result;
  },
  observationOf: (result) => ({ outcome: 'success', dataAsOf: result.observedAt }),
});

const mkManager = (
  fetches: readonly (readonly [string, (date: string) => Promise<DragonTigerFetchResult>])[],
) =>
  new DragonTigerManager({
    registry: new SourceRegistry<DragonTigerCapabilityMap>(
      fetches.map(([name, impl]) => mkBinding(name, impl)),
      CLOCK,
    ),
    logger: noopLogger,
    clock: CLOCK,
    holidaysProvider: async () => new Map(),
  });

describe('DragonTigerManager（registry 集成）', () => {
  it('唯一源成功：结果 provenance 记录实际 source，status() 带 dataAsOf', async () => {
    const m = mkManager([['eastmoney', async (date) => fetchResult(date)]]);
    const r = await m.fetchList({ date: TRADING_DAY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe('eastmoney');
    expect(r.data.total).toBe(1);

    const status = m.status();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      dataset: 'dragon-tiger-list',
      source: 'eastmoney',
      coverage: ['CN_A_SHARES_SH_SZ'],
    });
    expect(status[0]?.dataAsOf).toEqual(new Date('2026-08-21T07:00:00.000Z'));
    expect(status[0]?.lastErrorKind).toBeUndefined();
  });

  it('主源失败 → fallback 成功：按绑定顺序降级，provenance 为 fallback 源', async () => {
    const fallbackMock = vi.fn(async (date: string) => fetchResult(date));
    const m = mkManager([
      [
        'eastmoney',
        async () => {
          throw new Error('eastmoney down');
        },
      ],
      ['fuyao', fallbackMock],
    ]);
    const r = await m.fetchList({ date: TRADING_DAY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe('fuyao');
    expect(fallbackMock).toHaveBeenCalledTimes(1);

    const status = m.status();
    expect(status.find((s) => s.source === 'eastmoney')?.lastErrorKind).toBe('upstream_error');
    expect(status.find((s) => s.source === 'fuyao')?.lastErrorKind).toBeUndefined();
  });

  it('全部失败 → adapter_error（含最后一个错误消息）', async () => {
    const m = mkManager([
      [
        'eastmoney',
        async () => {
          throw new Error('eastmoney down');
        },
      ],
    ]);
    const r = await m.fetchList({ date: TRADING_DAY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('adapter_error');
    expect(r.error.message).toContain('eastmoney down');
  });

  it('信封错日 → invalid_payload 记 failure 并继续 fallback（§6.2）', async () => {
    const m = mkManager([
      ['eastmoney', async () => fetchResult('2026-08-20')], // 错日
      ['fuyao', async (date) => fetchResult(date)],
    ]);
    const r = await m.fetchList({ date: TRADING_DAY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe('fuyao');
    expect(m.status().find((s) => s.source === 'eastmoney')?.lastErrorKind).toBe('invalid_payload');
  });

  it('合法空榜为 success 且带真实 dataAsOf', async () => {
    const m = mkManager([
      [
        'eastmoney',
        async (date) => ({ date, observedAt: new Date(`${date}T07:00:00Z`), entries: [] }),
      ],
    ]);
    const r = await m.fetchList({ date: TRADING_DAY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.warnings).toEqual(['empty-list']);
    const status = m.status()[0];
    expect(status?.lastErrorKind).toBeUndefined();
    expect(status?.dataAsOf).toEqual(new Date('2026-08-21T07:00:00.000Z'));
  });

  it('显式 query.source 未启用 → adapter_error；非交易日早退不写观测', async () => {
    const fetchMock = vi.fn(async (date: string) => fetchResult(date));
    const m = mkManager([['eastmoney', fetchMock]]);

    const disabled = await m.fetchList({ date: TRADING_DAY, source: 'tushare' });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.kind).toBe('adapter_error');
    expect(fetchMock).not.toHaveBeenCalled();

    // 2026-08-22 周六 → 非交易日
    const weekend = await m.fetchList({ date: '2026-08-22' });
    expect(weekend.ok).toBe(true);
    if (weekend.ok) {
      expect(weekend.data?.source).toBe('eastmoney'); // 配置首项
      expect(weekend.data?.warnings).toEqual(['non-trading-day']);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(m.status()[0]?.lastAttemptAt).toBeUndefined();
  });
});
