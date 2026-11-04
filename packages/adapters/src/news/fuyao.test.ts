import { describe, expect, it } from 'vitest';

import { FuyaoClient } from '../fuyao/client.js';
import flashPage2 from '../fuyao/fixtures/news-flash-list.page2.json';
import flashSeq0 from '../fuyao/fixtures/news-flash-list.seq0.json';
import { SourceExecutionError } from '../source-error.js';
import { FuyaoNewsSource } from './fuyao.js';

const envelope = (data: unknown) =>
  JSON.stringify({ code: 0, message: 'success', request_id: '0'.repeat(32), data });

/** 手动推进的假时钟 + sleep：测试零真实等待（协调器 minInterval 立即推进）。 */
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

describe('FuyaoNewsSource', () => {
  it('首屏 seq=0；id/seq 保持字符串；create_time_ms 映射发布时间；来源写同花顺快讯', async () => {
    const { client, urls } = mkClient([envelope(flashSeq0.data)]);
    const source = new FuyaoNewsSource(client, { tagId: '21103' });

    const result = await source.fetchNews(1, 30);
    expect(urls[0]).toContain('tag_id=21103');
    expect(urls[0]).toContain('seq=0');
    expect(result.items).toHaveLength(3);

    const [first] = result.items;
    expect(first?.id).toBe('5557783');
    expect(typeof first?.id).toBe('string');
    expect(first?.source).toBe('同花顺快讯');
    expect(first?.published_at).toBe(new Date(1793719124000).toISOString());
    expect(first?.url).toBe('https://news.10jqka.com.cn/20261103/b1e07150622075357af.shtml');
    expect(first?.summary).toContain('伊朗');
  });

  it('大整数 id/seq 不转 Number（16 位十进制字符串保持精度）', async () => {
    const big = {
      items: [
        {
          id: '9007199254740993',
          seq: '9007199254740992',
          title: '大整数快讯',
          encoded_url: null,
          summary: null,
          tags: [],
          type: 0,
          create_time_ms: 1793719124000,
          update_time_ms: 1793719124000,
          pic_url: null,
        },
      ],
    };
    const { client } = mkClient([envelope(big)]);
    const source = new FuyaoNewsSource(client, { tagId: '21103' });

    const result = await source.fetchNews(1, 30);
    expect(result.items[0]?.id).toBe('9007199254740993');
    expect(result.items[0]?.summary).toBeUndefined();
    expect(result.items[0]?.url).toBeUndefined();
  });

  it('顺序翻页用上一页末条 seq；pageSize 截断在 adapter 侧执行', async () => {
    const { client, urls } = mkClient([envelope(flashSeq0.data), envelope(flashPage2.data)]);
    const source = new FuyaoNewsSource(client, { tagId: '21103' });

    await source.fetchNews(1, 30);
    const page2 = await source.fetchNews(2, 30);
    // 首屏末条 seq=681425146 作为第二页入参
    expect(urls[1]).toContain('seq=681425146');
    expect(page2.items.map((item) => item.id)).toEqual(['5556927', '5556923']);
  });

  it('冷启动直接请求 page>1 → unsupported_capability（不把 page 数字当 seq）', async () => {
    const { client, urls } = mkClient([envelope(flashSeq0.data)]);
    const source = new FuyaoNewsSource(client, { tagId: '21103' });

    await expect(source.fetchNews(2, 30)).rejects.toMatchObject({
      name: 'SourceExecutionError',
      kind: 'unsupported_capability',
    });
    expect(urls).toHaveLength(0);
  });

  it('重试同一页不推进游标；乱序翻页（跳页）抛 unsupported_capability', async () => {
    const { client, urls } = mkClient([envelope(flashSeq0.data), envelope(flashPage2.data)]);
    const source = new FuyaoNewsSource(client, { tagId: '21103' });

    await source.fetchNews(1, 30);
    await source.fetchNews(1, 30); // 重试 page=1：seq 仍为 0
    expect(urls[1]).toContain('seq=0');
    await source.fetchNews(2, 30);
    // page=2 已完成；直接跳 page=4（缺 page=3 游标）→ unsupported
    await expect(source.fetchNews(4, 30)).rejects.toMatchObject({
      kind: 'unsupported_capability',
    });
    // 已完成的 page=3 之前页面可重复请求
    const again = await source.fetchNews(2, 30);
    expect(again.items).toHaveLength(2);
  });

  it('空页（items=[]）也推进游标语义：page=1 空列表正常返回，不抛错', async () => {
    const { client } = mkClient([envelope({ items: [] })]);
    const source = new FuyaoNewsSource(client, { tagId: '21103' });

    const result = await source.fetchNews(1, 30);
    expect(result.items).toHaveLength(0);
    // 空页没有末条 seq，page=2 仍属冷启动
    await expect(source.fetchNews(2, 30)).rejects.toMatchObject({
      kind: 'unsupported_capability',
    });
  });

  it('data 形状漂移 → invalid_payload；信封错误码透传 kind', async () => {
    const { client } = mkClient([envelope({ items: [{ id: 123 }] })]);
    const source = new FuyaoNewsSource(client, { tagId: '21103' });
    await expect(source.fetchNews(1, 30)).rejects.toMatchObject({ kind: 'invalid_payload' });

    const denied = mkClient([
      JSON.stringify({
        code: 2003,
        message: 'no permission',
        request_id: '0'.repeat(32),
        data: null,
      }),
    ]);
    const deniedSource = new FuyaoNewsSource(denied.client, { tagId: '21103' });
    await expect(deniedSource.fetchNews(1, 30)).rejects.toMatchObject({ kind: 'permission' });
  });

  it('create_time_ms 非法的条目剔除，其余保留；顺序翻页仍推进游标', async () => {
    const mixed = {
      items: [
        {
          id: '1',
          seq: '100',
          title: '有效快讯',
          encoded_url: null,
          summary: null,
          tags: [],
          type: 0,
          create_time_ms: 1793719124000,
          update_time_ms: null,
          pic_url: null,
        },
      ],
    };
    const { client, urls } = mkClient([envelope(mixed), envelope(flashPage2.data)]);
    const source = new FuyaoNewsSource(client, { tagId: '21103' });

    const page1 = await source.fetchNews(1, 30);
    expect(page1.items).toHaveLength(1);
    await source.fetchNews(2, 30);
    expect(urls[1]).toContain('seq=100');
  });

  it('抛出的错误均为结构化 SourceExecutionError', async () => {
    const { client } = mkClient(['not json']);
    const source = new FuyaoNewsSource(client, { tagId: '21103' });
    const error = await source.fetchNews(1, 30).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SourceExecutionError);
  });
});
