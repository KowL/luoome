import { describe, expect, it } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';

/**
 * EastmoneySource.fetchList 委托测试（RPT_DAILYBILLBOARD_DETAILS）。
 * 解析断言保留自原 EastmoneyDragonTigerAdapter 测试；传输错误收敛为 SourceExecutionError。
 * 全程 fetchImpl stub，不依赖网络。
 */

const REPORT_FIXTURE = {
  version: 'v1',
  result: {
    pages: 1,
    data: [
      {
        TRADE_DATE: '2026-08-21 00:00:00',
        SECURITY_CODE: '600547',
        SECUCODE: '600547.SH',
        SECURITY_NAME_ABBR: '山东黄金',
        CLOSE_PRICE: 37.05,
        CHANGE_RATE: 4.9575,
        TURNOVERRATE: 4.1323,
        EXPLANATION: '非S证券连续三个交易日内收盘价格涨幅偏离值累计达到20%的证券',
        EXPLAIN: '1家机构买入，成功率43.83%',
        BILLBOARD_NET_AMT: 855648751.87,
        BILLBOARD_BUY_AMT: 3371674861.76,
        BILLBOARD_SELL_AMT: 2516026109.89,
        ACCUM_AMOUNT: 17302349779,
        TRADE_ID: '100400189',
      },
      {
        TRADE_DATE: '2026-08-21 00:00:00',
        SECURITY_CODE: '300142',
        SECURITY_NAME_ABBR: '沃森生物',
        CLOSE_PRICE: 16.1,
        CHANGE_RATE: 6.4815,
        TURNOVERRATE: 32.2905,
        EXPLANATION: '日换手率达到30%的前5只证券',
        BILLBOARD_NET_AMT: 506112365.36,
        BILLBOARD_BUY_AMT: 1217288510.42,
        BILLBOARD_SELL_AMT: 711176145.06,
        ACCUM_AMOUNT: 8179433603,
      },
    ],
  },
};

const BUY_SEAT_FIXTURE = {
  result: {
    pages: 1,
    data: [
      {
        SECURITY_CODE: '600547',
        TRADE_DATE: '2026-08-21 00:00:00',
        OPERATEDEPT_NAME: '沪股通专用',
        EXPLANATION: '非S证券连续三个交易日内收盘价格涨幅偏离值累计达到20%的证券',
        BUY: 931_448_827.85,
        TRADE_ID: '100400189',
      },
    ],
  },
};

const SELL_SEAT_FIXTURE = {
  result: {
    pages: 1,
    data: [
      {
        SECURITY_CODE: '600547',
        TRADE_DATE: '2026-08-21 00:00:00',
        OPERATEDEPT_NAME: '机构专用',
        EXPLANATION: '非S证券连续三个交易日内收盘价格涨幅偏离值累计达到20%的证券',
        SELL: 411_053_559.83,
        TRADE_ID: '100400189',
      },
    ],
  },
};

const stubFetch = (handler: (url: string) => Promise<Response>) => {
  const urls: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    urls.push(String(url));
    return handler(String(url));
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
};

/** 2026-08-21 上海 16:00（已收盘）。 */
const afterClose = () => new Date('2026-08-21T08:00:00.000Z');

