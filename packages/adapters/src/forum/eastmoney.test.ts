import { describe, expect, it } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';
import {
  extractArticleListJson,
  forumHotListUrl,
  forumPopularityUrl,
  gubaListUrl,
  parseForumHotList,
  parseForumPopularity,
  parseGubaArticleList,
  popularitySecurityCode,
} from './eastmoney.js';

/**
 * 股吧协议层测试：只用真实响应形状的 fixture，不依赖网络。
 * 时间字段必须按 +08:00 精确解析：列表页表格里的「最后更新」是 12 小时制，不能用于当日窗口。
 */

const articleList = {
  re: [
    {
      post_id: 1802076882,
      post_title: '今天帐户波动估计是近年最小',
      post_content: '量能缩到极致，等方向。',
      post_publish_time: '2026-11-26 15:38:26',
      post_type: 0,
      user_nickname: '嘉华睿投',
      user_id: '3330335645608378',
      post_click_count: 1,
      post_comment_count: 0,
      post_like_count: 2,
    },
    {
      post_id: 1802069326,
      post_title: 'i茅台：上线至今，用户已经突破1亿人',
      post_publish_time: '2026-11-26 15:21:20',
      post_type: 1,
      user_nickname: '贵州茅台资讯',
      user_id: '7344113638256342',
      post_click_count: 961,
      post_comment_count: 7,
    },
    {
      post_id: 1802074102,
      post_title: '今日计划',
      post_publish_time: '2026-11-26 15:31:00',
      post_type: 20,
      user_nickname: '相守湖畔',
      user_id: '3749013714569930',
    },
    { post_id: 1802069327, post_title: '缺发布时间', post_type: 0, user_nickname: 'x' },
  ],
  count: 985646,
};

const html = (payload: unknown): string =>
  `<html><body><script>var article_list=${JSON.stringify(payload)};var other=1;</script></body></html>`;

describe('guba urls', () => {
  it('uses page-1 and f_N pagination forms and maps exchange prefixes', () => {
    expect(gubaListUrl('600519', 1)).toBe('https://guba.eastmoney.com/list,600519.html');
    expect(gubaListUrl('600519', 2)).toBe('https://guba.eastmoney.com/list,600519,f_2.html');
    expect(popularitySecurityCode('600519.SH')).toBe('SH600519');
    expect(popularitySecurityCode('000001.SZ')).toBe('SZ000001');
    expect(popularitySecurityCode('920001.BJ')).toBe('BJ920001');
    expect(popularitySecurityCode('600519')).toBe('600519');
    expect(forumPopularityUrl()).toContain('stockrank/getCurrentLatest');
    expect(forumHotListUrl()).toContain('stockrank/getAllCurrentList');
  });
});

describe('parseGubaArticleList', () => {
  it('maps real field names, keeps +08:00 publish time, drops rows without time', () => {
    const posts = parseGubaArticleList(articleList, '600519');
    expect(posts).toHaveLength(3);
    expect(posts[0]).toMatchObject({
      postId: '1802076882',
      title: '今天帐户波动估计是近年最小',
      author: '嘉华睿投',
      postType: 'user',
      clicks: 1,
      replies: 0,
      likes: 2,
      url: 'https://guba.eastmoney.com/news,600519,1802076882.html',
    });
    expect(posts[0]?.publishedAt.toISOString()).toBe('2026-11-26T07:38:26.000Z');
    expect(posts[1]?.postType).toBe('news');
    expect(posts[2]?.postType).toBe('media');
    expect(posts[2]?.likes).toBeUndefined();
  });

  it('extracts the embedded JSON without being fooled by a closing brace in text', () => {
    const tricky = articleList.re.map((row) => ({
      ...row,
      post_content: row.post_content === undefined ? undefined : '};var article_list={"re":[]}',
    }));
    const payload = extractArticleListJson(html({ re: tricky, count: 1 }));
    expect(parseGubaArticleList(payload, '600519')).toHaveLength(3);
  });

  it('rejects html without the embedded dataset', () => {
    expect(() => extractArticleListJson('<html></html>')).toThrow(/article_list/);
  });
});

