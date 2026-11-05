import { describe, expect, it } from 'vitest';

import { FuyaoClient } from '../fuyao/client.js';
import catalogIndustry from '../fuyao/fixtures/sector-catalog.industry.json';
import sectorSnapshot from '../fuyao/fixtures/sector-snapshot.json';
import { FuyaoSectorQuoteAdapter } from './fuyao.js';

const envelope = (data: unknown) =>
  JSON.stringify({ code: 0, message: 'success', request_id: '0'.repeat(32), data });

const fakeClockSleep = (): { clock: () => number; sleep: (ms: number) => Promise<void> } => {
  let now = 1_000_000;
  return {
    clock: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
};

const mkClient = (responses: readonly string[]): { client: FuyaoClient; urls: string[] } => {
  const urls: string[] = [];
  let call = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    const body = responses[Math.min(call, responses.length - 1)] ?? '';
    call += 1;
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const { clock, sleep } = fakeClockSleep();
  const client = new FuyaoClient(
    { baseUrl: 'https://fuyao.test', apiKey: 'k', timeoutMs: 1000, retries: 0 },
    { fetchImpl, clock, sleep },
  );
  return { client, urls };
};

describe('FuyaoSectorQuoteAdapter', () => {
  it('目录 + 快照 join：.TI 身份保留，name 来自目录（快照无 name），百分数 /100', async () => {
    const { client, urls } = mkClient([
      envelope(catalogIndustry.data),
      envelope(sectorSnapshot.data),
    ]);
    const adapter = new FuyaoSectorQuoteAdapter(client);

    const result = await adapter.fetchList(undefined, 'f3');
    expect(urls[0]).toContain('tag=industry');
    expect(urls[1]).toContain('thscodes=881101.TI');

    // 目录 3 条中只有 881101.TI 在快照里有有效价格
    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(item?.code).toBe('881101.TI');
    expect(item?.name).toBe('种植业与林业');
    expect(item?.price).toBe(3874.159);
    // 0.538797% → 小数 0.00538797
    expect(item?.change_pct).toBeCloseTo(0.00538797, 10);
    expect(item?.change).toBe(20.762);
    expect(item?.amount).toBe(5405017400);
    // 上游不返回上涨/下跌家数与领涨股，保持缺省
    expect(item?.up_count).toBeUndefined();
    expect(item?.down_count).toBeUndefined();
    expect(item?.leading_stock_name).toBeUndefined();
  });

  it('快照缺失或价格非法的指数跳过，不用目录名称合成行', async () => {
    const snapshotMissing = {
      timestamp: 1793719163000,
      total: 3,
      item: [
        {
          thscode: '881101.TI',
          ticker: '881101',
          last_price: null,
          price_change: null,
          price_change_ratio_pct: null,
          turnover: null,
        },
        {
          thscode: '884001.TI',
          ticker: '884001',
          last_price: 0,
          price_change: 0,
          price_change_ratio_pct: 0,
          turnover: 0,
        },
        // 884002.TI 快照整行缺失
      ],
    };
    const { client } = mkClient([envelope(catalogIndustry.data), envelope(snapshotMissing)]);
    const adapter = new FuyaoSectorQuoteAdapter(client);

    const result = await adapter.fetchList(undefined, 'f3');
    expect(result.items).toHaveLength(0);
  });

  it('fid=f3 本地按涨跌幅降序；fid=f6 按成交额降序（上游快照不支持排序）', async () => {
    const snapshot = {
      timestamp: 1,
      total: 3,
      item: [
        {
          thscode: '881101.TI',
          ticker: '881101',
          last_price: 100,
          price_change: 1,
          price_change_ratio_pct: 1.5,
          turnover: 300,
        },
        {
          thscode: '884001.TI',
          ticker: '884001',
          last_price: 100,
          price_change: 1,
          price_change_ratio_pct: 3.0,
          turnover: 100,
        },
        {
          thscode: '884002.TI',
          ticker: '884002',
          last_price: 100,
          price_change: 1,
          price_change_ratio_pct: -1.0,
          turnover: 200,
        },
      ],
    };
    const byChangePct = mkClient([envelope(catalogIndustry.data), envelope(snapshot)]);
    const f3 = await new FuyaoSectorQuoteAdapter(byChangePct.client).fetchList(undefined, 'f3');
    expect(f3.items.map((item) => item.code)).toEqual(['884001.TI', '881101.TI', '884002.TI']);

    const byAmount = mkClient([envelope(catalogIndustry.data), envelope(snapshot)]);
    const f6 = await new FuyaoSectorQuoteAdapter(byAmount.client).fetchList(undefined, 'f6');
    expect(f6.items.map((item) => item.code)).toEqual(['881101.TI', '884002.TI', '884001.TI']);
  });

  it('pageSize 截断在排序后执行', async () => {
    const snapshot = {
      timestamp: 1,
      total: 3,
      item: [
        {
          thscode: '881101.TI',
          ticker: '881101',
          last_price: 100,
          price_change: 1,
          price_change_ratio_pct: 1.5,
          turnover: 300,
        },
        {
          thscode: '884001.TI',
          ticker: '884001',
          last_price: 100,
          price_change: 1,
          price_change_ratio_pct: 3.0,
          turnover: 100,
        },
        {
          thscode: '884002.TI',
          ticker: '884002',
          last_price: 100,
          price_change: 1,
          price_change_ratio_pct: -1.0,
          turnover: 200,
        },
      ],
    };
    const { client } = mkClient([envelope(catalogIndustry.data), envelope(snapshot)]);
    const result = await new FuyaoSectorQuoteAdapter(client).fetchList(2, 'f3');
    expect(result.items.map((item) => item.code)).toEqual(['884001.TI', '881101.TI']);
  });

  it('目录为空 → 空列表（不发快照请求）；data 形状漂移 → invalid_payload', async () => {
    const emptyCatalog = mkClient([envelope({ timestamp: 1, item: [] })]);
    const empty = await new FuyaoSectorQuoteAdapter(emptyCatalog.client).fetchList(undefined, 'f3');
    expect(empty.items).toHaveLength(0);
    expect(emptyCatalog.urls).toHaveLength(1);

    const drift = mkClient([envelope({ timestamp: 1, item: [{ thscode: 123 }] })]);
    await expect(
      new FuyaoSectorQuoteAdapter(drift.client).fetchList(undefined, 'f3'),
    ).rejects.toMatchObject({ kind: 'invalid_payload' });
  });

  it('change/turnover 为 null 时归一为 0，不视为数据错误', async () => {
    const snapshot = {
      timestamp: 1,
      total: 1,
      item: [
        {
          thscode: '881101.TI',
          ticker: '881101',
          last_price: 100,
          price_change: null,
          price_change_ratio_pct: 1.5,
          turnover: null,
        },
      ],
    };
    const { client } = mkClient([envelope(catalogIndustry.data), envelope(snapshot)]);
    const result = await new FuyaoSectorQuoteAdapter(client).fetchList(undefined, 'f3');
    expect(result.items[0]?.change).toBe(0);
    expect(result.items[0]?.amount).toBe(0);
  });
});
