import { describe, expect, it } from 'vitest';

import { FuyaoClient } from './client.js';
import { FuyaoLimitUpMarketSource } from './limit-up-market.js';

const config = { baseUrl: 'https://fuyao.test', apiKey: 'x', timeoutMs: 1_000, retries: 0 };

const stubFetch = (handler: (url: string) => Response) => {
  const urls: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    urls.push(String(url));
    return Promise.resolve(handler(String(url)));
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
};

const envelope = (data: unknown): Response =>
  new Response(JSON.stringify({ code: 0, message: 'success', data }), { status: 200 });

const poolItem = (overrides: Record<string, unknown> = {}) => ({
  thscode: '600327.SH',
  ticker: '600327',
  name: '大东方',
  is_st: false,
  is_new: false,
  last_price: 7.18,
  price_change_ratio_pct: 9.9541,
  limit_up_time: '14:56',
  limit_up_reason: '百货零售',
  continue_day_text: '5连板',
  continue_day_cnt: 5,
  seal_money: 27_188_276,
  max_seal_money: 27_188_276.24,
  open_times: null,
  ...overrides,
});

const statisticsPayload = (overrides: Record<string, unknown> = {}) => ({
  timestamp: 1_794_529_882_651,
  trade_date: '2026-11-12',
  seal_rate: 0.5138888888888888,
  open_stock_count: 35,
  limit_up_stock_count: 37,
  touched_limit_up_stock_count: 72,
  page_boards: [
    { board_level: 'one', stock_count: 26, promotion_rate: null },
    { board_level: 'two', stock_count: 5, promotion_rate: 0.08 },
  ],
  exact_boards: [{ board_num: 5, stock_count: 2 }],
  ...overrides,
});

const ladderPayload = () => ({
  timestamp: 1_794_529_848_419,
  window: {
    length: 30,
    // 上游同时存在 YYYYMMDD 与 YYYY-MM-DD 两种写法
    date_list: ['2026-11-12', '20261111'],
    board_caps: { two_board: 5, three_board: 2, seven_over: 1 },
  },
  item: [
    {
      date: '2026-11-12',
      boards: {
        two_board: [
          {
            thscode: '603135.SH',
            ticker: '603135',
            name: '中重科技',
            board_num: 2,
            seal_nextday: null,
            sign_level: 0,
          },
          { thscode: '830799.BJ', ticker: '830799', name: '北交所票', board_num: 2 },
        ],
        three_board: [],
        // 缺失 five/six 档，应补空数组
        seven_over: [
          {
            thscode: '600825.SH',
            ticker: '600825',
            name: '新华传媒',
            board_num: 11,
            seal_nextday: false,
          },
        ],
      },
    },
    {
      date: '20261111',
      boards: { two_board: [] },
    },
  ],
});

const happyFetch = (overrides: { readonly statistics?: unknown; readonly ladder?: unknown } = {}) =>
  stubFetch((url) => {
    if (url.includes('limit-up-pool')) {
      return envelope({
        timestamp: 1_794_529_800_000,
        pagination: { total: 1, pages: 1, size: 200, page: 1 },
        item: [poolItem()],
      });
    }
    if (url.includes('limit-up-statistics')) {
      return envelope(overrides.statistics ?? statisticsPayload());
    }
    return envelope(overrides.ladder ?? ladderPayload());
  });

