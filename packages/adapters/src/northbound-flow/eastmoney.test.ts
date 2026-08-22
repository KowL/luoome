import { describe, expect, it } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';

/**
 * EastmoneySource.fetchFlow 委托测试（RPT_MUTUAL_DEAL_HISTORY）。
 * 解析断言保留自原 EastmoneyNorthboundFlowAdapter 测试；传输错误收敛为 SourceExecutionError。
 * 金额单位为百万元（×1e6 换算为元）。全程 fetchImpl stub，不依赖网络。
 */

/** 2023-01-05：沪股通净买入 5658.67 百万，深股通 7094.66 百万（真实历史数据口径）。 */
const channelFixture = (
  channel: '001' | '003',
  rows: {
    date: string;
    net: number | null;
    buy: number | null;
    sell: number | null;
    deal: number;
  }[],
) => ({
  success: true,
  result: {
    pages: 1,
    data: rows.map((r) => ({
      MUTUAL_TYPE: channel,
      TRADE_DATE: `${r.date} 00:00:00`,
      NET_DEAL_AMT: r.net,
      BUY_AMT: r.buy,
      SELL_AMT: r.sell,
      DEAL_AMT: r.deal,
    })),
  },
});

const stubFetch = (handler: (url: string) => Promise<Response>) => {
  const urls: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    urls.push(String(url));
    return handler(String(url));
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
};

const okJson = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe('EastmoneySource.fetchFlow', () => {
  it('沪/深双通道请求 + 按日合并 + 百万元换算为元 + date ASC', async () => {
    const { fetchImpl, urls } = stubFetch((url) => {
      if (url.includes('MUTUAL_TYPE%3D%22001%22')) {
        return okJson(
          channelFixture('001', [
            { date: '2023-01-05', net: 5658.67, buy: 23992.48, sell: 18333.81, deal: 42326.29 },
            { date: '2023-01-04', net: 338.41, buy: 18316.48, sell: 17978.07, deal: 36294.55 },
          ]),
        );
      }
      return okJson(
        channelFixture('003', [
          { date: '2023-01-05', net: 7094.66, buy: 30000, sell: 22905.34, deal: 55237.1 },
          { date: '2023-01-04', net: 100, buy: 20000, sell: 19900, deal: 40000 },
        ]),
      );
    });
    const source = new EastmoneySource({ fetchImpl });
    const result = await source.fetchFlow('2023-01-05', 2);

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('reportName=RPT_MUTUAL_DEAL_HISTORY');
    expect(urls[0]).toContain(encodeURIComponent('(MUTUAL_TYPE="001")'));
    expect(urls[1]).toContain(encodeURIComponent('(MUTUAL_TYPE="003")'));
    expect(urls[0]).toContain(encodeURIComponent("(TRADE_DATE<='2023-01-05')"));
    expect(urls[0]).toContain('pageSize=2');

    expect(result.endDate).toBe('2023-01-05');
    expect(result.entries).toHaveLength(2);
    // ASC：01-04 在前
    const [d4, d5] = result.entries;
    expect(d4?.date).toBe('2023-01-04');
    expect(d5?.date).toBe('2023-01-05');
    // 合并 + 换算：(5658.67 + 7094.66) 百万 = 12753330000 元
    expect(d5?.net_amount).toBeCloseTo(12_753_330_000, 0);
    expect(d5?.buy_amount).toBeCloseTo((23992.48 + 30000) * 1e6, 0);
    expect(d5?.sell_amount).toBeCloseTo((18333.81 + 22905.34) * 1e6, 0);
    expect(d5?.deal_amount).toBeCloseTo((42326.29 + 55237.1) * 1e6, 0);
  });

  it('2024-08-16 后净买入字段为 null → net/buy/sell 透传 null，deal 保留', async () => {
    const { fetchImpl } = stubFetch((url) => {
      if (url.includes('MUTUAL_TYPE%3D%22001%22')) {
        return okJson(
          channelFixture('001', [
            { date: '2026-08-21', net: null, buy: null, sell: null, deal: 125846.52 },
          ]),
        );
      }
      return okJson(
        channelFixture('003', [
          { date: '2026-08-21', net: null, buy: null, sell: null, deal: 142241.02 },
        ]),
      );
    });
    const source = new EastmoneySource({ fetchImpl });
    const [entry] = (await source.fetchFlow('2026-08-21', 1)).entries;
    expect(entry?.net_amount).toBeNull();
    expect(entry?.buy_amount).toBeNull();
    expect(entry?.sell_amount).toBeNull();
    expect(entry?.deal_amount).toBeCloseTo((125846.52 + 142241.02) * 1e6, 0);
  });

  it('无数据（result=null）→ 空 entries，不抛错', async () => {
    const { fetchImpl } = stubFetch(() => okJson({ success: true, result: null }));
    const source = new EastmoneySource({ fetchImpl });
    const result = await source.fetchFlow('2026-08-21', 30);
    expect(result.entries).toEqual([]);
  });

  it('报表层业务错误（success=false）→ 抛 upstream_error', async () => {
    const { fetchImpl } = stubFetch(() =>
      okJson({ success: false, message: 'TRADE_DATE排序列不存在', result: null }),
    );
    const source = new EastmoneySource({ fetchImpl });
    await expect(source.fetchFlow('2026-08-21', 30)).rejects.toMatchObject({
      kind: 'upstream_error',
    });
    await expect(source.fetchFlow('2026-08-21', 30)).rejects.toThrow(/报表错误/);
  });

  it('非法行（缺日期 / 缺成交额）被剔除', async () => {
    const { fetchImpl } = stubFetch(() =>
      okJson({
        success: true,
        result: {
          pages: 1,
          data: [
            { MUTUAL_TYPE: '001', TRADE_DATE: null, NET_DEAL_AMT: 1, DEAL_AMT: 100 },
            {
              MUTUAL_TYPE: '001',
              TRADE_DATE: '2026-08-21 00:00:00',
              NET_DEAL_AMT: 1,
              DEAL_AMT: null,
            },
            {
              MUTUAL_TYPE: '001',
              TRADE_DATE: '2026-08-21 00:00:00',
              NET_DEAL_AMT: 1,
              DEAL_AMT: 100,
            },
          ],
        },
      }),
    );
    const source = new EastmoneySource({ fetchImpl });
    const result = await source.fetchFlow('2026-08-21', 30);
    expect(result.entries).toHaveLength(1);
    // stub 对沪/深两个通道返回同一 fixture，合并后 deal 翻倍
    expect(result.entries[0]?.deal_amount).toBe(2 * 100 * 1e6);
  });

  it('HTTP 非 2xx / 网络错误 / 非 JSON → 结构化 SourceExecutionError', async () => {
    const http502 = new EastmoneySource({
      fetchImpl: (() => Promise.resolve(new Response('boom', { status: 502 }))) as never,
    });
    await expect(http502.fetchFlow('2026-08-21', 30)).rejects.toMatchObject({
      kind: 'upstream_error',
    });

    const netErr = new EastmoneySource({
      fetchImpl: (() => Promise.reject(new TypeError('socket hang up'))) as never,
    });
    await expect(netErr.fetchFlow('2026-08-21', 30)).rejects.toMatchObject({ kind: 'network' });

    const badJson = new EastmoneySource({
      fetchImpl: (() => Promise.resolve(new Response('not-json', { status: 200 }))) as never,
    });
    await expect(badJson.fetchFlow('2026-08-21', 30)).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });
});
