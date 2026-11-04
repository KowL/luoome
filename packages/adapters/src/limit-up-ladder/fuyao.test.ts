import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FuyaoClient } from '../fuyao/client.js';
import { SourceExecutionError } from '../source-error.js';
import { FuyaoLimitUpLadderSource } from './fuyao.js';

/**
 * FuyaoLimitUpLadderSource 测试（Phase 0 真实证据 fixture）。
 *
 * fixture 来自 docs/ddd/fuyao-phase0-special-evidence.md §2.1（2026-11-03 真实 Key 实盘）：
 * - limit-up-pool.page1.json：page=1，pagination{total=52,pages=2,size=50}，3 条截断样本
 *   （含 ST 豆神 20cm、open_times=null 未开板、open_times=2 开板 2 次样本）；
 * - limit-up-pool.page2.json：page=2，剩余 2 条（首板 09:25、2连板 09:25）。
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

/** 2026-11-03 上海 16:00（已收盘）。 */
const afterClose = () => new Date('2026-11-03T08:00:00.000Z');

const mkSource = (fetchImpl: typeof fetch, clock: () => Date = afterClose) =>
  new FuyaoLimitUpLadderSource({
    client: new FuyaoClient(TEST_CONFIG, { fetchImpl }),
    clock,
  });

describe('FuyaoLimitUpLadderSource.fetchLadder', () => {
  it('分页读尽：page < pages 推进，两页合并；date_ms 为上海零点毫秒', async () => {
    const { fetchImpl, urls } = stubFetch((url) => {
      if (url.includes('page=1')) {
        return Promise.resolve(
          new Response(JSON.stringify(loadFixture('limit-up-pool.page1.json')), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(loadFixture('limit-up-pool.page2.json')), { status: 200 }),
      );
    });
    const source = mkSource(fetchImpl);
    const result = await source.fetchLadder('2026-11-03');

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/api/a-share/special-data/limit-up-pool');
    expect(urls[0]).toContain('date_ms=1793635200000'); // 2026-11-03 上海零点
    expect(urls[0]).toContain('page=1');
    expect(urls[1]).toContain('page=2');

    // 两页合并：page1 3 条 + page2 2 条 = 5 条
    expect(result.entries).toHaveLength(5);
    expect(result.date).toBe('2026-11-03');
    // 历史日 observedAt = 收盘时刻（15:00 +08:00）
    expect(result.observedAt).toEqual(new Date('2026-11-03T15:00:00+08:00'));
  });

  it('字段映射：continue_day_cnt→level、HH:MM→HH:MM:SS、pct/100、last_price→close', async () => {
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(loadFixture('limit-up-pool.page1.json')), { status: 200 }),
      ),
    );
    // 单页（pages=2 但 stub 只回 page1；验证按 pages 推进前的单页映射）
    const singlePage = loadFixture('limit-up-pool.page1.json') as {
      data: { pagination: { pages: number } };
    };
    singlePage.data.pagination.pages = 1;
    const { fetchImpl: oneFetch } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(singlePage), { status: 200 })),
    );
    void fetchImpl;
    const source = mkSource(oneFetch);
    const result = await source.fetchLadder('2026-11-03');

    const stdoushen = result.entries.find((e) => e.code === '300010');
    expect(stdoushen).toBeDefined();
    // ST 豆神 20cm：continue_day_cnt=2 → level=2；不能按涨跌幅推断板数（§2.1）
    expect(stdoushen?.level).toBe(2);
    expect(stdoushen?.limit_up_days).toBe(2);
    // limit_up_time "14:52"（HH:MM 无秒）→ "14:52:00"
    expect(stdoushen?.first_time).toBe('14:52:00');
    // price_change_ratio_pct=19.9367（已乘 100）→ change_pct=0.199367
    expect(stdoushen?.change_pct).toBeCloseTo(0.199367, 6);
    // last_price=3.79 → close/rawClose
    expect(stdoushen?.close).toBeCloseTo(3.79, 2);
    // pre_close 反推：3.79 / (1 + 0.199367)
    expect(stdoushen?.pre_close).toBeCloseTo(3.79 / 1.199367, 4);
    expect(stdoushen?.reason).toBe('AI短剧平台+AI教育+算力服务');
    expect(stdoushen?.limit_up_date).toBe('2026-11-03');

    const zhejiang = result.entries.find((e) => e.code === '002522');
    expect(zhejiang?.level).toBe(1);
    expect(zhejiang?.first_time).toBe('14:36:00');
    expect(zhejiang?.change_pct).toBeCloseTo(0.1, 6);
  });

  it('缺分页（pagination 缺失）→ invalid_payload，不转成正常空池（§7.2）', async () => {
    const noPagination = {
      code: 0,
      message: 'success',
      request_id: 'r1',
      data: { timestamp: 1793719131098, item: [] },
    };
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(noPagination), { status: 200 })),
    );
    const source = mkSource(fetchImpl);
    await expect(source.fetchLadder('2026-11-03')).rejects.toMatchObject({
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
    await expect(source.fetchLadder('2026-11-03')).rejects.toSatisfy(
      (error) => error instanceof SourceExecutionError && error.kind === 'permission',
    );
  });

  it('last_price 缺失或非法的条目剔除（不伪造 close）', async () => {
    const fixture = loadFixture('limit-up-pool.page1.json') as {
      data: { pagination: { pages: number }; item: Record<string, unknown>[] };
    };
    fixture.data.pagination.pages = 1;
    fixture.data.item = [
      { thscode: '600001.SH', ticker: '600001', name: '无价格', last_price: null },
      { thscode: '600002.SH', ticker: '600002', name: '零价格', last_price: 0 },
      {
        thscode: '600003.SH',
        ticker: '600003',
        name: '正常',
        last_price: 10.5,
        price_change_ratio_pct: 10,
        continue_day_cnt: 1,
      },
    ];
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(fixture), { status: 200 })),
    );
    const source = mkSource(fetchImpl);
    const result = await source.fetchLadder('2026-11-03');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.code).toBe('600003');
  });
});
