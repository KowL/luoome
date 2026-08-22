import type { Logger } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { NewsManager } from './manager.js';
import type { NewsCapabilityMap, NewsFetchResult } from './types.js';

/**
 * NewsManager 集成测试：fake binding 注入 registry，
 * 验证降级顺序、实际 source provenance、status() 输出与 §6.2 dataAsOf 口径。
 */

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const CLOCK = () => new Date('2026-08-22T02:30:00.000Z');

const fetchResult = (): NewsFetchResult => ({
  items: [
    {
      id: 'n1',
      title: '央行宣布降准释放流动性',
      summary: '中国人民银行宣布……',
      published_at: '2026-08-22T10:12:00+08:00',
    },
    {
      id: 'n2',
      title: 'A股三大指数集体收涨',
      published_at: '2026-08-22T09:00:00+08:00',
    },
  ],
});

/** 生产 binding 的观测口径（§6.2）：dataAsOf = 最大 published_at；空列表 success 无 dataAsOf。 */
const mkBinding = (
  name: string,
  impl: (pageSize: number) => Promise<NewsFetchResult>,
): AnyBinding<NewsCapabilityMap> => ({
  capability: 'finance-news',
  source: name,
  coverage: ['CN_FINANCE_NEWS'],
  configurationReady: true,
  execute: ({ pageSize }) => impl(pageSize),
  observationOf: (result) => {
    let latest: Date | undefined;
    for (const item of result.items) {
      const publishedAt = new Date(item.published_at);
      if (Number.isNaN(publishedAt.getTime())) continue;
      if (latest === undefined || publishedAt > latest) latest = publishedAt;
    }
    return latest === undefined ? { outcome: 'success' } : { outcome: 'success', dataAsOf: latest };
  },
});

const mkManager = (
  fetches: readonly (readonly [string, (pageSize: number) => Promise<NewsFetchResult>])[],
) =>
  new NewsManager({
    registry: new SourceRegistry<NewsCapabilityMap>(
      fetches.map(([name, impl]) => mkBinding(name, impl)),
      CLOCK,
    ),
    logger: noopLogger,
    clock: CLOCK,
  });

describe('NewsManager（registry 集成）', () => {
  it('唯一源成功：provenance 记录实际 source；dataAsOf 为最大 published_at', async () => {
    const m = mkManager([['eastmoney', async () => fetchResult()]]);
    const r = await m.fetchNews({ limit: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe('eastmoney');
    expect(r.data.total).toBe(2);

    const status = m.status()[0];
    expect(status?.dataset).toBe('finance-news');
    expect(status?.coverage).toEqual(['CN_FINANCE_NEWS']);
    expect(status?.dataAsOf).toEqual(new Date('2026-08-22T10:12:00+08:00'));
  });

  it('空列表 success 但无 dataAsOf（freshness unknown）', async () => {
    const m = mkManager([['eastmoney', async () => ({ items: [] })]]);
    const r = await m.fetchNews({ limit: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.warnings).toContain('empty-list');

    const status = m.status()[0];
    expect(status?.lastSuccessAt).toBeDefined();
    expect(status?.dataAsOf).toBeUndefined();
  });

  it('主源失败 → fallback 成功：按绑定顺序降级，provenance 为 fallback 源', async () => {
    const fallbackMock = vi.fn(async () => fetchResult());
    const m = mkManager([
      [
        'eastmoney',
        async () => {
          throw new Error('eastmoney down');
        },
      ],
      ['fuyao', fallbackMock],
    ]);
    const r = await m.fetchNews({ limit: 30 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.source).toBe('fuyao');
    expect(m.status().find((s) => s.source === 'eastmoney')?.lastErrorKind).toBe('upstream_error');
  });

  it('全部失败 → adapter_error；显式 query.source 未启用 → adapter_error', async () => {
    const m = mkManager([
      [
        'eastmoney',
        async () => {
          throw new Error('eastmoney down');
        },
      ],
    ]);
    const failed = await m.fetchNews({ limit: 30 });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.kind).toBe('adapter_error');
      expect(failed.error.message).toContain('eastmoney down');
    }

    const disabled = await m.fetchNews({ limit: 30, source: 'tushare' });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.kind).toBe('adapter_error');
  });
});