describe('parseForumPopularity', () => {
  it('reads rank, upstream rank change, market size and calc time', () => {
    const parsed = parseForumPopularity({
      globalId: 'g',
      message: 'OK',
      status: 0,
      code: 0,
      data: {
        marketType: '000001',
        marketAllCount: 5581,
        calcTime: '2026-11-26 15:46:00',
        srcSecurityCode: 'SH600519',
        rank: 88,
        rankChange: 0,
        hisRankChange: -46,
      },
    });
    expect(parsed).toEqual({
      rank: 88,
      rankChange: -46,
      marketStockCount: 5581,
      calcTime: new Date('2026-11-26T07:46:00.000Z'),
    });
  });

  it('returns null for upstream errors or missing rank', () => {
    expect(parseForumPopularity({ status: 1, data: null })).toBeNull();
    expect(parseForumPopularity({ status: 0, data: { rank: 0 } })).toBeNull();
    expect(parseForumPopularity({})).toBeNull();
  });
});

describe('parseForumHotList', () => {
  it('sorts by rank and keeps ranking change', () => {
    const rows = parseForumHotList({
      status: 0,
      data: [
        { sc: 'SZ002148', rk: 2, hisRc: 35 },
        { sc: 'SZ002242', rk: 1, hisRc: 0 },
        { sc: '', rk: 3 },
      ],
    });
    expect(rows).toEqual([
      { code: 'SZ002242', rank: 1, rankChange: 0 },
      { code: 'SZ002148', rank: 2, rankChange: 35 },
    ]);
  });

  it('throws explicit upstream errors', () => {
    expect(() => parseForumHotList({ status: 5, message: 'boom' })).toThrow(/人气榜上游错误/);
  });
});

describe('EastmoneySource forum endpoints', () => {
  const stubFetch = (handler: (url: string, init?: RequestInit) => Promise<Response>) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      return handler(String(url), init);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  };

  it('collects posts from successive pages and records warnings for later page failures', async () => {
    const { fetchImpl, calls } = stubFetch((url) =>
      url.includes('f_2')
        ? Promise.resolve(new Response('boom', { status: 500 }))
        : Promise.resolve(new Response(html(articleList), { status: 200 })),
    );
    const source = new EastmoneySource({
      fetchImpl,
      clock: () => new Date('2026-11-26T15:40:00+08:00'),
    });
    const result = await source.fetchForumPosts({ code: '600519', pages: 3 });
    expect(calls.map((call) => call.url)).toEqual([
      'https://guba.eastmoney.com/list,600519.html',
      'https://guba.eastmoney.com/list,600519,f_2.html',
    ]);
    expect(result.pagesFetched).toBe(1);
    expect(result.posts).toHaveLength(3);
    expect(result.warnings.join()).toContain('第 2 页失败');
    expect(result.fetchedAt.toISOString()).toBe('2026-11-26T07:40:00.000Z');
  });

  it('posts JSON for popularity endpoints', async () => {
    const { fetchImpl, calls } = stubFetch((url) =>
      url.includes('getCurrentLatest')
        ? Promise.resolve(
            new Response(JSON.stringify({ status: 0, data: { rank: 12, marketAllCount: 5581 } })),
          )
        : Promise.resolve(
            new Response(JSON.stringify({ status: 0, data: [{ sc: 'SH600519', rk: 1 }] })),
          ),
    );
    const source = new EastmoneySource({
      fetchImpl,
      clock: () => new Date('2026-11-26T15:40:00+08:00'),
    });
    const popularity = await source.fetchForumPopularity('600519.SH');
    expect(popularity).toMatchObject({ code: '600519.SH', rank: 12, marketStockCount: 5581 });
    const hot = await source.fetchForumHotList(5);
    expect(hot.rows).toEqual([{ code: 'SH600519', rank: 1 }]);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      srcSecurityCode: 'SH600519',
    });
  });
});
