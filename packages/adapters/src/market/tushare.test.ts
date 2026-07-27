import type { Logger } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import type { TushareConfig } from '../tushare/client.js';
import { TUSHARE_DEFAULT_URL, tushareConfigFromEnv } from '../tushare/client.js';
import { TushareMarketAdapter, translateTushareError } from './tushare.js';

/**
 * TushareMarketAdapter 单元测试（docs/ddd/tushare-market-adapter-design.md §11.1）。
 * 全程通过 fetchImpl stub，不依赖网络；config 直接注入（adapter 不读 process.env）。
 * 传输层为 tushare 官方 POST envelope：stub 按 body.api_name 路由。
 */

const BASE_CONFIG: TushareConfig = {
  url: TUSHARE_DEFAULT_URL,
  token: 'test-key',
  timeoutMs: 1_000,
  retries: 0,
};

const FIXED_NOW = new Date('2026-07-24T08:00:00.000Z');
const fixedClock = () => new Date(FIXED_NOW.getTime());

interface CapturedLog {
  readonly message: string;
  readonly meta?: Record<string, unknown>;
}

const makeLogger = (): { logger: Logger; warns: CapturedLog[]; infos: CapturedLog[] } => {
  const warns: CapturedLog[] = [];
  const infos: CapturedLog[] = [];
  return {
    warns,
    infos,
    logger: {
      debug: () => {},
      info: (message, meta) => {
        infos.push(meta === undefined ? { message } : { message, meta });
      },
      warn: (message, meta) => {
        warns.push(meta === undefined ? { message } : { message, meta });
      },
      error: () => {},
    },
  };
};

const tushareEnvelope = (
  fields: readonly string[],
  items: ReadonlyArray<readonly unknown[]>,
): Response =>
  new Response(JSON.stringify({ code: 0, msg: '', data: { fields, items } }), { status: 200 });

const QUOTE_FIELDS = ['ts_code', 'trade_time', 'open', 'high', 'low', 'close', 'vol'];
const QUOTE_ROW = ['600519.SH', '2026-07-24T07:00:00.000Z', 1690, 1710, 1685, 1700.5, 123_456];

interface CapturedRequest {
  readonly apiName: string;
  readonly params: Record<string, unknown>;
}

/** stub 路由：按 POST body 的 api_name 分发。 */
const makeAdapter = (
  fetchImpl: (req: CapturedRequest) => Promise<Response>,
  config: TushareConfig = BASE_CONFIG,
) => {
  const { logger, warns, infos } = makeLogger();
  const requests: CapturedRequest[] = [];
  const adapter = new TushareMarketAdapter({
    clock: fixedClock,
    logger,
    config,
    fetchImpl: ((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        api_name: string;
        params: Record<string, unknown>;
      };
      const req: CapturedRequest = { apiName: body.api_name, params: body.params };
      requests.push(req);
      return fetchImpl(req);
    }) as never,
  });
  return { adapter, requests, warns, infos };
};

const DAILY_RANGE = {
  start: new Date('2026-07-20T00:00:00.000Z'),
  end: new Date('2026-07-21T00:00:00.000Z'),
};

