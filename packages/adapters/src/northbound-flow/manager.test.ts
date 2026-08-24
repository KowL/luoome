import type { Logger } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { NorthboundFlowManager } from './manager.js';
import type { NorthboundFlowCapabilityMap, NorthboundFlowFetchResult } from './types.js';

/**
 * NorthboundFlowManager 集成测试：fake binding 注入 registry，
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

const fetchResult = (endDate: string): NorthboundFlowFetchResult => ({
  endDate,
  entries: [
    {
      date: endDate,
      net_amount: null,
      buy_amount: null,
      sell_amount: null,
      deal_amount: 268_087_540_000,
    },
  ],
});

/** 生产 binding 的观测口径（§6.2）：dataAsOf = 最后一条交易日收盘时刻；空序列 success 无 dataAsOf。 */
const mkBinding = (
  name: string,
  impl: (endDate: string, days: number) => Promise<NorthboundFlowFetchResult>,
): AnyBinding<NorthboundFlowCapabilityMap> => ({
  capability: 'northbound-flow',
  source: name,
  coverage: ['CN_A_SHARES_SH_SZ'],
  configurationReady: true,
  execute: ({ endDate, days }) => impl(endDate, days),
  observationOf: (result) => {
    const last = result.entries.at(-1);
    if (last === undefined) return { outcome: 'success' };
    return { outcome: 'success', dataAsOf: new Date(`${last.date}T15:00:00+08:00`) };
  },
});

const mkManager = (
  fetches: readonly (readonly [
    string,
    (endDate: string, days: number) => Promise<NorthboundFlowFetchResult>,
  ])[],
) =>
  new NorthboundFlowManager({
    registry: new SourceRegistry<NorthboundFlowCapabilityMap>(
      fetches.map(([name, impl]) => mkBinding(name, impl)),
      CLOCK,
    ),
    logger: noopLogger,
    clock: CLOCK,
    holidaysProvider: async () => new Map(),
  });

describe('NorthboundFlowManager（registry 集成）', () => {
  it('唯一源成功：provenance 记录实际 source；dataAsOf 为最后一条交易日收盘时刻', async () => {
    const m = mkManager([['eastmoney', async (endDate) => fetchResult(endDate)]]);
    const r = await m.fetchSeries({ days: 30, endDate: TRADING_DAY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe('eastmoney');
    expect(r.data.days).toBe(1);

    const status = m.status()[0];
    expect(status?.dataset).toBe('northbound-flow');
    expect(status?.dataAsOf).toEqual(new Date('2026-08-21T07:00:00.000Z'));
    expect(status?.lastErrorKind).toBeUndefined();
  });

  it('空序列 success 但无 dataAsOf（freshness unknown，不用 endDate 冒充）', async () => {
    const m = mkManager([['eastmoney', async (endDate) => ({ endDate, entries: [] })]]);
    const r = await m.fetchSeries({ days: 30, endDate: TRADING_DAY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.warnings).toContain('empty-list');

    const status = m.status()[0];
    expect(status?.lastSuccessAt).toBeDefined();
    expect(status?.dataAsOf).toBeUndefined();
    expect(status?.lastErrorKind).toBeUndefined();
  });

  it('主源失败 → fallback 成功：按绑定顺序降级，provenance 为 fallback 源', async () => {
    const fallbackMock = vi.fn(async (endDate: string) => fetchResult(endDate));
    const m = mkManager([
      [
        'eastmoney',
        async () => {
          throw new Error('eastmoney down');
        },
      ],
      ['fuyao', fallbackMock],
    ]);
    const r = await m.fetchSeries({ days: 30, endDate: TRADING_DAY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe('fuyao');
    expect(m.status().find((s) => s.source === 'eastmoney')?.lastErrorKind).toBe('upstream_error');
  });

  it('全部失败 → adapter_error；显式 query.source 未启用 → adapter_error', async () => {
    const m = mkManager([
      [
        'eastmoney',
        async () => {
          throw new Error('eastmoney down');
        },
      ],
    ]);
    const failed = await m.fetchSeries({ days: 30, endDate: TRADING_DAY });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.kind).toBe('adapter_error');
      expect(failed.error.message).toContain('eastmoney down');
    }

    const disabled = await m.fetchSeries({ days: 30, endDate: TRADING_DAY, source: 'tushare' });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.kind).toBe('adapter_error');
  });
});
