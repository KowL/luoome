import { CorporateActionEventRevisionSchema } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { FuyaoClient } from '../fuyao/client.js';
import fixture000001Window from '../fuyao/fixtures/corporate-actions.000001.window.json';
import fixture600030Rights from '../fuyao/fixtures/corporate-actions.600030.rights-window.json';
import fixture600519Sample from '../fuyao/fixtures/corporate-actions.600519.sample.json';
import { FuyaoCorporateActionAdapter } from './fuyao.js';

/**
 * 公司行动在线 adapter 测试（Phase 0 证据 §3/§4 三种真实样本 + 3002 空窗口）。
 * 夹具为脱敏真实响应；断言覆盖零值行保留、区间映射、配股字段不发明。
 */

const envelope = (data: unknown) =>
  JSON.stringify({ code: 0, message: 'success', request_id: '0'.repeat(32), data });

const errorEnvelope = (code: number, message: string) =>
  JSON.stringify({ code, message, request_id: '0'.repeat(32), data: null });

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

const RECORDED_AT = new Date('2026-11-04T05:00:00.000Z');

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

const mkAdapter = (client: FuyaoClient): FuyaoCorporateActionAdapter =>
  new FuyaoCorporateActionAdapter(client, { clock: () => RECORDED_AT });

describe('FuyaoCorporateActionAdapter.fetchEvents', () => {
  it('解析 600519.SH 全历史样本：现金分红事件齐全、按 exDate 升序、字段映射正确', async () => {
    const { client, urls } = mkClient([envelope(fixture600519Sample.data)]);
    const adapter = mkAdapter(client);

    const result = await adapter.fetchEvents({ stockId: '600519.SH' });

    expect(urls[0]).toContain('/api/a-share/corporate-actions/adjustment-factors');
    expect(urls[0]).toContain('thscode=600519.SH');
    // 无窗口查询不传 from/to
    expect(urls[0]).not.toContain('from=');
    expect(urls[0]).not.toContain('to=');

    expect(result.stockId).toBe('600519.SH');
    expect(result.events).toHaveLength(3);
    // 上游降序 → 输出升序
    expect(result.events.map((event) => event.exDate.toISOString())).toEqual([
      '2025-06-26T00:00:00.000Z',
      '2025-12-19T00:00:00.000Z',
      '2026-06-26T00:00:00.000Z',
    ]);
    const latest = result.events[2];
    expect(latest?.dividendPerShare).toBe(28.02423);
    expect(latest?.perShareBonus).toBe(0);
    // 在线端点不返回配股字段：恒 null，不发明
    expect(latest?.allotmentRatio).toBeNull();
    expect(latest?.allotmentPrice).toBeNull();
    // 在线补取无内容寻址
    expect(latest?.dumpId).toBeNull();
    expect(latest?.artifactSha256).toBeNull();
    expect(latest?.currency).toBe('CNY');
    expect(latest?.source).toBe('fuyao');
    expect(latest?.recordedAt).toEqual(RECORDED_AT);
    // 全部事件通过 core schema 不变量
    for (const event of result.events) {
      expect(() => CorporateActionEventRevisionSchema.parse(event)).not.toThrow();
    }
  });

  it('区间查询映射 from/to 为上海日历日 YYYY-MM-DD（000001.SZ 窗口样本）', async () => {
    const { client, urls } = mkClient([envelope(fixture000001Window.data)]);
    const adapter = mkAdapter(client);

    const result = await adapter.fetchEvents({
      stockId: '000001.SZ',
      from: new Date('2024-01-01T00:00:00.000Z'),
      to: new Date('2025-12-31T00:00:00.000Z'),
    });

    expect(urls[0]).toContain('from=2024-01-01');
    expect(urls[0]).toContain('to=2025-12-31');
    expect(result.events).toHaveLength(3);
    expect(result.events.map((event) => event.dividendPerShare)).toEqual([0.246, 0.362, 0.236]);
  });

  it('保留零分红零送股行（600030.SH 配股除权窗口实测），不当噪声丢弃', async () => {
    const { client } = mkClient([envelope(fixture600030Rights.data)]);
    const adapter = mkAdapter(client);

    const result = await adapter.fetchEvents({
      stockId: '600030.SH',
      from: new Date('2022-01-01T00:00:00.000Z'),
      to: new Date('2022-02-01T00:00:00.000Z'),
    });

    expect(result.events).toHaveLength(1);
    const event = result.events[0];
    expect(event?.dividendPerShare).toBe(0);
    expect(event?.perShareBonus).toBe(0);
    // 零值行可能对应配股除权日：在线响应丢失全部配股参数，仍恒 null
    expect(event?.allotmentRatio).toBeNull();
    expect(event?.allotmentPrice).toBeNull();
    expect(event?.exDate.toISOString()).toBe('2022-01-27T00:00:00.000Z');
    expect(() => CorporateActionEventRevisionSchema.parse(event)).not.toThrow();
  });

  it('code=3002（无事件窗口）返回空 events，不抛错', async () => {
    const { client } = mkClient([errorEnvelope(3002, 'no data')]);
    const adapter = mkAdapter(client);

    const result = await adapter.fetchEvents({
      stockId: '000725.SZ',
      from: new Date('2009-01-01T00:00:00.000Z'),
      to: new Date('2010-12-31T00:00:00.000Z'),
    });

    expect(result.stockId).toBe('000725.SZ');
    expect(result.events).toEqual([]);
  });

  it('上游即使多给 allotment 字段也不解析（不发明配股覆盖）', async () => {
    const data = {
      thscode: '600030.SH',
      ticker: '600030',
      item: [
        {
          ticker: '600030',
          ex_date_ms: 1643212800000,
          dividend_per_share: 0,
          per_share_bonus: 0,
          allotment_ratio: 0.15,
          allotment_price: 16.62,
        },
      ],
    };
    const { client } = mkClient([envelope(data)]);
    const adapter = mkAdapter(client);

    const result = await adapter.fetchEvents({ stockId: '600030.SH' });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.allotmentRatio).toBeNull();
    expect(result.events[0]?.allotmentPrice).toBeNull();
  });

  it('纯重复行按内容去重；同日不同内容分别保留；sourceRecordId/contentHash 稳定', async () => {
    const row = {
      ticker: '600519',
      ex_date_ms: 1782403200000,
      dividend_per_share: 28.02423,
      per_share_bonus: 0,
    };
    const data = {
      thscode: '600519.SH',
      ticker: '600519',
      item: [row, { ...row }, { ...row, dividend_per_share: 1.5 }],
    };
    const { client } = mkClient([envelope(data)]);
    const adapter = mkAdapter(client);

    const first = await adapter.fetchEvents({ stockId: '600519.SH' });
    // 3 行 → 2 事件（纯重复行去重，同日不同现金事件保留）
    expect(first.events).toHaveLength(2);
    expect(first.events[0]?.sourceRecordId).not.toBe(first.events[1]?.sourceRecordId);
    expect(first.events[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.events[0]?.sourceRecordId).toContain('fuyao:600519.SH:1782432000000:');

    const second = await mkAdapter(mkClient([envelope(data)]).client).fetchEvents({
      stockId: '600519.SH',
    });
    expect(second.events.map((event) => event.sourceRecordId)).toEqual(
      first.events.map((event) => event.sourceRecordId),
    );
    expect(second.events.map((event) => event.contentHash)).toEqual(
      first.events.map((event) => event.contentHash),
    );
  });

  it('data 形状漂移 → invalid_payload', async () => {
    const { client } = mkClient([envelope({ thscode: '600519.SH', item: [{ ticker: 1 }] })]);
    const adapter = mkAdapter(client);

    await expect(adapter.fetchEvents({ stockId: '600519.SH' })).rejects.toMatchObject({
      kind: 'invalid_payload',
    });
  });

  it('非沪深代码 → unsupported_market（请求前拦截）', async () => {
    const { client, urls } = mkClient([envelope(fixture600519Sample.data)]);
    const adapter = mkAdapter(client);

    await expect(adapter.fetchEvents({ stockId: '830799.BJ' })).rejects.toMatchObject({
      kind: 'unsupported_market',
    });
    expect(urls).toHaveLength(0);
  });

  it('权限错误（2003）原样抛出，不当空窗口吞掉', async () => {
    const { client } = mkClient([errorEnvelope(2003, 'forbidden')]);
    const adapter = mkAdapter(client);

    await expect(adapter.fetchEvents({ stockId: '600519.SH' })).rejects.toMatchObject({
      kind: 'permission',
    });
  });
});