const dailyFetch = (
  dailyItems: ReadonlyArray<readonly unknown[]>,
  adjItems: ReadonlyArray<readonly unknown[]>,
) => {
  return (req: CapturedRequest): Promise<Response> => {
    if (req.apiName === 'daily') {
      return Promise.resolve(
        tushareEnvelope(
          ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'],
          dailyItems,
        ),
      );
    }
    if (req.apiName === 'adj_factor') {
      return Promise.resolve(tushareEnvelope(['ts_code', 'trade_date', 'adj_factor'], adjItems));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
};

describe('TushareMarketAdapter 市场支持范围', () => {
  it('HK / US / BJ → 抛 unsupported_market（fetchQuote 与 fetchDailyBars）', async () => {
    const { adapter, warns } = makeAdapter(() => Promise.resolve(tushareEnvelope([], [])));
    for (const code of ['00700.HK', 'AAPL.US', '830799.BJ']) {
      await expect(adapter.fetchQuote(code)).rejects.toThrow(/unsupported_market/);
      await expect(adapter.fetchDailyBars(code, DAILY_RANGE)).rejects.toThrow(/unsupported_market/);
    }
    expect(warns.some((w) => w.message.includes('market not supported'))).toBe(true);
  });
});

describe('TushareMarketAdapter.fetchQuote', () => {
  it('正常响应：rt_k + 完整 ts_code；close 即最新价、vol 已是股、优先远端 trade_time、source=tushare', async () => {
    const { adapter, requests, infos } = makeAdapter(() =>
      Promise.resolve(tushareEnvelope(QUOTE_FIELDS, [QUOTE_ROW])),
    );
    const quote = await adapter.fetchQuote('600519.SH');
    expect(requests[0]?.apiName).toBe('rt_k');
    expect(requests[0]?.params.ts_code).toBe('600519.SH');
    expect(quote.stockId).toBe('600519.SH');
    expect(quote.close).toBe(1700.5);
    expect(quote.open).toBe(1690);
    expect(quote.high).toBe(1710);
    expect(quote.low).toBe(1685);
    expect(quote.volume).toBe(123_456);
    expect(quote.ts).toEqual(new Date('2026-07-24T07:00:00.000Z'));
    expect(quote.source).toBe('tushare');
    expect(infos.some((l) => l.message === 'tushare.fetchQuote ok')).toBe(true);
  });

  it('trade_time 缺失时退回本地抓取时间', async () => {
    const fields = ['ts_code', 'open', 'high', 'low', 'close', 'vol'];
    const row = ['600519.SH', 99, 101, 98, 100, 1000];
    const { adapter } = makeAdapter(() => Promise.resolve(tushareEnvelope(fields, [row])));
    const quote = await adapter.fetchQuote('600519.SH');
    expect(quote.ts).toEqual(FIXED_NOW);
  });

  it('trade_time=null 时退回本地时钟；无时区时间按 Asia/Shanghai 解释', async () => {
    const nullTimeRow = ['600519.SH', null, 99, 101, 98, 100, 1000];
    const nullTime = makeAdapter(() =>
      Promise.resolve(tushareEnvelope(QUOTE_FIELDS, [nullTimeRow])),
    );
    expect((await nullTime.adapter.fetchQuote('600519.SH')).ts).toEqual(FIXED_NOW);

    const localTimeRow = ['600519.SH', '2026-07-24 15:00:00', 99, 101, 98, 100, 1000];
    const localTime = makeAdapter(() =>
      Promise.resolve(tushareEnvelope(QUOTE_FIELDS, [localTimeRow])),
    );
    expect((await localTime.adapter.fetchQuote('600519.SH')).ts).toEqual(
      new Date('2026-07-24T07:00:00.000Z'),
    );
  });

  it('HTTP 4xx → 转译为 tushare http 错误', async () => {
    const { adapter } = makeAdapter(() =>
      Promise.resolve(new Response('unauthorized', { status: 401 })),
    );
    await expect(adapter.fetchQuote('600519.SH')).rejects.toThrow(/tushare http/);
  });

  it('HTTP 5xx → 重试耗尽后抛错（首次 + retries 次）', async () => {
    let calls = 0;
    const { adapter } = makeAdapter(
      () => {
        calls += 1;
        return Promise.resolve(new Response('boom', { status: 500 }));
      },
      { ...BASE_CONFIG, retries: 1 },
    );
    await expect(adapter.fetchQuote('600519.SH')).rejects.toThrow(/tushare http/);
    expect(calls).toBe(2);
  });

  it('网络错误 → 转译为 tushare network 错误', async () => {
    const { adapter } = makeAdapter(() => Promise.reject(new TypeError('socket hang up')));
    await expect(adapter.fetchQuote('600519.SH')).rejects.toThrow(/tushare network/);
  });

  it('envelope code≠0 → 抛 upstream_error', async () => {
    const { adapter } = makeAdapter(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ code: -1, msg: 'bad ts_code', data: { fields: [], items: [] } }),
          {
            status: 200,
          },
        ),
      ),
    );
    await expect(adapter.fetchQuote('600519.SH')).rejects.toThrow(/tushare upstream_error/);
  });

  it('items 为空 → 抛 not_found', async () => {
    const { adapter } = makeAdapter(() => Promise.resolve(tushareEnvelope(QUOTE_FIELDS, [])));
    await expect(adapter.fetchQuote('600519.SH')).rejects.toThrow(/tushare not_found/);
  });

  it('行字段缺 close → 抛 parse 错误', async () => {
    const fields = ['ts_code', 'trade_time', 'open', 'high', 'low', 'vol'];
    const row = ['600519.SH', '2026-07-24T07:00:00.000Z', 1690, 1710, 1685, 1234];
    const { adapter } = makeAdapter(() => Promise.resolve(tushareEnvelope(fields, [row])));
    await expect(adapter.fetchQuote('600519.SH')).rejects.toThrow(/tushare parse/);
  });
});

