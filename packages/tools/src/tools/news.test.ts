import { FetchNewsQuerySchema, type NewsList, type NewsManagerLike } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { fetchNewsTool } from './news.js';

const mkList = (): NewsList => ({
  total: 1,
  source: 'eastmoney',
  items: [
    {
      id: 'n1',
      title: '央行宣布降准释放流动性',
      summary: '中国人民银行宣布……',
      category: '宏观',
      source: '人民日报',
      publishedAt: new Date('2026-08-22T10:12:00+08:00'),
      url: 'https://finance.eastmoney.com/a/n1.html',
    },
  ],
  warnings: [],
  asOf: new Date(),
});

const mkManager = (fetchImpl: NewsManagerLike['fetchNews']): NewsManagerLike => ({
  name: 'news',
  sources: ['eastmoney'],
  status: () => [],
  fetchNews: fetchImpl,
});

describe('fetch_news tool', () => {
  const makeCtx = (manager: NewsManagerLike | undefined) =>
    ({
      repos: {} as never,
      adapters: { market: {} as never, llm: {} as never },
      news: manager,
      user: { id: 'u1', defaultAccountId: 'a1' },
      clock: () => new Date(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    }) as never;

  it('manager 未注入 → invalid_input', async () => {
    const r = await fetchNewsTool.execute(FetchNewsQuerySchema.parse({}), makeCtx(undefined));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('manager 成功 → 返回列表', async () => {
    const manager = mkManager(vi.fn(async () => ({ ok: true, data: mkList() })));
    const r = await fetchNewsTool.execute(
      FetchNewsQuerySchema.parse({ category: '宏观', limit: 10 }),
      makeCtx(manager),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBe(1);
    expect(r.data.items[0]?.category).toBe('宏观');
  });

  it('manager 失败 → adapter_error 透传', async () => {
    const manager = mkManager(
      vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'adapter_error' as const,
          adapter: 'news' as const,
          message: 'down',
          recoverable: false,
        },
      })),
    );
    const r = await fetchNewsTool.execute(FetchNewsQuerySchema.parse({}), makeCtx(manager));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('adapter_error');
    if (r.error.kind === 'adapter_error') {
      expect(r.error.adapter).toBe('news');
      expect(r.error.cause).toMatch(/down/);
    }
  });

  it('limit 默认 30；越界输入 → invalid_input', async () => {
    const fetchNews = vi.fn(async () => ({ ok: true as const, data: mkList() }));
    const manager = mkManager(fetchNews);
    const r = await fetchNewsTool.execute({}, makeCtx(manager));
    expect(r.ok).toBe(true);
    expect(fetchNews).toHaveBeenCalledWith({
      page: 1,
      limit: 30,
    });

    const bad = await fetchNewsTool.execute({ limit: 0 }, makeCtx(manager));
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.kind).toBe('invalid_input');
  });
});
