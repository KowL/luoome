import type { FetchNewsQuery, Logger } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';
import { createNewsManagerFromEnv } from './factory.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const baseQuery: FetchNewsQuery = {
  limit: 30,
  source: 'eastmoney',
};

const newsFixture = {
  code: '1',
  message: 'success',
  data: {
    page_index: 1,
    list: [
      {
        code: 'n1',
        title: '央行宣布降准释放流动性',
        summary: '中国人民银行宣布……',
        showTime: '2026-08-22 10:12:00',
        uniqueUrl: 'https://finance.eastmoney.com/a/n1.html',
        mediaName: '人民日报',
      },
      {
        code: 'n2',
        title: '美联储释放鸽派信号',
        summary: '美联储主席在会议后表示……',
        showTime: '2026-08-22 09:00:00',
        uniqueUrl: 'https://finance.eastmoney.com/a/n2.html',
        mediaName: '东方财富',
      },
      {
        code: 'n3',
        title: 'A股三大指数集体收涨',
        summary: '两市成交额突破万亿……',
        showTime: '2026-08-22 08:00:00',
        uniqueUrl: 'https://finance.eastmoney.com/a/n3.html',
        mediaName: '证券时报',
      },
    ],
  },
};

const stubFetch = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('createNewsManagerFromEnv', () => {
  it('不配置任何 env 也返回可用的 news manager', () => {
    const m = createNewsManagerFromEnv({}, { logger: noopLogger });
    expect(m.name).toBe('news');
    expect(typeof m.fetchNews).toBe('function');
    expect(m.sources).toEqual(['eastmoney']);
  });

  it('配置未注册数据源时启动期失败，不做隐式 Eastmoney fallback', () => {
    expect(() =>
      createNewsManagerFromEnv({ LUOOME_NEWS_SOURCES: 'tushare' }, { logger: noopLogger }),
    ).toThrow();
  });

  it('重复数据源在启动期失败', () => {
    expect(() =>
      createNewsManagerFromEnv(
        { LUOOME_NEWS_SOURCES: 'eastmoney,eastmoney' },
        { logger: noopLogger },
      ),
    ).toThrow();
  });

  it('注入共享 EastmoneySource 时复用该实例，不再用 deps.fetchImpl 自构', async () => {
    const injectedFetch = stubFetch(newsFixture);
    const selfConstructFetch = vi.fn(async () => {
      throw new Error('must not self-construct');
    }) as unknown as typeof fetch;

    const m = createNewsManagerFromEnv(
      {},
      {
        logger: noopLogger,
        fetchImpl: selfConstructFetch,
        sources: { eastmoney: new EastmoneySource({ fetchImpl: injectedFetch }) },
      },
    );
    const r = await m.fetchNews(baseQuery);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data?.source).toBe('eastmoney');
    expect(r.data?.total).toBe(3);
    expect(injectedFetch).toHaveBeenCalled();
    expect(selfConstructFetch).not.toHaveBeenCalled();
  });

  it('status() 暴露 registry 观测（binding 未执行时无执行事实）', () => {
    const m = createNewsManagerFromEnv({}, { logger: noopLogger });
    const status = m.status();
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({
      dataset: 'finance-news',
      source: 'eastmoney',
      coverage: ['CN_FINANCE_NEWS'],
    });
  });

  it('fetchImpl 返回 fixture 时 fetchNews 返回映射后的列表（含分类推断）', async () => {
    const fetchImpl = stubFetch(newsFixture);
    const m = createNewsManagerFromEnv({}, { logger: noopLogger, fetchImpl });
    const r = await m.fetchNews(baseQuery);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const data = r.data;
    expect(data).toBeDefined();
    if (data === undefined) return;

    expect(data.source).toBe('eastmoney');
    expect(data.total).toBe(3);
    expect(data.items[0]?.title).toBe('央行宣布降准释放流动性');
    expect(data.items[0]?.category).toBe('宏观');
    expect(data.items[1]?.category).toBe('海外');
    expect(data.items[2]?.category).toBe('市场');
    expect(data.items[0]?.publishedAt.toISOString()).toBe('2026-08-22T02:12:00.000Z');

    // 固定拉取池 100 条
    const calledUrl = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(calledUrl).toContain('page_size=100');
  });

  it('category / keyword 过滤在 manager 侧执行，limit 截断', async () => {
    const fetchImpl = stubFetch(newsFixture);
    const m = createNewsManagerFromEnv({}, { logger: noopLogger, fetchImpl });

    const byCategory = await m.fetchNews({ ...baseQuery, category: '海外' });
    expect(byCategory.ok).toBe(true);
    if (byCategory.ok) {
      expect(byCategory.data?.total).toBe(1);
      expect(byCategory.data?.items[0]?.title).toContain('美联储');
    }

    const byKeyword = await m.fetchNews({ ...baseQuery, keyword: '成交额' });
    expect(byKeyword.ok).toBe(true);
    if (byKeyword.ok) {
      expect(byKeyword.data?.total).toBe(1);
      expect(byKeyword.data?.items[0]?.title).toContain('收涨');
    }

    const truncated = await m.fetchNews({ ...baseQuery, limit: 2 });
    expect(truncated.ok).toBe(true);
    if (truncated.ok) expect(truncated.data?.total).toBe(2);

    const empty = await m.fetchNews({ ...baseQuery, keyword: '不存在的关键词' });
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.data?.total).toBe(0);
      expect(empty.data?.warnings).toContain('empty-list');
    }
  });

  it('fetchImpl 抛错时返回 adapter_error', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const m = createNewsManagerFromEnv({}, { logger: noopLogger, fetchImpl });
    const r = await m.fetchNews(baseQuery);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    const error = r.error;
    expect(error).toBeDefined();
    if (error === undefined) return;
    expect(error.kind).toBe('adapter_error');
    expect(error.adapter).toBe('news');
    expect(error.message).toContain('network down');
  });
});