describe('TushareMarketAdapter.fetchDailyBars', () => {
  const DAILY_ITEMS = [
    ['600519.SH', '20260720', 95, 96, 94, 95.5, 1234, 11_760_000],
    // server 可能把 trade_date 序列化为 number
    ['600519.SH', 20_260_721, 96, 97, 95, 96.5, 1500, 14_470_000],
  ];

  it('日线 + 复权因子都成功：按 trade_date 合并、vol×100、source=tushare', async () => {
    const { adapter, requests, warns, infos } = makeAdapter(
      dailyFetch(DAILY_ITEMS, [
        ['600519.SH', '20260720', 1.5],
        ['600519.SH', 20_260_721, 1.6],
      ]),
    );
    const bars = await adapter.fetchDailyBars('600519.SH', DAILY_RANGE);
    expect(requests.some((r) => r.apiName === 'daily')).toBe(true);
    expect(requests.some((r) => r.apiName === 'adj_factor')).toBe(true);
    expect(requests[0]?.params.start_date).toBe('20260720');
    expect(requests[0]?.params.end_date).toBe('20260721');
    expect(bars).toHaveLength(2);
    expect(bars[0]?.date).toEqual(new Date('2026-07-20T00:00:00.000Z'));
    expect(bars[0]?.close).toBe(95.5);
    expect(bars[0]?.volume).toBe(123_400); // 手 → 股
    expect(bars[0]?.adjFactor).toBe(1.5);
    expect(bars[1]?.adjFactor).toBe(1.6);
    expect(bars[0]?.source).toBe('tushare');
    expect(warns.some((w) => w.message.includes('adj_factor missing'))).toBe(false);
    expect(infos.some((l) => l.message === 'tushare.fetchDailyBars ok')).toBe(true);
  });

  it('部分日期缺复权因子 → 该 bar 用 1.0 占位并打 warn', async () => {
    const { adapter, warns } = makeAdapter(
      dailyFetch(DAILY_ITEMS, [['600519.SH', '20260720', 1.5]]),
    );
    const bars = await adapter.fetchDailyBars('600519.SH', DAILY_RANGE);
    expect(bars).toHaveLength(2);
    expect(bars[0]?.adjFactor).toBe(1.5);
    expect(bars[1]?.adjFactor).toBe(1.0);
    expect(
      warns.some((w) => w.message.includes('adj_factor missing') && w.meta?.date === '20260721'),
    ).toBe(true);
  });

  it('复权因子完全缺失（空 items）→ 不抛错，全部 1.0', async () => {
    const { adapter, warns } = makeAdapter(dailyFetch(DAILY_ITEMS, []));
    const bars = await adapter.fetchDailyBars('600519.SH', DAILY_RANGE);
    expect(bars).toHaveLength(2);
    expect(bars.every((b) => b.adjFactor === 1.0)).toBe(true);
    expect(warns.filter((w) => w.message.includes('adj_factor missing'))).toHaveLength(2);
  });

  it('非正或非有限复权因子按缺失处理', async () => {
    const { adapter } = makeAdapter(
      dailyFetch(DAILY_ITEMS, [
        ['600519.SH', '20260720', 0],
        ['600519.SH', '20260721', -1],
      ]),
    );
    const bars = await adapter.fetchDailyBars('600519.SH', DAILY_RANGE);
    expect(bars.map((bar) => bar.adjFactor)).toEqual([1, 1]);
  });

  it('复权因子请求失败 → 日线仍返回，warn 日志', async () => {
    const { adapter, warns } = makeAdapter((req) => {
      if (req.apiName === 'adj_factor') {
        return Promise.resolve(new Response('boom', { status: 500 }));
      }
      return dailyFetch(DAILY_ITEMS, [])(req);
    });
    const bars = await adapter.fetchDailyBars('600519.SH', DAILY_RANGE);
    expect(bars).toHaveLength(2);
    expect(bars.every((b) => b.adjFactor === 1.0)).toBe(true);
    expect(warns.some((w) => w.message.includes('adj_factor request failed'))).toBe(true);
  });

  it('复权因子响应解析失败 → 日线仍返回，warn 日志', async () => {
    const { adapter, warns } = makeAdapter((req) => {
      if (req.apiName === 'adj_factor') {
        return Promise.resolve(new Response('not-json', { status: 200 }));
      }
      return dailyFetch(DAILY_ITEMS, [])(req);
    });
    const bars = await adapter.fetchDailyBars('600519.SH', DAILY_RANGE);
    expect(bars).toHaveLength(2);
    expect(warns.some((w) => w.message.includes('adj_factor request failed'))).toBe(true);
  });

  it('日线成功但越界 → 范围外 bar 丢弃', async () => {
    const items = [['600519.SH', '20260719', 94, 95, 93, 94.5, 1000, 9_400_000], ...DAILY_ITEMS];
    const { adapter } = makeAdapter(dailyFetch(items, []));
    const bars = await adapter.fetchDailyBars('600519.SH', DAILY_RANGE);
    expect(bars).toHaveLength(2);
    expect(bars[0]?.date).toEqual(new Date('2026-07-20T00:00:00.000Z'));
  });

  it('日线请求失败 → 整体失败（转译为 tushare http）', async () => {
    const { adapter } = makeAdapter((req) => {
      if (req.apiName === 'daily') {
        return Promise.resolve(new Response('boom', { status: 500 }));
      }
      return Promise.resolve(tushareEnvelope(['ts_code', 'trade_date', 'adj_factor'], []));
    });
    await expect(adapter.fetchDailyBars('600519.SH', DAILY_RANGE)).rejects.toThrow(/tushare http/);
  });

  it('日线命中但空 → 返回空数组（不抛错）', async () => {
    const { adapter } = makeAdapter(dailyFetch([], []));
    await expect(adapter.fetchDailyBars('600519.SH', DAILY_RANGE)).resolves.toEqual([]);
  });
});

