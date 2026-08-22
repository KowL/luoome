import type { Logger } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { SourceExecutionError } from '../source-error.js';
import { FuyaoSource, normalizeFuyaoThscode } from './source.js';

const CLOCK = new Date('2026-08-21T07:00:00.000Z'); // 2026-08-21 15:00 Asia/Shanghai
const TIMESTAMP_MS = CLOCK.getTime() - 60_000; // 上游时间戳早于本地时钟 → upstream 生效

const silentLogger = (): Logger => {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
};

const envelope = (
  items: Array<Record<string, unknown>>,
  timestamp: number | null = TIMESTAMP_MS,
): Response =>
  new Response(
    JSON.stringify({
      code: 0,
      message: 'success',
      request_id: 'r1',
      data: { timestamp, item: items },
    }),
    { status: 200 },
  );

const errorEnvelope = (code: number): Response =>
  new Response(JSON.stringify({ code, message: `err-${code}`, request_id: 'r1', data: null }), {
    status: 200,
  });

const snapshotRow = (
  thscode: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  thscode,
  ticker: thscode.split('.')[0],
  last_price: 1277.8,
  price_change: 21.8,
  price_change_ratio_pct: 1.735669,
  open_price: 1252.08,
  high_price: 1282,
  low_price: 1250.21,
  prev_price: 1256,
  volume: 3098875,
  turnover: 3937375200,
  ...overrides,
});

const makeSource = (fetchImpl: typeof fetch): { source: FuyaoSource; calls: string[] } => {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return fetchImpl(url);
  }) as unknown as typeof fetch;
  return {
    source: new FuyaoSource({
      config: { baseUrl: 'https://fuyao.test', apiKey: 'k', timeoutMs: 1_000, retries: 1 },
      fetchImpl: impl,
      logger: silentLogger(),
      clock: () => CLOCK,
    }),
    calls,
  };
};

describe('fuyao/normalizeFuyaoThscode（代码归一 §5.2）', () => {
  it('6 位代码按号段补后缀：60/68/9→.SH，00/30/20→.SZ', () => {
    expect(normalizeFuyaoThscode('600519')).toBe('600519.SH');
    expect(normalizeFuyaoThscode('688981')).toBe('688981.SH');
    expect(normalizeFuyaoThscode('900901')).toBe('900901.SH');
    expect(normalizeFuyaoThscode('000001')).toBe('000001.SZ');
    expect(normalizeFuyaoThscode('300750')).toBe('300750.SZ');
    expect(normalizeFuyaoThscode('200596')).toBe('200596.SZ');
  });

  it('已带 SH/SZ 后缀的原样返回（trim + toUpperCase）', () => {
    expect(normalizeFuyaoThscode(' 600519.sh ')).toBe('600519.SH');
    expect(normalizeFuyaoThscode('000001.SZ')).toBe('000001.SZ');
  });

  it('.BJ/.TI/.OF/无法判定 → unsupported_market', () => {
    for (const input of ['430047.BJ', '886042.TI', '160222.OF', '130030', 'ABCDEF', 'AAPL']) {
      try {
        normalizeFuyaoThscode(input);
        expect.unreachable(`should throw: ${input}`);
      } catch (error) {
        expect(error).toBeInstanceOf(SourceExecutionError);
        expect((error as SourceExecutionError).kind).toBe('unsupported_market');
      }
    }
  });
});

describe('fuyao/FuyaoSource.fetchQuote / batchQuote', () => {
  it('snapshot 字段映射：volume 为股、observedAt 取 data.timestamp、timestampSource=upstream', async () => {
    const { source, calls } = makeSource((async (url: string) => {
      expect(url).toContain('/api/a-share/prices/snapshot?thscodes=600519.SH');
      return envelope([snapshotRow('600519.SH')]);
    }) as never);
    const quote = await source.fetchQuote('600519');
    expect(calls).toHaveLength(1);
    expect(quote.stockId).toBe('600519.SH');
    expect(quote.close).toBe(1277.8);
    expect(quote.open).toBe(1252.08);
    expect(quote.high).toBe(1282);
    expect(quote.low).toBe(1250.21);
    expect(quote.prevClose).toBe(1256);
    expect(quote.volume).toBe(3098875); // 已是股，不换算
    expect(quote.amount).toBe(3937375200);
    expect(quote.observedAt.getTime()).toBe(TIMESTAMP_MS);
    expect(quote.timestampSource).toBe('upstream');
    expect(quote.source).toBe('fuyao');
  });

  it('上游时间戳为 null → 回退本地时钟 + retrieval', async () => {
    const { source } = makeSource((async () =>
      envelope([snapshotRow('600519.SH')], null)) as never);
    const quote = await source.fetchQuote('600519.SH');
    expect(quote.observedAt.getTime()).toBe(CLOCK.getTime());
    expect(quote.timestampSource).toBe('retrieval');
  });

  it('快照为空 / 价格为 0 → no_data', async () => {
    const empty = makeSource((async () => envelope([])) as never);
    await expect(empty.source.fetchQuote('600519')).rejects.toMatchObject({ kind: 'no_data' });

    const halted = makeSource((async () =>
      envelope([snapshotRow('600519.SH', { last_price: 0 })])) as never);
    await expect(halted.source.fetchQuote('600519')).rejects.toMatchObject({ kind: 'no_data' });
  });

  it('信封错误透传结构化 kind（2003 → permission）', async () => {
    const { source } = makeSource((async () => errorEnvelope(2003)) as never);
    await expect(source.fetchQuote('600519')).rejects.toMatchObject({ kind: 'permission' });
  });

  it('batchQuote：单次请求取整批；未返回 / 非法 / 无法归一的标的只丢弃该只', async () => {
    const { source, calls } = makeSource((async (url: string) => {
      expect(url).toContain('thscodes=600519.SH%2C000001.SZ');
      return envelope([snapshotRow('600519.SH')]);
    }) as never);
    const result = await source.batchQuote(['600519', '000001.SZ', '430047.BJ']);
    expect(calls).toHaveLength(1);
    expect([...result.keys()]).toEqual(['600519']);
    expect(result.get('600519')?.source).toBe('fuyao');
  });
});

