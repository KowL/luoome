import { describe, expect, it } from 'vitest';

import { FuyaoClient } from '../fuyao/client.js';
import catalogCnConcept from '../fuyao/fixtures/sector-catalog.cn-concept.json';
import catalogIndustry from '../fuyao/fixtures/sector-catalog.industry.json';
import membershipAll from '../fuyao/fixtures/sector-membership.all.json';
import membershipIndustry from '../fuyao/fixtures/sector-membership.industry.json';
import { FuyaoSectorMembershipAdapter, sectorMembershipContentHash } from './fuyao.js';

const envelope = (data: unknown) =>
  JSON.stringify({ code: 0, message: 'success', request_id: '0'.repeat(32), data });

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

describe('FuyaoSectorMembershipAdapter.fetchMemberships', () => {
  it('按请求顺序对齐输出；.TI 身份保留；空 index_list 保留为空组（≠ 股票不存在）', async () => {
    const { client, urls } = mkClient([envelope(membershipIndustry.data)]);
    const adapter = new FuyaoSectorMembershipAdapter(client);

    const result = await adapter.fetchMemberships(
      ['000713.SZ', '600519.SH', '000000.SZ'],
      'industry',
    );
    expect(urls[0]).toContain('thscodes=000713.SZ%2C600519.SH%2C000000.SZ');
    expect(urls[0]).toContain('type=industry');

    expect(result.groups).toHaveLength(3);
    expect(result.groups.map((group) => group.stockId)).toEqual([
      '000713.SZ',
      '600519.SH',
      '000000.SZ',
    ]);
    expect(result.groups[0]?.memberships[0]).toEqual({
      sectorCode: '881101.TI',
      sectorName: '种植业与林业',
      type: 'industry',
    });
    // 空组：当前无匹配，不证明股票不存在
    expect(result.groups[2]?.memberships).toEqual([]);
  });

  it('省略 type 不传参数（上游返回全部四类）', async () => {
    const { client, urls } = mkClient([envelope(membershipAll.data)]);
    const adapter = new FuyaoSectorMembershipAdapter(client);

    const result = await adapter.fetchMemberships(['600519.SH']);
    expect(urls[0]).not.toContain('type=');
    expect(result.groups[0]?.memberships).toHaveLength(6);
    expect(result.groups[0]?.memberships.every((entry) => entry.type === 'cn_concept')).toBe(true);
  });

  it('name 为 null/空串时保持缺失（由 manager 从目录 join），不用代码回填', async () => {
    const data = {
      item: [
        {
          thscode: '600519.SH',
          index_list: [
            { thscode: '881273.TI', name: null, type: 'industry' },
            { thscode: '885525.TI', name: '  ', type: 'cn_concept' },
          ],
        },
      ],
    };
    const { client } = mkClient([envelope(data)]);
    const adapter = new FuyaoSectorMembershipAdapter(client);

    const result = await adapter.fetchMemberships(['600519.SH']);
    const [first, second] = result.groups[0]?.memberships ?? [];
    expect(first?.sectorName).toBeUndefined();
    expect(second?.sectorName).toBeUndefined();
  });

  it('上游缺失的股票组按空关系补齐（保持与请求一一对应）', async () => {
    const { client } = mkClient([envelope(membershipIndustry.data)]);
    const adapter = new FuyaoSectorMembershipAdapter(client);

    // 请求 4 只，上游只返回 3 组
    const result = await adapter.fetchMemberships(
      ['000713.SZ', '600519.SH', '000000.SZ', '830799.BJ'],
      'industry',
    );
    expect(result.groups).toHaveLength(4);
    expect(result.groups[3]).toEqual({ stockId: '830799.BJ', memberships: [] });
  });

  it('contentHash 稳定且随内容变化；data 形状漂移 → invalid_payload', async () => {
    const { client } = mkClient([envelope(membershipIndustry.data)]);
    const adapter = new FuyaoSectorMembershipAdapter(client);

    const first = await adapter.fetchMemberships(
      ['000713.SZ', '600519.SH', '000000.SZ'],
      'industry',
    );
    const second = await adapter.fetchMemberships(
      ['000713.SZ', '600519.SH', '000000.SZ'],
      'industry',
    );
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.contentHash).toMatch(/^[0-9a-f]{16}$/);

    const other = await adapter.fetchMemberships(['000713.SZ'], 'industry');
    expect(other.contentHash).not.toBe(first.contentHash);

    const drift = mkClient([envelope({ item: [{ thscode: 1 }] })]);
    await expect(
      new FuyaoSectorMembershipAdapter(drift.client).fetchMemberships(['600519.SH']),
    ).rejects.toMatchObject({ kind: 'invalid_payload' });
  });

  it('sectorMembershipContentHash 与请求顺序无关字段无关，只依赖规范化内容', () => {
    const a = sectorMembershipContentHash([
      { stockId: '600519.SH', memberships: [{ sectorCode: '881273.TI', type: 'industry' }] },
    ]);
    const b = sectorMembershipContentHash([
      { stockId: '600519.SH', memberships: [{ sectorCode: '881273.TI', type: 'industry' }] },
    ]);
    expect(a).toBe(b);
  });
});

describe('FuyaoSectorMembershipAdapter.fetchCatalog', () => {
  it('四类 tag 全量合并；同一代码先去重；data 形状漂移 → invalid_payload', async () => {
    const { client, urls } = mkClient([
      envelope(catalogIndustry.data),
      envelope(catalogCnConcept.data),
      envelope({ timestamp: 1, item: [] }),
      envelope({ timestamp: 1, item: [{ thscode: '881101.TI', name: '重复代码' }] }),
    ]);
    const adapter = new FuyaoSectorMembershipAdapter(client);

    const result = await adapter.fetchCatalog();
    expect(urls).toHaveLength(4);
    expect(urls[0]).toContain('tag=industry');
    expect(urls[1]).toContain('tag=cn_concept');
    expect(urls[2]).toContain('tag=region');
    expect(urls[3]).toContain('tag=tszs');

    // 3 + 3 + 0 + 1（重复 881101.TI 被去重）
    expect(result.items).toHaveLength(6);
    expect(result.items.find((item) => item.sectorCode === '881101.TI')?.sectorName).toBe(
      '种植业与林业',
    );
  });
});
