import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FuyaoClient } from '../fuyao/client.js';
import { FuyaoAShareSentimentSource } from './fuyao.js';

/**
 * FuyaoAShareSentimentSource 测试（Phase 0 真实证据 fixture）。
 *
 * fixture 来自 docs/ddd/fuyao-phase0-special-evidence.md §2.1/§2.2（2026-11-03 真实 Key 实盘）：
 * - limit-up-pool.page{1,2}.json：封板池两页（pagination{total=52,pages=2,size=50}）；
 * - limit-break-pool.page1.json：炸板池单页（pagination{total=33,pages=1}，
 *   含 open_times / turnover_ratio_pct / turnover / first_seal_time / last_seal_time）。
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
  new FuyaoAShareSentimentSource({
    client: new FuyaoClient(TEST_CONFIG, { fetchImpl }),
    clock,
  });

const COVERAGE = 'CN_A_SHARES_SH_SZ' as const;

describe('FuyaoAShareSentimentSource.fetchSealedPool', () => {
  it('分页读尽两页合并；continue_day_cnt→ladderLevel、seal_money→sealAmount、open_times→openCount', async () => {
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
    const pool = await source.fetchSealedPool({ date: '2026-11-03', coverage: COVERAGE });

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/api/a-share/special-data/limit-up-pool');
    expect(urls[0]).toContain('date_ms=1793635200000');

    expect(pool.ok).toBe(true);
    if (!pool.ok) return;
    // page1 3 条 + page2 2 条 = 5 条
    expect(pool.entries).toHaveLength(5);
    expect(pool.observedAt).toEqual(new Date('2026-11-03T15:00:00+08:00'));

    const stdoushen = pool.entries.find((e) => e.stockId === '300010.SZ');
    expect(stdoushen).toBeDefined();
    expect(stdoushen?.name).toBe('ST豆神');
    expect(stdoushen?.ladderLevel).toBe(2); // continue_day_cnt=2
    expect(stdoushen?.sealAmount).toBeCloseTo(11655819.1, 2); // seal_money
    expect(stdoushen?.openCount).toBeNull(); // open_times=null（未开板）

    const zhejiang = pool.entries.find((e) => e.stockId === '002522.SZ');
    expect(zhejiang?.ladderLevel).toBe(1);
    expect(zhejiang?.openCount).toBe(2); // open_times=2（开板 2 次）
  });

  it('权限错误（code=2003）→ ok:false 池（http_error），不抛错（存量结果契约）', async () => {
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
    const pool = await source.fetchSealedPool({ date: '2026-11-03', coverage: COVERAGE });
    expect(pool.ok).toBe(false);
    if (pool.ok) return;
    // 2003 → permission → 池边界归一为 http_error（与 Eastmoney 池口径一致）
    expect(pool.errorKind).toBe('http_error');
  });
});

describe('FuyaoAShareSentimentSource.fetchBrokenPool', () => {
  it('炸板池单页：open_times→openCount、sealAmount=null（不合成封单额 §7.2）', async () => {
    const { fetchImpl, urls } = stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(loadFixture('limit-break-pool.page1.json')), { status: 200 }),
      ),
    );
    const source = mkSource(fetchImpl);
    const pool = await source.fetchBrokenPool({ date: '2026-11-03', coverage: COVERAGE });

    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/api/a-share/special-data/limit-break-pool');

    expect(pool.ok).toBe(true);
    if (!pool.ok) return;
    expect(pool.entries).toHaveLength(3);

    const kunchuan = pool.entries.find((e) => e.stockId === '301311.SZ');
    expect(kunchuan).toBeDefined();
    expect(kunchuan?.name).toBe('昆船智能');
    expect(kunchuan?.openCount).toBe(5); // open_times=5
    expect(kunchuan?.sealAmount).toBeNull(); // 炸板池不合成封单额（§7.2）
    expect(kunchuan?.ladderLevel).toBe(1); // 炸板股票当日未封住，记首板尝试
  });

  it('超页返回空 item 是合法终止（pages=1 时 page=2 不再请求）', async () => {
    // 炸板池实测 pages=1：只请求 page=1，不因空页或多页假设多发请求
    const { fetchImpl, urls } = stubFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify(loadFixture('limit-break-pool.page1.json')), { status: 200 }),
      ),
    );
    const source = mkSource(fetchImpl);
    const pool = await source.fetchBrokenPool({ date: '2026-11-03', coverage: COVERAGE });
    expect(pool.ok).toBe(true);
    expect(urls).toHaveLength(1);
  });

  it('超过 30 天窗口 → unsupported_date 池（不发请求，与 Eastmoney 口径对齐）', async () => {
    const { fetchImpl, urls } = stubFetch(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    // clock 固定在 2026-11-03；2026-09-01 超出 30 天窗口
    const source = mkSource(fetchImpl, afterClose);
    const pool = await source.fetchBrokenPool({ date: '2026-09-01', coverage: COVERAGE });
    expect(pool.ok).toBe(false);
    if (pool.ok) return;
    expect(pool.errorKind).toBe('unsupported_date');
    expect(urls).toHaveLength(0); // 未发请求
  });

  it('缺分页（pagination 缺失）→ ok:false 池（invalid_response），不转成正常空池（§7.2）', async () => {
    const noPagination = {
      code: 0,
      message: 'success',
      request_id: 'r1',
      data: { timestamp: 1793719150330, item: [] },
    };
    const { fetchImpl } = stubFetch(() =>
      Promise.resolve(new Response(JSON.stringify(noPagination), { status: 200 })),
    );
    const source = mkSource(fetchImpl);
    const pool = await source.fetchBrokenPool({ date: '2026-11-03', coverage: COVERAGE });
    expect(pool.ok).toBe(false);
    if (pool.ok) return;
    expect(pool.errorKind).toBe('invalid_response');
  });
});
