import { describe, expect, it } from 'vitest';

import { EastmoneySource } from '../eastmoney/source.js';

/**
 * EastmoneySource.fetchNews 委托测试（getNewsByColumns）。
 * 解析断言保留自原 EastmoneyNewsAdapter 测试；传输错误收敛为 SourceExecutionError。
 * 全程 fetchImpl stub，不依赖网络。
 */

const NEWS_FIXTURE = {
  req_trace: '1787367000000',
  code: '1',
  message: 'success',
  data: {
    page_index: 1,
    list: [
      {
        code: '202608223849885155',
        title: '央行宣布降准释放流动性',
        summary: '中国人民银行宣布下调存款准备金率……',
        showTime: '2026-08-22 10:12:00',
        uniqueUrl: 'http://finance.eastmoney.com/a/202608223849885155.html',
        url: 'http://finance.eastmoney.com/news/1350,202608223849885155.html',
        mediaName: '人民日报',
      },
      {
        code: '202608223850097866',
        title: 'A股三大指数集体收涨',
        summary: '',
        showTime: '2026-08-22 09:30:00',
        url: 'https://finance.eastmoney.com/news/1350,202608223850097866.html',
      },
    ],
    page_size: 2,
  },
};

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

describe('EastmoneySource.fetchNews', () => {
  it('字段映射：id=code、showTime 按 +08:00 解析、uniqueUrl 优先且 http→https、summary 空串缺省', async () => {
    const { fetchImpl, urls } = stubFetch(() => okJson(NEWS_FIXTURE));
    const source = new EastmoneySource({ fetchImpl, now: () => 1787367000000 });
    const result = await source.fetchNews(1, 30);

    expect(urls[0]).toContain('getNewsByColumns');
    expect(urls[0]).toContain('column=350');
    expect(urls[0]).toContain('page_index=1');
    expect(urls[0]).toContain('page_size=30');
    expect(urls[0]).toContain('req_trace=1787367000000');

    expect(result.items).toHaveLength(2);
    const first = result.items[0];
    expect(first?.id).toBe('202608223849885155');
    expect(first?.title).toBe('央行宣布降准释放流动性');
    expect(first?.summary).toContain('中国人民银行');
    expect(first?.source).toBe('人民日报');
    expect(first?.published_at).toBe('2026-08-22T10:12:00+08:00');
    expect(first?.url).toBe('https://finance.eastmoney.com/a/202608223849885155.html');

    const second = result.items[1];
    expect(second?.summary).toBeUndefined(); // 空串缺省，manager 回退 title
    expect(second?.url).toBe('https://finance.eastmoney.com/news/1350,202608223850097866.html');
  });

  it('非法条目（缺标题 / showTime 格式非法）被剔除；code 缺失时合成 id', async () => {
    const { fetchImpl } = stubFetch(() =>
      okJson({
        code: '1',
        data: {
          list: [
            { code: 'x1', showTime: '2026-08-22 10:00:00' },
            { code: 'x2', title: '有时间但格式错', showTime: '10:00:00' },
            { title: '无 code 条目', showTime: '2026-08-22 11:00:00' },
          ],
        },
      }),
    );
    const source = new EastmoneySource({ fetchImpl });
    const result = await source.fetchNews(1, 30);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toContain('2026-08-22T11:00:00+08:00');
  });

  it('上游业务错误（code != "1"）→ 抛 upstream_error；data=null → 空列表', async () => {
    const { fetchImpl: badCode } = stubFetch(() =>
      okJson({ code: '0', message: 'Required String parameter req_trace is not present' }),
    );
    const badSource = new EastmoneySource({ fetchImpl: badCode });
    await expect(badSource.fetchNews(1, 30)).rejects.toMatchObject({ kind: 'upstream_error' });
    await expect(badSource.fetchNews(1, 30)).rejects.toThrow(/上游错误/);

    const { fetchImpl: empty } = stubFetch(() => okJson({ code: '1', data: null }));
    const result = await new EastmoneySource({ fetchImpl: empty }).fetchNews(1, 30);
    expect(result.items).toEqual([]);
  });

  it('HTTP 非 2xx / 网络错误 / 非 JSON → 结构化 SourceExecutionError', async () => {
    const http502 = new EastmoneySource({
      fetchImpl: (() => Promise.resolve(new Response('boom', { status: 502 }))) as never,
    });
    await expect(http502.fetchNews(1, 30)).rejects.toMatchObject({ kind: 'upstream_error' });

    const netErr = new EastmoneySource({
      fetchImpl: (() => Promise.reject(new TypeError('socket hang up'))) as never,
    });
    await expect(netErr.fetchNews(1, 30)).rejects.toMatchObject({ kind: 'network' });

    const badJson = new EastmoneySource({
      fetchImpl: (() => Promise.resolve(new Response('not-json', { status: 200 }))) as never,
    });
    await expect(badJson.fetchNews(1, 30)).rejects.toMatchObject({ kind: 'invalid_payload' });
  });
});