describe('fuyao/FuyaoSource.fetchDailyBars', () => {
  const SHANGHAI_MIDNIGHT_MS = Date.UTC(2026, 7, 19, 16, 0, 0); // 2026-08-20 Asia/Shanghai 零点
  const range = {
    start: new Date(Date.UTC(2026, 7, 1)),
    end: new Date(Date.UTC(2026, 7, 21)),
  };

  it('固定 interval=1d & adjust=forward；date_ms 归一为交易日 UTC 00:00；adjustment=qfq', async () => {
    const { source, calls } = makeSource((async () =>
      envelope([
        {
          date_ms: SHANGHAI_MIDNIGHT_MS,
          open_price: 1611.602,
          high_price: 1626.602,
          low_price: 1601.722,
          close_price: 1602.612,
          volume: 3142572,
          turnover: 5401389334.87,
        },
      ])) as never);
    const bars = await source.fetchDailyBars('600519', range);
    expect(calls).toHaveLength(1);
    const url = calls[0] ?? '';
    expect(url).toContain('/api/a-share/prices/historical?');
    expect(url).toContain('thscode=600519.SH');
    expect(url).toContain('interval=1d');
    expect(url).toContain('adjust=forward');
    expect(url).toContain(`start=${range.start.getTime()}`);
    expect(url).toContain(`end=${range.end.getTime()}`);
    expect(bars).toHaveLength(1);
    expect(bars[0]?.date.getTime()).toBe(Date.UTC(2026, 7, 20));
    expect(bars[0]?.adjustment).toBe('qfq');
    expect(bars[0]?.close).toBe(1602.612);
    expect(bars[0]?.volume).toBe(3142572);
    expect(bars[0]?.sourceAdjFactor).toBeUndefined();
    expect(bars[0]?.source).toBe('fuyao');
  });

  it('窗口超 10 年 → 请求前抛参数错误（不触达网络）', async () => {
    const { source, calls } = makeSource((async () => envelope([])) as never);
    await expect(
      source.fetchDailyBars('600519', {
        start: new Date(Date.UTC(2010, 0, 1)),
        end: new Date(Date.UTC(2026, 7, 21)),
      }),
    ).rejects.toMatchObject({ kind: 'upstream_error' });
    await expect(
      source
        .fetchDailyBars('600519', {
          start: new Date(Date.UTC(2010, 0, 1)),
          end: new Date(Date.UTC(2026, 7, 21)),
        })
        .catch((error: unknown) => error),
    ).resolves.toBeInstanceOf(SourceExecutionError);
    expect(calls).toHaveLength(0);
  });
});

describe('fuyao/FuyaoSource.searchStocks', () => {
  it('映射为 StockSearchCandidate；只保留 SH/SZ', async () => {
    const { source, calls } = makeSource((async (url: string) => {
      expect(url).toContain('/api/meta/tickers/search?');
      expect(url).toContain('q=%E8%8C%85%E5%8F%B0');
      expect(url).toContain('asset_type=a-share');
      return envelope([
        {
          thscode: '600519.SH',
          ticker: '600519',
          name: '贵州茅台',
          exchange: 'SH',
          asset_type: 'a-share',
          currency: 'CNY',
        },
        {
          thscode: '000858.SZ',
          ticker: '000858',
          name: '五粮液',
          exchange: 'SZ',
          asset_type: 'a-share',
          currency: 'CNY',
        },
        {
          thscode: '430047.BJ',
          ticker: '430047',
          name: '诺思兰德',
          exchange: 'BJ',
          asset_type: 'a-share',
          currency: 'CNY',
        },
      ]);
    }) as never);
    const candidates = await source.searchStocks('茅台');
    expect(calls).toHaveLength(1);
    expect(candidates).toEqual([
      { id: '600519.SH', code: '600519', exchange: 'SH', name: '贵州茅台' },
      { id: '000858.SZ', code: '000858', exchange: 'SZ', name: '五粮液' },
    ]);
  });

  it('空结果返回空数组（不抛错、不降级）', async () => {
    const { source } = makeSource((async () => envelope([])) as never);
    await expect(source.searchStocks('不存在的股票')).resolves.toEqual([]);
  });
});

