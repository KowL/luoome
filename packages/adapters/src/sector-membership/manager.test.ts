import type { GetStockSectorMembershipsQuery } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { SectorMembershipManager } from './manager.js';
import type { SectorMembershipCapabilityMap, SectorMembershipFetchResult } from './types.js';

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const clock = () => new Date('2026-11-04T01:00:00.000Z');

const mkMembershipResult = (
  groups: SectorMembershipFetchResult['groups'],
): SectorMembershipFetchResult => ({ groups, contentHash: 'raw-hash' });

const mkBinding = (
  source: string,
  execute: () => Promise<SectorMembershipFetchResult>,
  catalog?: () => Promise<{ items: { sectorCode: string; sectorName: string }[] }>,
): AnyBinding<SectorMembershipCapabilityMap>[] => [
  {
    capability: 'sector-membership',
    source,
    coverage: ['CN_SECTOR_MEMBERSHIP'],
    configurationReady: true,
    execute,
    observationOf: () => ({ outcome: 'success' }),
  },
  ...(catalog === undefined
    ? []
    : [
        {
          capability: 'sector-catalog' as const,
          source,
          coverage: ['CN_SECTOR_MEMBERSHIP'],
          configurationReady: true,
          execute: catalog,
          observationOf: () => ({ outcome: 'success' as const }),
        },
      ]),
];

const mkManager = (bindings: readonly AnyBinding<SectorMembershipCapabilityMap>[]) =>
  new SectorMembershipManager({
    registry: new SourceRegistry<SectorMembershipCapabilityMap>(bindings, clock),
    logger: noopLogger,
    clock,
  });

const query = (
  over: Partial<GetStockSectorMembershipsQuery> = {},
): GetStockSectorMembershipsQuery => ({
  stockIds: ['600519.SH'],
  ...over,
});

describe('SectorMembershipManager', () => {
  it('快照带 fetchedAt（本地时钟）/source/contentHash；items 与请求一一对应', async () => {
    const manager = mkManager(
      mkBinding('fuyao', () =>
        Promise.resolve(
          mkMembershipResult([
            {
              stockId: '600519.SH',
              memberships: [{ sectorCode: '881273.TI', sectorName: '白酒', type: 'industry' }],
            },
          ]),
        ),
      ),
    );

    const result = await manager.fetchMemberships(query());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.source).toBe('fuyao');
    expect(result.data.fetchedAt).toEqual(new Date('2026-11-04T01:00:00.000Z'));
    expect(result.data.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.data.total).toBe(1);
    expect(result.data.items[0]?.memberships[0]?.sectorCode).toBe('881273.TI');
  });

  it('缺名归属从板块目录 join；目录缺失保持缺失并记 sector-name-unavailable 警告', async () => {
    const joined = mkManager(
      mkBinding(
        'fuyao',
        () =>
          Promise.resolve(
            mkMembershipResult([
              {
                stockId: '600519.SH',
                memberships: [
                  { sectorCode: '881273.TI', type: 'industry' },
                  { sectorCode: '885525.TI', type: 'cn_concept' },
                ],
              },
            ]),
          ),
        () =>
          Promise.resolve({
            items: [{ sectorCode: '881273.TI', sectorName: '白酒' }],
          }),
      ),
    );
    const result = await joined.fetchMemberships(query());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = result.data.items[0]?.memberships ?? [];
    // 目录有的 join 上；目录也没有的保持缺失（不用代码回填）
    expect(first?.sectorName).toBe('白酒');
    expect(second?.sectorName).toBeUndefined();
    expect(result.data.warnings).toEqual([]);

    // 目录 capability 失败 → 降级为空映射 + 警告，归属关系本身仍可用
    const catalogDown = mkManager(
      mkBinding(
        'fuyao',
        () =>
          Promise.resolve(
            mkMembershipResult([
              {
                stockId: '600519.SH',
                memberships: [{ sectorCode: '881273.TI', type: 'industry' }],
              },
            ]),
          ),
        () => Promise.reject(new Error('catalog down')),
      ),
    );
    const degraded = await catalogDown.fetchMemberships(query());
    expect(degraded.ok).toBe(true);
    if (!degraded.ok) return;
    expect(degraded.data.items[0]?.memberships[0]?.sectorName).toBeUndefined();
    expect(degraded.data.warnings).toContain('sector-name-unavailable');
  });

  it('全部为空组 → warnings=[empty-list]；空组 ≠ 股票不存在', async () => {
    const manager = mkManager(
      mkBinding('fuyao', () =>
        Promise.resolve(
          mkMembershipResult([
            { stockId: '600519.SH', memberships: [] },
            { stockId: '830799.BJ', memberships: [] },
          ]),
        ),
      ),
    );
    const result = await manager.fetchMemberships(query({ stockIds: ['600519.SH', '830799.BJ'] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.warnings).toEqual(['empty-list']);
    expect(result.data.items).toHaveLength(2);
  });

  it('显式 source 路由；未启用返回 adapter_error；全部失败汇总', async () => {
    const manager = mkManager([
      ...mkBinding('fuyao', () => Promise.reject(new Error('fuyao down'))),
    ]);

    const disabled = await manager.fetchMemberships(query({ source: 'unknown' }));
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.kind).toBe('adapter_error');

    const failed = await manager.fetchMemberships(query());
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.message).toContain('fuyao down');
  });

  it('status() 输出两个 capability 的观测（sector-membership + sector-catalog）', async () => {
    const manager = mkManager(
      mkBinding(
        'fuyao',
        () => Promise.resolve(mkMembershipResult([{ stockId: '600519.SH', memberships: [] }])),
        () => Promise.resolve({ items: [] }),
      ),
    );
    await manager.fetchMemberships(query());

    const status = manager.status();
    expect(status.map((entry) => `${entry.source}:${entry.dataset}`)).toEqual([
      'fuyao:sector-membership',
      'fuyao:sector-catalog',
    ]);
    expect(status[0]?.lastSuccessAt).toBeDefined();
  });
});
