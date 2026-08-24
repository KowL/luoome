import type { DragonTigerListQuery, Logger } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';
import { createDragonTigerManagerFromEnv } from './factory.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 2026-08-21 是周五且不在内置 2026 休市日中，可作为真实交易日。 */
const TRADING_DAY = '2026-08-21';

const baseQuery: DragonTigerListQuery = {
  date: TRADING_DAY,
  source: 'eastmoney',
};

const reportFixture = {
  result: {
    pages: 1,
    data: [
      {
        TRADE_DATE: '2026-08-21 00:00:00',
        SECURITY_CODE: '600547',
        SECURITY_NAME_ABBR: '山东黄金',
        CLOSE_PRICE: 37.05,
        CHANGE_RATE: 4.9575,
        TURNOVERRATE: 4.1323,
        EXPLANATION: '非S证券连续三个交易日内收盘价格涨幅偏离值累计达到20%的证券',
        BILLBOARD_NET_AMT: 855648751.87,
        BILLBOARD_BUY_AMT: 3371674861.76,
        BILLBOARD_SELL_AMT: 2516026109.89,
        ACCUM_AMOUNT: 17302349779,
      },
    ],
  },
};

describe('createDragonTigerManagerFromEnv', () => {
  it('不配置任何 env 也返回可用的 dragon-tiger manager', () => {
    const m = createDragonTigerManagerFromEnv({}, { logger: noopLogger });
    expect(m.name).toBe('dragon-tiger');
    expect(typeof m.fetchList).toBe('function');
    expect(m.sources).toEqual(['eastmoney']);
  });

  it('配置未注册数据源时启动期失败，不做隐式 Eastmoney fallback', () => {
    expect(() =>
      createDragonTigerManagerFromEnv(
        { LUOOME_DRAGON_TIGER_SOURCES: 'tushare' },
        { logger: noopLogger },
      ),
    ).toThrow();
  });

  it('重复数据源在启动期失败', () => {
    expect(() =>
      createDragonTigerManagerFromEnv(
        { LUOOME_DRAGON_TIGER_SOURCES: 'eastmoney,eastmoney' },
        { logger: noopLogger },
      ),
    ).toThrow();
  });

  it('注入共享 EastmoneySource 时复用该实例，不再用 deps.fetchImpl 自构', async () => {
    const injectedFetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => reportFixture,
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    const selfConstructFetch = vi.fn(async () => {
      throw new Error('must not self-construct');
    }) as unknown as typeof fetch;

    const m = createDragonTigerManagerFromEnv(
      {},
      {
        logger: noopLogger,
        fetchImpl: selfConstructFetch,
        sources: { eastmoney: new EastmoneySource({ fetchImpl: injectedFetch }) },
      },
    );
    const r = await m.fetchList(baseQuery);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.source).toBe('eastmoney');
    expect(r.data?.total).toBe(1);
    expect(injectedFetch).toHaveBeenCalled();
    expect(selfConstructFetch).not.toHaveBeenCalled();
  });

  it('status() 暴露 registry 观测（binding 未执行时无执行事实）', () => {
    const m = createDragonTigerManagerFromEnv({}, { logger: noopLogger });
    const status = m.status();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      dataset: 'dragon-tiger-list',
      source: 'eastmoney',
      coverage: ['CN_A_SHARES_SH_SZ'],
    });
  });

  it('fetchImpl 返回龙虎榜 fixture 时 fetchList 返回映射后的榜单', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => reportFixture,
        }) as unknown as Response,
    ) as unknown as typeof fetch;

    const m = createDragonTigerManagerFromEnv({}, { logger: noopLogger, fetchImpl });
    const r = await m.fetchList(baseQuery);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data;
    expect(data).toBeDefined();
    if (data === undefined) return;

    expect(data.date).toBe(TRADING_DAY);
    expect(data.source).toBe('eastmoney');
    expect(data.total).toBe(1);

    const first = data.entries[0];
    expect(first?.code).toBe('600547');
    expect(first?.name).toBe('山东黄金');
    expect(first?.close).toBeCloseTo(37.05);
    expect(first?.changePct).toBeCloseTo(0.049575, 6);
    expect(first?.turnoverRate).toBeCloseTo(0.041323, 6);
    expect(first?.reason).toContain('涨幅偏离值累计达到20%');
    expect(first?.netAmount).toBeCloseTo(855648751.87, 2);
    expect(first?.tradeDate).toBe(TRADING_DAY);

    // 日期透传到报表 filter（TRADE_DATE）
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const calledUrl = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(calledUrl).toContain(encodeURIComponent("(TRADE_DATE='2026-08-21')"));
  });

  it('fetchImpl 抛错时返回 adapter_error', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const m = createDragonTigerManagerFromEnv({}, { logger: noopLogger, fetchImpl });
    const r = await m.fetchList(baseQuery);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    const error = r.error;
    expect(error).toBeDefined();
    if (error === undefined) return;
    expect(error.kind).toBe('adapter_error');
    expect(error.adapter).toBe('dragon-tiger');
    expect(error.message).toContain('network down');
  });

  it('生产装配复用 env 节假日历，休市日不访问真实上游', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not fetch on a holiday');
    }) as unknown as typeof fetch;
    const m = createDragonTigerManagerFromEnv(
      { LUOOME_A_SHARE_HOLIDAYS: '2027-02-01' },
      { logger: noopLogger, fetchImpl },
    );

    const r = await m.fetchList({ ...baseQuery, date: '2027-02-01' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.warnings).toContain('non-trading-day');
    expect(r.data?.total).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('date 缺省时解析为最近交易日（clock 落在周末 → 回退到周五）', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => reportFixture,
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    // 2026-08-22 是周六 → 应回退到 2026-08-21（周五）
    const clock = () => new Date('2026-08-22T02:00:00Z');
    const m = createDragonTigerManagerFromEnv({}, { logger: noopLogger, clock, fetchImpl });

    const r = await m.fetchList({ source: 'eastmoney' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.date).toBe(TRADING_DAY);
    const calledUrl = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(calledUrl).toContain(encodeURIComponent("(TRADE_DATE='2026-08-21')"));
  });
});