describe('FuyaoLimitUpMarketSource', () => {
  it('同时拉取三个端点并归一化字段', async () => {
    const { fetchImpl, urls } = happyFetch();
    const source = new FuyaoLimitUpMarketSource(new FuyaoClient(config, { fetchImpl }));

    const sections = await source.fetchMarket('2026-11-12');

    expect(urls).toHaveLength(3);
    const poolUrl = urls.find((url) => url.includes('limit-up-pool')) as string;
    expect(poolUrl).toContain('date_ms=1794412800000');
    expect(poolUrl).toContain('sort_field=continue_day_cnt');
    expect(poolUrl).toContain('sort_dir=desc');
    expect(urls.find((url) => url.includes('limit-up-statistics'))).toContain('date=2026-11-12');

    expect(sections.pool?.total).toBe(1);
    expect(sections.pool?.entries[0]).toMatchObject({
      stockId: '600327.SH',
      code: '600327',
      name: '大东方',
      isSt: false,
      // 上游百分数原值 → 小数
      changePct: 0.099541,
      limitUpTime: '14:56',
      openTimes: null,
      continueDayCnt: 5,
      sealMoney: 27_188_276,
    });

    expect(sections.statistics).toMatchObject({
      tradeDate: '2026-11-12',
      sealRate: 0.5138888888888888,
      openStockCount: 35,
      exactBoards: [{ boardNum: 5, stockCount: 2 }],
    });
    expect(sections.statistics?.pageBoards[1]).toEqual({
      level: 'two',
      stockCount: 5,
      promotionRate: 0.08,
    });

    const ladder = sections.ladder;
    expect(ladder?.length).toBe(30);
    expect(ladder?.dateList).toEqual(['2026-11-12', '2026-11-11']);
    expect(ladder?.boardCaps).toEqual({
      two: 5,
      three: 2,
      four: 0,
      five: 0,
      six: 0,
      seven_plus: 1,
    });
    // 每档固定 6 个，缺失档补空数组；.BJ 被丢弃
    expect(ladder?.days[0]?.bands.map((band) => band.band)).toEqual([
      'two',
      'three',
      'four',
      'five',
      'six',
      'seven_plus',
    ]);
    expect(ladder?.days[0]?.bands[0]?.stocks).toEqual([
      {
        stockId: '603135.SH',
        code: '603135',
        name: '中重科技',
        boardNum: 2,
        sealedNextDay: null,
      },
    ]);
    expect(ladder?.days[0]?.bands[5]?.stocks[0]).toMatchObject({
      boardNum: 11,
      sealedNextDay: false,
    });

    // 三个 timestamp 取最大（统计端点最新）
    expect(sections.dataAsOf?.toISOString()).toBe('2026-11-13T00:31:22.651Z');
  });

  it('盘前空池是正常结果：pool.total=0 且不报错', async () => {
    const { fetchImpl } = stubFetch((url) => {
      if (url.includes('limit-up-pool')) {
        return envelope({
          pagination: { total: 0, pages: 0, size: 200, page: 1 },
          item: [],
        });
      }
      if (url.includes('limit-up-statistics')) {
        return envelope(
          statisticsPayload({
            trade_date: '2026-11-13',
            seal_rate: null,
            open_stock_count: 0,
            limit_up_stock_count: 0,
            touched_limit_up_stock_count: 0,
            page_boards: [],
            exact_boards: [],
          }),
        );
      }
      return envelope(ladderPayload());
    });
    const source = new FuyaoLimitUpMarketSource(new FuyaoClient(config, { fetchImpl }));

    const sections = await source.fetchMarket('2026-11-13');

    expect(sections.pool).toEqual({ total: 0, entries: [] });
    expect(sections.poolError).toBeNull();
    expect(sections.statistics?.sealRate).toBeNull();
    expect(sections.dataAsOf?.toISOString()).toBe('2026-11-13T00:31:22.651Z');
  });

  it('单端点失败只让该维度为 null 并带错误串', async () => {
    const { fetchImpl } = stubFetch((url) => {
      if (url.includes('limit-up-pool')) {
        return envelope({
          pagination: { total: 1, pages: 1, size: 200, page: 1 },
          item: [poolItem()],
        });
      }
      if (url.includes('limit-up-statistics')) {
        return new Response(JSON.stringify({ code: 5001, message: 'upstream down', data: null }), {
          status: 200,
        });
      }
      return envelope(ladderPayload());
    });
    const source = new FuyaoLimitUpMarketSource(new FuyaoClient(config, { fetchImpl }));

    const sections = await source.fetchMarket('2026-11-12');

    expect(sections.statistics).toBeNull();
    expect(sections.statisticsError).toContain('upstream_error');
    expect(sections.pool?.entries).toHaveLength(1);
    expect(sections.ladder).not.toBeNull();
  });

  it('统计信封日期错配 → 该维度失败（避免把错日数据挂到别的交易日）', async () => {
    const { fetchImpl } = happyFetch({
      statistics: statisticsPayload({ trade_date: '2026-11-11' }),
    });
    const source = new FuyaoLimitUpMarketSource(new FuyaoClient(config, { fetchImpl }));

    const sections = await source.fetchMarket('2026-11-12');

    expect(sections.statistics).toBeNull();
    expect(sections.statisticsError).toContain('信封日期错配');
  });

  it('涨停原因空串归一为 null，缺失价格保留 null', async () => {
    const { fetchImpl } = stubFetch((url) => {
      if (url.includes('limit-up-pool')) {
        return envelope({
          pagination: { total: 1, pages: 1, size: 200, page: 1 },
          item: [
            poolItem({ limit_up_reason: '  ', last_price: null, price_change_ratio_pct: null }),
          ],
        });
      }
      if (url.includes('limit-up-statistics')) return envelope(statisticsPayload());
      return envelope(ladderPayload());
    });
    const source = new FuyaoLimitUpMarketSource(new FuyaoClient(config, { fetchImpl }));

    const sections = await source.fetchMarket('2026-11-12');

    expect(sections.pool?.entries[0]).toMatchObject({
      reason: null,
      price: null,
      changePct: null,
    });
  });

  it('涨停池分页拉全', async () => {
    const { fetchImpl, urls } = stubFetch((url) => {
      if (url.includes('limit-up-pool')) {
        const page = new URL(url).searchParams.get('page');
        return page === '1'
          ? envelope({
              pagination: { total: 200, pages: 2, size: 200, page: 1 },
              item: Array.from({ length: 100 }, (_, index) =>
                poolItem({
                  thscode: `${String(index + 1).padStart(6, '0')}.SZ`,
                  ticker: String(index + 1).padStart(6, '0'),
                  continue_day_cnt: 2,
                }),
              ),
            })
          : envelope({
              pagination: { total: 200, pages: 2, size: 200, page: 2 },
              item: [],
            });
      }
      if (url.includes('limit-up-statistics')) return envelope(statisticsPayload());
      return envelope(ladderPayload());
    });
    const source = new FuyaoLimitUpMarketSource(new FuyaoClient(config, { fetchImpl }));

    const sections = await source.fetchMarket('2026-11-12');

    expect(urls.filter((url) => url.includes('limit-up-pool'))).toHaveLength(2);
    expect(sections.pool?.total).toBe(200);
    expect(sections.pool?.entries).toHaveLength(100);
  });
});
