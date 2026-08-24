import type { Logger, NorthboundFlowQuery } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';
import { createNorthboundFlowManagerFromEnv } from './factory.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 2026-08-21 是周五且不在内置 2026 休市日中，可作为真实交易日。 */
const TRADING_DAY = '2026-08-21';

const baseQuery: NorthboundFlowQuery = {
  days: 30,
  endDate: TRADING_DAY,
  source: 'eastmoney',
};

const channelFixture = (channel: '001' | '003') => ({
  success: true,
  result: {
    pages: 1,
    data: [
      {
        MUTUAL_TYPE: channel,
        TRADE_DATE: '2026-08-21 00:00:00',
        NET_DEAL_AMT: null,
        BUY_AMT: null,
        SELL_AMT: null,
        DEAL_AMT: 125846.52,
      },
    ],
  },
});

const okJson = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe('createNorthboundFlowManagerFromEnv', () => {
  it('不配置任何 env 也返回可用的 northbound-flow manager', () => {
    const m = createNorthboundFlowManagerFromEnv({}, { logger: noopLogger });
    expect(m.name).toBe('northbound-flow');
    expect(typeof m.fetchSeries).toBe('function');
    expect(m.sources).toEqual(['eastmoney']);
  });

  it('配置未注册数据源时启动期失败，不做隐式 Eastmoney fallback', () => {
    expect(() =>
      createNorthboundFlowManagerFromEnv(
        { LUOOME_NORTHBOUND_FLOW_SOURCES: 'tushare' },
        { logger: noopLogger },
      ),
    ).toThrow();
  });

  it('重复数据源在启动期失败', () => {
    expect(() =>
      createNorthboundFlowManagerFromEnv(
        { LUOOME_NORTHBOUND_FLOW_SOURCES: 'eastmoney,eastmoney' },
        { logger: noopLogger },
      ),
    ).toThrow();
  });

  it('注入共享 EastmoneySource 时复用该实例，不再用 deps.fetchImpl 自构', async () => {
    const injectedFetch = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      return u.includes('MUTUAL_TYPE%3D%22001%22')
        ? okJson(channelFixture('001'))
        : okJson(channelFixture('003'));
    }) as unknown as typeof fetch;
    const selfConstructFetch = vi.fn(async () => {
      throw new Error('must not self-construct');
    }) as unknown as typeof fetch;

    const m = createNorthboundFlowManagerFromEnv(
      {},
      {
        logger: noopLogger,
        fetchImpl: selfConstructFetch,
        sources: { eastmoney: new EastmoneySource({ fetchImpl: injectedFetch }) },
      },
    );
    const r = await m.fetchSeries(baseQuery);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.source).toBe('eastmoney');
    expect(r.data?.days).toBe(1);
    expect(injectedFetch).toHaveBeenCalled();
    expect(selfConstructFetch).not.toHaveBeenCalled();
  });

  it('status() 暴露 registry 观测（binding 未执行时无执行事实）', () => {
    const m = createNorthboundFlowManagerFromEnv({}, { logger: noopLogger });
    const status = m.status();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      dataset: 'northbound-flow',
      source: 'eastmoney',
      coverage: ['CN_A_SHARES_SH_SZ'],
    });
  });

  it('fetchImpl 返回报表 fixture 时 fetchSeries 返回合并后的日级序列', async () => {
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      return u.includes('MUTUAL_TYPE%3D%22001%22')
        ? okJson(channelFixture('001'))
        : okJson(channelFixture('003'));
    }) as unknown as typeof fetch;

    const m = createNorthboundFlowManagerFromEnv({}, { logger: noopLogger, fetchImpl });
    const r = await m.fetchSeries(baseQuery);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data;
    expect(data).toBeDefined();
    if (data === undefined) return;

    expect(data.endDate).toBe(TRADING_DAY);
    expect(data.source).toBe('eastmoney');
    expect(data.days).toBe(1);

    const entry = data.series[0];
    expect(entry?.date).toBe(TRADING_DAY);
    expect(entry?.netAmount).toBeNull();
    expect(entry?.dealAmount).toBeCloseTo(125846.52 * 2 * 1e6, 0);
    expect(data.warnings.some((w) => w.startsWith('net-undisclosed'))).toBe(true);

    // 双通道请求，日期上限透传
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fetchImpl 抛错时返回 adapter_error', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const m = createNorthboundFlowManagerFromEnv({}, { logger: noopLogger, fetchImpl });
    const r = await m.fetchSeries(baseQuery);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    const error = r.error;
    expect(error).toBeDefined();
    if (error === undefined) return;
    expect(error.kind).toBe('adapter_error');
    expect(error.adapter).toBe('northbound-flow');
    expect(error.message).toContain('network down');
  });

  it('endDate 为休市日时向前对齐到最近交易日', async () => {
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      return u.includes('MUTUAL_TYPE%3D%22001%22')
        ? okJson(channelFixture('001'))
        : okJson(channelFixture('003'));
    }) as unknown as typeof fetch;
    // 2027-02-01 是周一但配置为休市日 → 对齐到 2027-01-29（周五）
    const m = createNorthboundFlowManagerFromEnv(
      { LUOOME_A_SHARE_HOLIDAYS: '2027-02-01' },
      { logger: noopLogger, fetchImpl },
    );

    const r = await m.fetchSeries({ ...baseQuery, endDate: '2027-02-01' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.endDate).toBe('2027-01-29');
    const calledUrl = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(calledUrl).toContain(encodeURIComponent("(TRADE_DATE<='2027-01-29')"));
  });

  it('endDate 缺省时对齐到最近交易日（clock 落在周末 → 周五）', async () => {
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      const u = String(url);
      return u.includes('MUTUAL_TYPE%3D%22001%22')
        ? okJson(channelFixture('001'))
        : okJson(channelFixture('003'));
    }) as unknown as typeof fetch;
    // 2026-08-22 是周六 → 应回退到 2026-08-21（周五）
    const clock = () => new Date('2026-08-22T02:00:00Z');
    const m = createNorthboundFlowManagerFromEnv({}, { logger: noopLogger, clock, fetchImpl });

    const r = await m.fetchSeries({ days: 30, source: 'eastmoney' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.endDate).toBe(TRADING_DAY);
  });
});
