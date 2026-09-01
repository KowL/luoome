import { describe, expect, it, vi } from 'vitest';

import { parseTenjqkaNews, TenjqkaNewsSource, tenjqkaNewsUrl } from './10jqka.js';

const FIXTURE = {
  code: '200',
  msg: '成功',
  data: {
    list: [
      {
        id: '5082091',
        title: '蔚来预计下半年单车成本继续上涨',
        digest: '公司在业绩会上表示材料成本仍有上涨风险。（财联社）',
        url: 'https://news.10jqka.com.cn/20260901/c679502256.shtml',
        ctime: '1788268109',
      },
    ],
  },
};

describe('10jqka news adapter', () => {
  it('URL 带页码和页大小', () => {
    expect(tenjqkaNewsUrl(3, 8)).toContain('page=3');
    expect(tenjqkaNewsUrl(3, 8)).toContain('pagesize=8');
  });

  it('解析 digest、ctime 与原文链接', () => {
    const items = parseTenjqkaNews(FIXTURE);
    expect(items[0]).toMatchObject({
      id: '5082091',
      source: '同花顺快讯',
      url: 'https://news.10jqka.com.cn/20260901/c679502256.shtml',
    });
    expect(items[0]?.summary).toContain('财联社');
    expect(items[0]?.published_at).toBe(new Date(1788268109 * 1000).toISOString());
  });

  it('请求携带上游所需 Referer 和 User-Agent', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(FIXTURE), { status: 200 }),
    ) as unknown as typeof fetch;
    const source = new TenjqkaNewsSource(fetchImpl);
    const result = await source.fetchNews(2, 8);
    expect(result.items).toHaveLength(1);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
    expect(String(url)).toContain('page=2');
    expect(init?.headers).toMatchObject({
      referer: 'https://news.10jqka.com.cn/',
      'user-agent': 'Mozilla/5.0',
    });
  });
});