describe('EastmoneySource.fetchList', () => {
  it('字段映射：行情 / 金额 / 交易日与买卖席位', async () => {
    const { fetchImpl, urls } = stubFetch((url) => {
      const fixture = url.includes('RPT_BILLBOARD_DAILYDETAILSBUY')
        ? BUY_SEAT_FIXTURE
        : url.includes('RPT_BILLBOARD_DAILYDETAILSSELL')
          ? SELL_SEAT_FIXTURE
          : REPORT_FIXTURE;
      return Promise.resolve(new Response(JSON.stringify(fixture), { status: 200 }));
    });
    const source = new EastmoneySource({ fetchImpl, clock: afterClose });
    const result = await source.fetchList('2026-08-21');

    expect(urls[0]).toContain('reportName=RPT_DAILYBILLBOARD_DETAILS');
    expect(urls[0]).toContain(encodeURIComponent("(TRADE_DATE='2026-08-21')"));
    expect(result.date).toBe('2026-08-21');
    expect(result.observedAt).toEqual(new Date('2026-08-21T07:00:00.000Z'));
    expect(result.entries).toHaveLength(2);

    const first = result.entries[0];
    expect(first?.code).toBe('600547');
    expect(first?.name).toBe('山东黄金');
    expect(first?.close).toBe(37.05);
    expect(first?.change_pct).toBeCloseTo(0.049575, 6);
    expect(first?.turnover_rate).toBeCloseTo(0.041323, 6);
    expect(first?.reason).toBe('非S证券连续三个交易日内收盘价格涨幅偏离值累计达到20%的证券');
    expect(first?.net_amount).toBeCloseTo(855648751.87, 2);
    expect(first?.buy_amount).toBeCloseTo(3371674861.76, 2);
    expect(first?.sell_amount).toBeCloseTo(2516026109.89, 2);
    expect(first?.amount).toBe(17302349779);
    expect(first?.trade_date).toBe('2026-08-21');
    expect(first?.buy_seats).toEqual([
      expect.objectContaining({
        name: '沪股通专用',
        amount: 931_448_827.85,
        trade_id: '100400189',
      }),
    ]);
    expect(first?.sell_seats).toEqual([
      expect.objectContaining({
        name: '机构专用',
        amount: 411_053_559.83,
        trade_id: '100400189',
      }),
    ]);
  });

  it('EXPLANATION 缺失时回退 EXPLAIN；金额字段缺失 → 缺省（manager 归一为 0）', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            result: {
              pages: 1,
              data: [
                {
                  TRADE_DATE: '2026-08-21 00:00:00',
                  SECURITY_CODE: '000001',
                  SECURITY_NAME_ABBR: '平安银行',
                  CLOSE_PRICE: 12.5,
                  EXPLAIN: '2家机构卖出',
                },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const source = new EastmoneySource({ fetchImpl });
    const [entry] = (await source.fetchList('2026-08-21')).entries;
    expect(entry?.reason).toBe('2家机构卖出');
    expect(entry?.change_pct).toBeUndefined();
    expect(entry?.net_amount).toBeUndefined();
  });

  it('非交易日 / 空数据（result=null）→ 空 entries，不抛错', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ result: null }), { status: 200 })),
    );
    const source = new EastmoneySource({ fetchImpl });
    const result = await source.fetchList('2026-08-22');
    expect(result.entries).toEqual([]);
  });

  it('非法条目（缺代码 / 代码非 6 位 / 价格非法）被剔除', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            result: {
              pages: 1,
              data: [
                { SECURITY_NAME_ABBR: '无代码', CLOSE_PRICE: 10 },
                { SECURITY_CODE: 'ABC123', CLOSE_PRICE: 10 },
                { SECURITY_CODE: '600004', CLOSE_PRICE: 0 },
                { SECURITY_CODE: '600005', CLOSE_PRICE: 9, CHANGE_RATE: 10 },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );
    const source = new EastmoneySource({ fetchImpl });
    const result = await source.fetchList('2026-08-21');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.code).toBe('600005');
  });

  it('HTTP 非 2xx / 网络错误 / 非 JSON → 结构化 SourceExecutionError', async () => {
    const http502 = new EastmoneySource({
      fetchImpl: (() => Promise.resolve(new Response('boom', { status: 502 }))) as never,
    });
    await expect(http502.fetchList('2026-08-21')).rejects.toMatchObject({
      kind: 'upstream_error',
    });

    const netErr = new EastmoneySource({
      fetchImpl: (() => Promise.reject(new TypeError('socket hang up'))) as never,
    });
    await expect(netErr.fetchList('2026-08-21')).rejects.toMatchObject({ kind: 'network' });

    const badJson = new EastmoneySource({
      fetchImpl: (() => Promise.resolve(new Response('not-json', { status: 200 }))) as never,
    });
    await expect(badJson.fetchList('2026-08-21')).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });
});