describe('TushareMarketAdapter.batchQuote', () => {
  it('部分失败 → 只保留成功项', async () => {
    const { adapter } = makeAdapter((req) => {
      if (req.params.ts_code === '600519.SH') {
        return Promise.resolve(tushareEnvelope(QUOTE_FIELDS, [QUOTE_ROW]));
      }
      // 000001.SZ 命中但空 → not_found；00700.HK → unsupported_market
      return Promise.resolve(tushareEnvelope(QUOTE_FIELDS, []));
    });
    const result = await adapter.batchQuote(['600519.SH', '000001.SZ', '00700.HK']);
    expect(result.size).toBe(1);
    expect(result.get('600519.SH')?.source).toBe('tushare');
  });
});

describe('TushareMarketAdapter.searchStocks', () => {
  const SEARCH_FIELDS = ['ts_code', 'name', 'exchange'];

  it('SSE / SZSE 映射为 SH / SZ，其它交易所剔除', async () => {
    const { adapter } = makeAdapter(() =>
      Promise.resolve(
        tushareEnvelope(SEARCH_FIELDS, [
          ['600519.SH', '贵州茅台', 'SSE'],
          ['000001.SZ', '平安银行', 'SZSE'],
          ['00700.HK', '腾讯控股', 'HKEX'],
        ]),
      ),
    );
    const candidates = await adapter.searchStocks('茅');
    expect(candidates).toEqual([
      { id: '600519.SH', code: '600519', exchange: 'SH', name: '贵州茅台' },
      { id: '000001.SZ', code: '000001', exchange: 'SZ', name: '平安银行' },
    ]);
  });

  it('空 query → 空数组（不发请求）', async () => {
    const { adapter, requests } = makeAdapter(() => Promise.resolve(tushareEnvelope([], [])));
    await expect(adapter.searchStocks('   ')).resolves.toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('六位代码推断交易所并使用 ts_code 查询', async () => {
    const { adapter, requests } = makeAdapter(() =>
      Promise.resolve(tushareEnvelope(SEARCH_FIELDS, [['600519.SH', '贵州茅台', 'SSE']])),
    );
    await expect(adapter.searchStocks('600519')).resolves.toHaveLength(1);
    expect(requests[0]?.params.ts_code).toBe('600519.SH');
    expect(requests[0]?.params.name).toBeUndefined();
  });

  it('搜索命中但空 → 返回空数组', async () => {
    const { adapter } = makeAdapter(() => Promise.resolve(tushareEnvelope(SEARCH_FIELDS, [])));
    await expect(adapter.searchStocks('不存在')).resolves.toEqual([]);
  });
});

describe('translateTushareError', () => {
  it('ZodError → tushare parse；普通 Error 原样透传；非 Error 包装', () => {
    expect(translateTushareError(new ZodError([])).message).toMatch(/tushare parse/);
    const plain = new Error('tushare not_found: 600519.SH');
    expect(translateTushareError(plain)).toBe(plain);
    expect(translateTushareError('oops').message).toBe('oops');
  });
});

describe('tushareConfigFromEnv', () => {
  it('TUSHARE_TOKEN 缺失 → 抛错', () => {
    expect(() => tushareConfigFromEnv({})).toThrow(/TUSHARE_TOKEN/);
  });

  it('默认 url / 超时 / 重试；TUSHARE_URL 可覆盖', () => {
    const config = tushareConfigFromEnv({ TUSHARE_TOKEN: 'k' });
    expect(config.url).toBe(TUSHARE_DEFAULT_URL);
    expect(config.timeoutMs).toBe(10_000);
    expect(config.retries).toBe(2);
    expect(
      tushareConfigFromEnv({ TUSHARE_TOKEN: 'k', TUSHARE_URL: 'https://proxy.test' }).url,
    ).toBe('https://proxy.test');
  });
});
