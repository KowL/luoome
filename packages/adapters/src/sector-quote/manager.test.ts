import type { FetchSectorQuotesQuery } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { type AnyBinding, SourceRegistry } from '../source-registry.js';
import { SectorQuoteManager } from './manager.js';
import type { SectorQuoteCapabilityMap, SectorQuoteRawItem } from './types.js';

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const clock = () => new Date('2026-11-04T01:00:00.000Z');

const mkItem = (code: string): SectorQuoteRawItem => ({
  code,
  name: `板块${code}`,
  price: 100,
  change_pct: 0.01,
  change: 1,
  amount: 1000,
});

const mkBinding = (
  source: string,
  execute: () => Promise<{ readonly items: SectorQuoteRawItem[] }>,
): AnyBinding<SectorQuoteCapabilityMap> => ({
  capability: 'sector-quote',
  source,
  coverage: ['CN_SECTOR_QUOTE'],
  configurationReady: true,
  execute,
  observationOf: () => ({ outcome: 'success' }),
});

const mkManager = (bindings: readonly AnyBinding<SectorQuoteCapabilityMap>[]) =>
  new SectorQuoteManager({
    registry: new SourceRegistry<SectorQuoteCapabilityMap>(bindings, clock),
    logger: noopLogger,
    clock,
  });

const query = (over: Partial<FetchSectorQuotesQuery> = {}): FetchSectorQuotesQuery => ({
  sort: 'changePct',
  limit: 50,
  ...over,
});

describe('SectorQuoteManager（registry 集成）', () => {
  it('按绑定顺序 fallback；输出 source 取实际成功 handle，不回显请求默认值', async () => {
    const manager = mkManager([
      mkBinding('eastmoney', () => Promise.reject(new Error('eastmoney down'))),
      mkBinding('fuyao', () => Promise.resolve({ items: [mkItem('881101.TI')] })),
    ]);

    const result = await manager.fetchList(query());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.source).toBe('fuyao');
    expect(result.data.items[0]?.code).toBe('881101.TI');
  });

  it('显式 query.source 只尝试该源；未启用返回 adapter_error', async () => {
    let eastmoneyCalls = 0;
    const manager = mkManager([
      mkBinding('eastmoney', () => {
        eastmoneyCalls += 1;
        return Promise.resolve({ items: [mkItem('BK0001')] });
      }),
      mkBinding('fuyao', () => Promise.resolve({ items: [mkItem('881101.TI')] })),
    ]);

    const explicit = await manager.fetchList(query({ source: 'fuyao' }));
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.data.items[0]?.code).toBe('881101.TI');
    expect(eastmoneyCalls).toBe(0);

    const disabled = await manager.fetchList(query({ source: 'unknown' }));
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.kind).toBe('adapter_error');
  });

  it('全部源失败 → adapter_error 汇总；空列表 → warnings=[empty-list]', async () => {
    const failing = mkManager([
      mkBinding('eastmoney', () => Promise.reject(new Error('eastmoney down'))),
      mkBinding('fuyao', () => Promise.reject(new Error('fuyao down'))),
    ]);
    const failed = await failing.fetchList(query());
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      // 与 NewsManager 一致：消息携带失败链与最后一个错误
      expect(failed.error.message).toContain('eastmoney → fuyao');
      expect(failed.error.message).toContain('fuyao down');
    }

    const empty = mkManager([mkBinding('eastmoney', () => Promise.resolve({ items: [] }))]);
    const result = await empty.fetchList(query());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.warnings).toEqual(['empty-list']);
  });

  it('status() 输出 registry 观测（dataset=sector-quote，含两个绑定）', async () => {
    const manager = mkManager([
      mkBinding('eastmoney', () => Promise.resolve({ items: [mkItem('BK0001')] })),
      mkBinding('fuyao', () => Promise.resolve({ items: [mkItem('881101.TI')] })),
    ]);
    await manager.fetchList(query());

    const status = manager.status();
    expect(status).toHaveLength(2);
    expect(status.map((entry) => `${entry.source}:${entry.dataset}`)).toEqual([
      'eastmoney:sector-quote',
      'fuyao:sector-quote',
    ]);
    // 只有第一个绑定实际执行过（fallback 短路）
    const [eastmoney, fuyao] = status;
    expect(eastmoney?.lastSuccessAt).toBeDefined();
    expect(fuyao?.lastAttemptAt).toBeUndefined();
  });

  it('limit 截断在 manager 侧执行（adapter 返回全量）', async () => {
    const manager = mkManager([
      mkBinding('eastmoney', () =>
        Promise.resolve({ items: [mkItem('BK0001'), mkItem('BK0002'), mkItem('BK0003')] }),
      ),
    ]);
    const result = await manager.fetchList(query({ limit: 2 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.total).toBe(2);
      expect(result.data.items.map((item) => item.code)).toEqual(['BK0001', 'BK0002']);
    }
  });
});
