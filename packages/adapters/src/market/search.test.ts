import type { Logger, StockSearchCandidate } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { FakeMarketAdapter } from '../testing/fake-market.js';
import { EastmoneyAdapterError, parseEastmoneySuggest } from './eastmoney.js';
import { MarketDataManager } from './manager.js';
import { parseTencentSearchHint } from './tencent.js';

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('parseEastmoneySuggest', () => {
  it('映射 SH / SZ / HK / US / BJ 并丢弃无法映射的条目', () => {
    const json = {
      QuotationCodeTable: {
        Status: 0,
        TotalCount: 6,
        Data: [
          { Code: '601398', Name: '工商银行', Classify: 'AStock', QuoteID: '1.601398' },
          { Code: '002594', Name: '比亚迪', Classify: 'AStock', QuoteID: '0.002594' },
          { Code: '00700', Name: '腾讯控股', Classify: 'HK', QuoteID: '116.00700' },
          { Code: 'AAPL', Name: '苹果', Classify: 'UsStock', QuoteID: '105.AAPL' },
          {
            Code: '920047',
            Name: '诺思兰德',
            Classify: 'NEEQ',
            SecurityTypeName: '京A',
            QuoteID: '0.920047',
          },
          { Code: '511010', Name: '国债ETF', Classify: 'Fund', QuoteID: '1.511010' },
        ],
      },
    };
    const candidates = parseEastmoneySuggest(json);
    expect(candidates.map((c) => c.id)).toEqual([
      '601398.SH',
      '002594.SZ',
      '00700.HK',
      'AAPL.US',
      '920047.BJ',
    ]);
  });

  it('0 前缀 + AStock → SZ；0 前缀 + 京A → BJ；0 前缀其它 → 丢弃', () => {
    const json = {
      QuotationCodeTable: {
        Status: 0,
        Data: [
          { Code: '300750', Name: '宁德时代', Classify: 'AStock', QuoteID: '0.300750' },
          { Code: '430047', Name: '某新三板', Classify: 'NEEQ', QuoteID: '0.430047' },
        ],
      },
    };
    const candidates = parseEastmoneySuggest(json);
    expect(candidates.map((c) => c.id)).toEqual(['300750.SZ']);
  });

  it('Data 为 null → 空数组（合法空结果）', () => {
    expect(parseEastmoneySuggest({ QuotationCodeTable: { Status: 0, Data: null } })).toEqual([]);
  });

  it('Status != 0 → 抛 EastmoneyAdapterError', () => {
    expect(() => parseEastmoneySuggest({ QuotationCodeTable: { Status: 1 } })).toThrow(
      EastmoneyAdapterError,
    );
  });
});

describe('parseTencentSearchHint', () => {
  it('解析 sh/hk/us，过滤基金，反转义 \\uXXXX，美股去后缀', () => {
    const text =
      'v_hint="sh~601398~\\u5de5\\u5546\\u94f6\\u884c~gsyh~GP-A' +
      '^hk~00700~\\u817e\\u8baf\\u63a7\\u80a1~txkg~GP' +
      '^us~aapl.oq~\\u82f9\\u679c~pg~GP' +
      '^jj~007005~中金基金~zjjj~KJ"';
    const candidates = parseTencentSearchHint(text);
    expect(candidates).toEqual([
      { id: '601398.SH', code: '601398', exchange: 'SH', name: '工商银行' },
      { id: '00700.HK', code: '00700', exchange: 'HK', name: '腾讯控股' },
      { id: 'AAPL.US', code: 'AAPL', exchange: 'US', name: '苹果' },
    ]);
  });

  it('空 hint / 非法包装 → 空数组', () => {
    expect(parseTencentSearchHint('v_hint=""')).toEqual([]);
    expect(parseTencentSearchHint('not-a-hint')).toEqual([]);
  });
});

describe('FakeMarketAdapter.searchStocks', () => {
  it('按 id / code / name 模糊匹配（deterministic）', async () => {
    const adapter = new FakeMarketAdapter();
    const byCode = await adapter.searchStocks('0025');
    expect(byCode[0]?.id).toBe('002594.SZ');
    const byName = await adapter.searchStocks('茅台');
    expect(byName[0]?.id).toBe('600519.SH');
    expect(await adapter.searchStocks('   ')).toEqual([]);
  });
});

/** 最小 fake adapter：只带 searchStocks。 */
const fakeSearchAdapter = (
  name: string,
  impl: () => Promise<StockSearchCandidate[]>,
  calls: { n: number },
) => ({
  name,
  fetchQuote: () => Promise.reject(new Error('not used')),
  batchQuote: () => Promise.reject(new Error('not used')),
  fetchDailyBars: () => Promise.reject(new Error('not used')),
  searchStocks: () => {
    calls.n += 1;
    return impl();
  },
});

describe('MarketDataManager.searchStocks', () => {
  const fakeCandidate: StockSearchCandidate = {
    id: '601398.SH',
    code: '601398',
    exchange: 'SH',
    name: '工商银行',
  };

  it('primary 成功 → 不调 fallback', async () => {
    const pCalls = { n: 0 };
    const fCalls = { n: 0 };
    const manager = new MarketDataManager({
      primary: fakeSearchAdapter('p', () => Promise.resolve([fakeCandidate]), pCalls),
      fallback: fakeSearchAdapter('f', () => Promise.resolve([]), fCalls),
      finalFallback: new FakeMarketAdapter(),
      logger: silentLogger,
    });
    const result = await manager.searchStocks('工商');
    expect(result).toEqual([fakeCandidate]);
    expect(pCalls.n).toBe(1);
    expect(fCalls.n).toBe(0);
  });

  it('primary 返回空数组 → 不降级（空是合法答案）', async () => {
    const calls = { n: 0 };
    const manager = new MarketDataManager({
      primary: fakeSearchAdapter('p', () => Promise.resolve([]), calls),
      fallback: fakeSearchAdapter('f', () => Promise.resolve([fakeCandidate]), { n: 0 }),
      finalFallback: new FakeMarketAdapter(),
      logger: silentLogger,
    });
    expect(await manager.searchStocks('不存在的股票')).toEqual([]);
    expect(calls.n).toBe(1);
  });

  it('primary + fallback 都抛错 → 降级 mock fixtures', async () => {
    const manager = new MarketDataManager({
      primary: fakeSearchAdapter('p', () => Promise.reject(new Error('down')), { n: 0 }),
      fallback: fakeSearchAdapter('f', () => Promise.reject(new Error('down')), { n: 0 }),
      finalFallback: new FakeMarketAdapter(),
      logger: silentLogger,
    });
    const result = await manager.searchStocks('茅台');
    expect(result[0]?.id).toBe('600519.SH');
  });
});
