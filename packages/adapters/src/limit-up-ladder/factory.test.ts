import type { LimitUpLadderQuery, Logger } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';
import { createLimitUpLadderManagerFromEnv } from './factory.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 2026-07-24 是周五且不在内置 2026 休市日中，可作为真实交易日。 */
const TRADING_DAY = '2026-07-24';

const baseQuery: LimitUpLadderQuery = {
  date: TRADING_DAY,
  source: 'eastmoney',
  days: 15,
  includeUncategorized: false,
  includeStar: false,
  includeBse: false,
  includeST: false,
};

const poolFixture = {
  data: {
    pool: [
      {
        c: '600001',
        n: '测试股份',
        p: 11000,
        zdp: 10,
        lbc: 3,
        fbt: 93000,
        lbt: 93000,
        hybk: '半导体',
      },
      {
        c: '000002',
        n: '示例科技',
        p: 5500,
        zdp: 9.98,
        lbc: 1,
        fbt: 142842,
        lbt: 145500,
        hybk: '软件',
      },
    ],
  },
};

describe('createLimitUpLadderManagerFromEnv', () => {
  it('不配置任何 env 也返回可用的 limit-up-ladder manager', () => {
    const m = createLimitUpLadderManagerFromEnv({}, { logger: noopLogger });
    expect(m.name).toBe('limit-up-ladder');
    expect(typeof m.fetchLadder).toBe('function');
    expect(typeof m.compareLadder).toBe('function');
    expect(m.sources).toEqual(['eastmoney']);
  });

  it('配置未注册数据源时启动期失败，不做隐式 Eastmoney fallback', () => {
    expect(() =>
      createLimitUpLadderManagerFromEnv(
        { LUOOME_LIMIT_UP_LADDER_SOURCES: 'tushare' },
        { logger: noopLogger },
      ),
    ).toThrow();
  });

  it('重复数据源在启动期失败', () => {
    expect(() =>
      createLimitUpLadderManagerFromEnv(
        { LUOOME_LIMIT_UP_LADDER_SOURCES: 'eastmoney,eastmoney' },
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
          json: async () => poolFixture,
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    const selfConstructFetch = vi.fn(async () => {
      throw new Error('must not self-construct');
    }) as unknown as typeof fetch;

    const m = createLimitUpLadderManagerFromEnv(
      {},
      {
        logger: noopLogger,
        fetchImpl: selfConstructFetch,
        sources: { eastmoney: new EastmoneySource({ fetchImpl: injectedFetch }) },
      },
    );
    const r = await m.fetchLadder(baseQuery);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.source).toBe('eastmoney');
    expect(r.data?.total).toBe(2);
    expect(injectedFetch).toHaveBeenCalled();
    expect(selfConstructFetch).not.toHaveBeenCalled();
  });

  it('status() 暴露 registry 观测（binding 未执行时无执行事实）', () => {
    const m = createLimitUpLadderManagerFromEnv({}, { logger: noopLogger });
    const status = m.status();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      dataset: 'limit-up-ladder',
      source: 'eastmoney',
      coverage: ['CN_A_SHARES_SH_SZ'],
    });
  });

  it('fetchImpl 返回涨停池 fixture 时 fetchLadder 返回映射后的天梯', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => poolFixture,
        }) as unknown as Response,
    ) as unknown as typeof fetch;

    const m = createLimitUpLadderManagerFromEnv({}, { logger: noopLogger, fetchImpl });
    const r = await m.fetchLadder(baseQuery);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data;
    expect(data).toBeDefined();
    if (data === undefined) return;

    expect(data.date).toBe(TRADING_DAY);
    expect(data.source).toBe('eastmoney');
    expect(data.total).toBe(2);
    expect(data.maxLevel).toBe(3);

    const entries = data.levels.flatMap((lv) => lv.stocks);
    const first = entries.find((e) => e.code === '600001');
    expect(first).toBeDefined();
    expect(first?.name).toBe('测试股份');
    expect(first?.industry).toBe('半导体');
    expect(first?.ladderLevel).toBe(3);
    expect(first?.price).toBeCloseTo(11);
    expect(first?.changePct).toBeCloseTo(0.1);
    expect(first?.firstTime).toBe('09:30:00');
    expect(first?.finalTime).toBe('09:30:00');
    expect(first?.board).toBe('main_board');

    const second = entries.find((e) => e.code === '000002');
    expect(second).toBeDefined();
    expect(second?.ladderLevel).toBe(1);
    expect(second?.price).toBeCloseTo(5.5);
    expect(second?.changePct).toBeCloseTo(0.0998);
    expect(second?.firstTime).toBe('14:28:42');
    expect(second?.finalTime).toBe('14:55:00');

    // 日期透传到 eastmoney 涨停池 URL（YYYYMMDD）
    expect(fetchImpl).toHaveBeenCalledOnce();
    const calledUrl = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(calledUrl).toContain('date=20260724');
  });

  it('fetchImpl 抛错时返回 adapter_error', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const m = createLimitUpLadderManagerFromEnv({}, { logger: noopLogger, fetchImpl });
    const r = await m.fetchLadder(baseQuery);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    const error = r.error;
    expect(error).toBeDefined();
    if (error === undefined) return;
    expect(error.kind).toBe('adapter_error');
    expect(error.adapter).toBe('limit-up-ladder');
    expect(error.message).toContain('network down');
  });

  it('生产装配复用 env 节假日历，休市日不访问真实上游', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not fetch on a holiday');
    }) as unknown as typeof fetch;
    const m = createLimitUpLadderManagerFromEnv(
      { LUOOME_A_SHARE_HOLIDAYS: '2027-02-01' },
      { logger: noopLogger, fetchImpl },
    );

    const r = await m.fetchLadder({ ...baseQuery, date: '2027-02-01' });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.warnings).toContain('non-trading-day');
    expect(r.data?.total).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
