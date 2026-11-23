import { describe, expect, it } from 'vitest';

import { SinaSectorQuoteAdapter } from './sina.js';

/**
 * SinaSectorQuoteAdapter 单元测试。
 * 全程 fetchImpl stub 模拟 newSinaHy.php 响应，不依赖网络。
 *
 * 新浪返回 GBK 字节流；Node 无 GBK encoder，测试直接拼字节：
 * ASCII 段走 TextEncoder，中文用手工 GBK 序列（与 tencent.test.ts 同口径）。
 */
const GBK = {
  玻璃行业: [178, 163, 193, 167, 208, 208, 210, 181],
  亚玛顿: [209, 199, 194, 234, 182, 217],
  酿酒行业: [196, 240, 190, 198, 208, 208, 210, 181],
  皇台酒业: [187, 202, 204, 168, 190, 198, 210, 181],
  没有领涨股: [195, 187, 211, 208, 193, 236, 213, 199, 185, 201],
} as const;

const encoder = new TextEncoder();

const gbkBytesOf = (part: string): readonly number[] | undefined =>
  Object.hasOwn(GBK, part) ? GBK[part as keyof typeof GBK] : undefined;

const encodeParts = (parts: readonly (string | keyof typeof GBK)[]): number[] =>
  parts.flatMap((part) => {
    const gbk = gbkBytesOf(part);
    return gbk === undefined ? [...encoder.encode(part)] : [...gbk];
  });

interface Row {
  readonly key: string;
  readonly fields: readonly (string | keyof typeof GBK)[];
}

const gbkBody = (rows: readonly Row[]): Response => {
  const bytes = encodeParts(['var S_Finance_bankuai_sinaindustry = {']);
  rows.forEach((row, index) => {
    bytes.push(...encodeParts([`${index === 0 ? '' : ','}"${row.key}":"`]));
    row.fields.forEach((field, fieldIndex) => {
      if (fieldIndex > 0) bytes.push(...encoder.encode(','));
      bytes.push(...encodeParts([field]));
    });
    bytes.push(...encoder.encode('"'));
  });
  bytes.push(...encoder.encode('};\n'));
  return new Response(Uint8Array.from(bytes), { status: 200 });
};

const GLASS: Row = {
  key: 'new_blhy',
  fields: [
    'new_blhy',
    '玻璃行业',
    '19',
    '12.223157894737',
    '0.31157894736842',
    '2.6157652880877',
    '585930197',
    '7662499219',
    'sz002623',
    '10.012',
    '18.570',
    '1.690',
    '亚玛顿',
  ],
};

const LIQUOR: Row = {
  key: 'new_ljhy',
  fields: [
    'new_ljhy',
    '酿酒行业',
    '33',
    '69.8459375',
    '-1.226875',
    '-1.7262226677747',
    '325864645',
    '15162544223',
    'sz000995',
    '8.663',
    '14.300',
    '1.140',
    '皇台酒业',
  ],
};

/** 空领涨股 / 空数值列：解析后不得补零或伪造代码。 */
const EMPTY_LEADING: Row = {
  key: 'new_qtxy',
  fields: ['new_qtxy', '没有领涨股', '10', '5.5', '0.1', '1.2', '1000', '2000', '', '', '', '', ''],
};

const stubFetch = (handler: (url: string) => Promise<Response>) => {
  const urls: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    urls.push(String(url));
    return handler(String(url));
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
};

