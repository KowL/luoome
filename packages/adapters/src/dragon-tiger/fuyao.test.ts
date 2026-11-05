import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FuyaoClient } from '../fuyao/client.js';
import { SourceExecutionError } from '../source-error.js';
import { FuyaoDragonTigerSource } from './fuyao.js';

/**
 * FuyaoDragonTigerSource 测试（Phase 0 真实证据 fixture）。
 *
 * fixture 来自 docs/ddd/fuyao-phase0-special-evidence.md §3（2026-11-03 真实 Key 实盘）：
 * - dragon-tiger-list.all.json：all 榜（2 条正常 + 1 条 thscode=null 退市股样本），
 *   trade_date=2026-11-02，stock_items 含 change（小数）、net_value、buy_value、sell_value、
 *   limit_reason、range_days、org_net_value / hot_money_net_value（可缺）。
 * 全程 fetchImpl stub，不依赖网络；request_id 已脱敏置零。
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fuyao/fixtures');

const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));

const TEST_CONFIG = {
  baseUrl: 'https://fuyao.test',
  apiKey: 'test-key',
  timeoutMs: 1_000,
  retries: 0,
};

const stubFetch = (handler: (url: string) => Promise<Response>) => {
  const urls: string[] = [];
  const fetchImpl = ((url: string | URL | Request) => {
    urls.push(String(url));
    return handler(String(url));
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
};

/** 2026-11-02 上海 16:00（已收盘）。 */
const afterClose = () => new Date('2026-11-02T08:00:00.000Z');

const mkSource = (fetchImpl: typeof fetch, clock: () => Date = afterClose) =>
  new FuyaoDragonTigerSource({
    client: new FuyaoClient(TEST_CONFIG, { fetchImpl }),
    clock,
  });

describe('FuyaoDragonTigerSource.fetchList', () => {
  it('all 榜映射：change 小数直传、net/buy/sell 元、range_days 保留、close/turnover 缺省', async () => {
    const { fetchImpl, urls } = stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(loadFixture('dragon-tiger-list.all.json')), { status: 200 }),
      ),
    );
    const source = mkSource(fetchImpl);
    const result = await source.fetchList('2026-11-02');

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/api/a-share/special-data/dragon-tiger-list');
    expect(urls[0]).toContain('board_type=all');
    expect(urls[0]).toContain('date_ms=1793548800000'); // 2026-11-02 上海零点

    expect(result.date).toBe('2026-11-02');
    expect(result.observedAt).toEqual(new Date('2026-11-02T15:00:00+08:00'));
    // 3 条 stock_items（含 1 条 thscode=null 退市股，回退 ticker）
    expect(result.entries).toHaveLength(3);

    const xiangyang = result.entries.find((e) => e.code === '000678');
    expect(xiangyang).toBeDefined();
    expect(xiangyang?.name).toBe('襄阳轴承');
    // change=0.100111 已是小数，直传（不 /100）
    expect(xiangyang?.change_pct).toBeCloseTo(0.100111, 6);
    expect(xiangyang?.net_amount).toBeCloseTo(128665924.03, 2);
    expect(xiangyang?.buy_amount).toBeCloseTo(352172536.96, 2);
    expect(xiangyang?.sell_amount).toBeCloseTo(223506612.93, 2);
    expect(xiangyang?.reason).toContain('机器人轴承');
    expect(xiangyang?.range_days).toBe(1);
    // 契约不提供收盘价与换手率：保持缺省，不用 0 或反推（§8）
    expect(xiangyang?.close).toBeUndefined();
    expect(xiangyang?.turnover_rate).toBeUndefined();
  });

  it('thscode=null 退市股回退 ticker（萃华退 002731），不剔除', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(loadFixture('dragon-tiger-list.all.json')), { status: 200 }),
      ),
    );
    const source = mkSource(fetchImpl);
    const result = await source.fetchList('2026-11-02');

    const cuihua = result.entries.find((e) => e.code === '002731');
    expect(cuihua).toBeDefined();
    expect(cuihua?.name).toBe('萃华退');
    expect(cuihua?.change_pct).toBeCloseTo(-0.04, 6);
    expect(cuihua?.net_amount).toBeCloseTo(-65887.8, 2);
    // limit_reason 缺失 → reason 缺省（manager 归一为 '--'）
    expect(cuihua?.reason).toBeUndefined();
  });

  it('信封日期错配 → invalid_payload（错日不静默当当日榜）', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(loadFixture('dragon-tiger-list.all.json')), { status: 200 }),
      ),
    );
    const source = mkSource(fetchImpl);
    // 请求 2026-11-03，fixture trade_date=2026-11-02 → 错日
    await expect(source.fetchList('2026-11-03')).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });

  it('权限错误（code=2003）→ permission SourceExecutionError（§4.3）', async () => {
    const denied = {
      code: 2003,
      message: 'capability not authorized',
      request_id: 'r1',
      data: null,
    };
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(denied), { status: 200 })),
    );
    const source = mkSource(fetchImpl);
    await expect(source.fetchList('2026-11-02')).rejects.toSatisfy(
      (error) => error instanceof SourceExecutionError && error.kind === 'permission',
    );
  });

  it('ticker 非 6 位数字的条目剔除（不伪造 code）', async () => {
    const fixture = loadFixture('dragon-tiger-list.all.json') as {
      data: { stock_items: Record<string, unknown>[] };
    };
    fixture.data.stock_items = [
      { thscode: null, ticker: 'ABC', name: '非法代码' },
      { thscode: '600547.SH', ticker: '600547', name: '正常', net_value: 100 },
    ];
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(fixture), { status: 200 })),
    );
    const source = mkSource(fetchImpl);
    const result = await source.fetchList('2026-11-02');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.code).toBe('600547');
  });
});