describe('fuyao/FuyaoSource.fetchMarketSnapshot', () => {
  it('limit=100 分页，item.length < limit 时终止；BJ 过滤、id 去重、changePct 原值保留', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      snapshotRow(`6000${String(i).padStart(2, '0')}.SH`),
    );
    page1[0] = snapshotRow('600000.SH'); // 与 page2 的重复项制造去重场景
    const page2 = [
      snapshotRow('600000.SH'),
      snapshotRow('000001.SZ', { price_change_ratio_pct: -2.5 }),
      snapshotRow('430047.BJ'), // 北交所 → 过滤
    ];
    const { source, calls } = makeSource((async (url: string) => {
      expect(url).toContain('limit=100');
      if (url.includes('offset=0')) return envelope(page1);
      return envelope(page2);
    }) as never);
    const items = await source.fetchMarketSnapshot();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('offset=100');
    expect(items.some((item) => item.id.endsWith('.BJ'))).toBe(false);
    expect(items.filter((item) => item.id === '600000.SH')).toHaveLength(1);
    const sz = items.find((item) => item.id === '000001.SZ');
    expect(sz?.exchange).toBe('SZ');
    expect(sz?.changePct).toBe(-2.5); // 百分数原值
    expect(sz?.name).toBe('000001'); // 快照无中文名，代码占位
  });

  it('last_price 为 null（停牌，实盘出现）→ 保留条目仅省略 close/changePct', async () => {
    const { source } = makeSource((async () =>
      envelope([
        snapshotRow('600519.SH', { last_price: null, price_change_ratio_pct: null }),
      ])) as never);
    const items = await source.fetchMarketSnapshot();
    expect(items).toHaveLength(1);
    expect(items[0]?.close).toBeUndefined();
    expect(items[0]?.changePct).toBeUndefined();
  });
});

describe('fuyao/FuyaoSource.fetchIndexQuotes', () => {
  const indexRow = (thscode: string): Record<string, unknown> => ({
    thscode,
    ticker: thscode.split('.')[0],
    last_price: 3388.06,
    price_change: 12.21,
    price_change_ratio_pct: 0.3617,
    open_price: 3370.25,
    high_price: 3392.18,
    low_price: 3365.4,
    prev_price: 3375.85,
    volume: 321000000,
    turnover: 420000000000,
  });

  it('指数集合对齐 eastmoney 沪深大盘指数；changePct 原值、ts 取信封 timestamp', async () => {
    const codes = ['000001.SH', '399001.SZ', '399006.SZ', '000300.SH', '000688.SH'];
    const { source, calls } = makeSource((async (url: string) => {
      expect(url).toContain('/api/a-share-index/prices/snapshot?thscodes=');
      return envelope(codes.map(indexRow));
    }) as never);
    const indices = await source.fetchIndexQuotes();
    expect(calls).toHaveLength(1);
    expect(indices.map((index) => index.code)).toEqual(codes);
    expect(indices.map((index) => index.name)).toEqual([
      '上证指数',
      '深证成指',
      '创业板指',
      '沪深300',
      '科创50',
    ]);
    expect(indices[0]?.close).toBe(3388.06);
    expect(indices[0]?.change).toBe(12.21);
    expect(indices[0]?.changePct).toBe(0.3617); // 百分数原值
    expect(indices[0]?.ts.getTime()).toBe(TIMESTAMP_MS);
    expect(indices[0]?.source).toBe('fuyao');
  });

  it('单只缺失跳过；全部缺失 → no_data', async () => {
    const partial = makeSource((async () => envelope([indexRow('000001.SH')])) as never);
    const indices = await partial.source.fetchIndexQuotes();
    expect(indices.map((index) => index.code)).toEqual(['000001.SH']);

    const empty = makeSource((async () => envelope([])) as never);
    await expect(empty.source.fetchIndexQuotes()).rejects.toMatchObject({ kind: 'no_data' });
  });
});

describe('fuyao/FuyaoSource 不支持的能力', () => {
  it('fetchIntradayMinutes / fetchMinuteBars → unsupported_capability', async () => {
    const { source, calls } = makeSource((async () => envelope([])) as never);
    await expect(source.fetchIntradayMinutes('600519.SH')).rejects.toMatchObject({
      kind: 'unsupported_capability',
    });
    await expect(source.fetchIntradayMinutes('600519.SH')).rejects.toThrow(
      /unsupported_capability/,
    );
    await expect(source.fetchMinuteBars('600519.SH', '1m')).rejects.toMatchObject({
      kind: 'unsupported_capability',
    });
    expect(calls).toHaveLength(0); // 不发任何请求
  });
});