describe('SinaSectorQuoteAdapter', () => {
  it('GBK + JS 包裹：解析固定 CSV 顺序，涨跌幅归一为小数，领涨股代码转 stockId', async () => {
    const { fetchImpl, urls } = stubFetch(() => Promise.resolve(gbkBody([GLASS])));
    const result = await new SinaSectorQuoteAdapter(fetchImpl).fetchList(50, 'f3');

    expect(urls[0]).toBe('https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php');
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.code).toBe('new_blhy');
    expect(item?.name).toBe('玻璃行业');
    expect(item?.price).toBeCloseTo(12.223157894737);
    expect(item?.change_pct).toBeCloseTo(0.026157652880877);
    expect(item?.change).toBeCloseTo(0.31157894736842);
    expect(item?.amount).toBe(7_662_499_219);
    // 新浪没有涨跌家数字段：保持 undefined，不补 0
    expect(item?.up_count).toBeUndefined();
    expect(item?.down_count).toBeUndefined();
    expect(item?.leading_stock_code).toBe('002623.SZ');
    expect(item?.leading_stock_name).toBe('亚玛顿');
    expect(item?.leading_stock_change_pct).toBeCloseTo(0.10012);
  });

  it('按 fid 本地排序并截断：f3 涨跌幅降序，f6 成交额降序', async () => {
    const rows = [LIQUOR, EMPTY_LEADING, GLASS];
    const adapter = new SinaSectorQuoteAdapter((() =>
      Promise.resolve(gbkBody(rows))) as unknown as typeof fetch);

    const byChange = await adapter.fetchList(2, 'f3');
    expect(byChange.items.map((item) => item.code)).toEqual(['new_blhy', 'new_qtxy']);

    const byAmount = await adapter.fetchList(undefined, 'f6');
    expect(byAmount.items.map((item) => item.code)).toEqual(['new_ljhy', 'new_blhy', 'new_qtxy']);
    await expect(adapter.fetchList(2, 'f6')).resolves.toMatchObject({
      items: [{ code: 'new_ljhy' }, { code: 'new_blhy' }],
    });
  });

  it('空领涨股 / 非法数值列：可选字段保持 undefined，坏行剔除', async () => {
    const badRows: Row[] = [
      EMPTY_LEADING,
      {
        key: 'new_bad1',
        fields: [
          'new_bad1',
          '',
          '1',
          '9.9',
          '0.1',
          '1.0',
          '1',
          '1',
          'sz000001',
          '1',
          '1',
          '1',
          '甲',
        ],
      },
      { key: 'new_bad2', fields: ['new_bad2', '缺价', '1', '', '0.1', '1.0', '1', '1'] },
      { key: 'new_bad3', fields: ['new_bad3', '缺涨幅', '1', '9.9', '0.1', '', '1', '1'] },
      { key: 'new_bad4', fields: ['new_bad4', '字段不足', '1', '9.9', '0.1', '1.0'] },
    ];
    const result = await new SinaSectorQuoteAdapter((() =>
      Promise.resolve(gbkBody(badRows))) as unknown as typeof fetch).fetchList(undefined, 'f3');

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.code).toBe('new_qtxy');
    expect(item?.leading_stock_code).toBeUndefined();
    expect(item?.leading_stock_name).toBeUndefined();
    expect(item?.leading_stock_change_pct).toBeUndefined();
  });

  it('空对象 → 空 items；缺 JS 对象 / 非 JSON → invalid_payload', async () => {
    const empty = await new SinaSectorQuoteAdapter((() =>
      Promise.resolve(gbkBody([]))) as unknown as typeof fetch).fetchList(50, 'f3');
    expect(empty.items).toEqual([]);

    const noObject = new SinaSectorQuoteAdapter((() =>
      Promise.resolve(new Response('', { status: 200 }))) as unknown as typeof fetch);
    await expect(noObject.fetchList(50, 'f3')).rejects.toMatchObject({
      kind: 'invalid_payload',
    });

    const brokenJson = new SinaSectorQuoteAdapter((() =>
      Promise.resolve(new Response('var x = {bad}', { status: 200 }))) as unknown as typeof fetch);
    await expect(brokenJson.fetchList(50, 'f3')).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });

  it('HTTP 502 / 网络错误 → 抛携带结构化 kind 的 SourceExecutionError', async () => {
    const http502 = new SinaSectorQuoteAdapter((() =>
      Promise.resolve(new Response('boom', { status: 502 }))) as unknown as typeof fetch);
    await expect(http502.fetchList(50, 'f3')).rejects.toMatchObject({
      kind: 'upstream_error',
      message: expect.stringContaining('HTTP 502'),
    });

    const netErr = new SinaSectorQuoteAdapter((() =>
      Promise.reject(new TypeError('socket hang up'))) as unknown as typeof fetch);
    await expect(netErr.fetchList(50, 'f3')).rejects.toMatchObject({
      kind: 'network',
      message: expect.stringContaining('socket hang up'),
    });
  });
});
