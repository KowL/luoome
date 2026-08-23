import type { Logger } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';

import { networkError } from '../source-error.js';
import { createTestMarketDataManager } from './manager.test-helper.js';

const silentLogger = (): Logger => {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
};

/** 全能力 stub：记录每次调用，可按名字注入失败。 */
const fullSource = (name: string, failOn?: string) => {
  const calls: string[] = [];
  const record = <T>(method: string, value: T, failing: boolean): Promise<T> => {
    calls.push(method);
    return failing
      ? Promise.reject(networkError(`${name}.${method} down`))
      : Promise.resolve(value);
  };
  const observedAt = new Date('2026-08-21T07:00:00.000Z');
  return {
    name,
    calls,
    fetchQuote: (stockId: string) =>
      record(`quote:${stockId}`, { observedAt }, failOn === 'quote') as never,
    fetchBatchQuotes: (stockIds: readonly string[]) =>
      record(`batch:${stockIds.join(',')}`, [{ observedAt }], failOn === 'batch-quote') as never,
    fetchDailyBars: () =>
      record(
        'daily',
        [{ date: new Date('2026-08-21T00:00:00.000Z') }],
        failOn === 'daily-bars',
      ) as never,
    searchStocks: (query: string) => record(`search:${query}`, [], failOn === 'search') as never,
    fetchMarketSnapshot: () => record('snapshot', [{}], failOn === 'market-snapshot') as never,
    fetchMarketSnapshotEnvelope: () =>
      record('envelope', { dataAsOf: observedAt }, failOn === 'market-snapshot-envelope') as never,
    fetchIndexQuotes: () => record('index', [{ ts: observedAt }], failOn === 'index') as never,
    fetchIntradayMinutes: () =>
      record('intraday', [{ time: observedAt }], failOn === 'intraday-minutes') as never,
    fetchMinuteBars: () =>
      record('minute', [{ endedAt: observedAt }], failOn === 'minute-bars') as never,
  };
};

describe('MarketDataManager.probeSource（设置页测试按钮）', () => {
  it('逐项执行该源全部已绑定能力并记录观测', async () => {
    const primary = fullSource('eastmoney');
    const manager = createTestMarketDataManager({ primary, logger: silentLogger() });
    const probes = await manager.probeSource('eastmoney');

    const byCapability = new Map(probes.map((probe) => [probe.capability, probe]));
    // test-helper 给全能力 stub 绑定 9 种能力（indexQuoteMode 缺省 → realtime-index，无 delayed-index）
    expect(probes).toHaveLength(10);
    const bound = probes.filter((probe) => probe.bound);
    expect(bound).toHaveLength(9);
    expect(bound.every((probe) => probe.ok === true)).toBe(true);
    expect(byCapability.get('delayed-index')).toMatchObject({ bound: false, ok: null });
    expect(primary.calls).toContain('quote:600519.SH');
    expect(primary.calls).toContain('batch:600519.SH');
    expect(primary.calls).toContain('search:茅台');

    // 观测已写入 registry：quote 带 dataAsOf → 状态可取到 lastSuccessAt
    const status = manager.marketSourceStatus();
    const quote = status.find((s) => s.dataset === 'quote' && s.source === 'eastmoney');
    expect(quote?.lastSuccessAt).toBeDefined();
    expect(quote?.lastErrorKind).toBeUndefined();
  });

  it('单项失败不中断其余项，失败归类写入观测', async () => {
    const primary = fullSource('eastmoney', 'quote');
    const manager = createTestMarketDataManager({ primary, logger: silentLogger() });
    const probes = await manager.probeSource('eastmoney');

    const quote = probes.find((probe) => probe.capability === 'quote');
    expect(quote).toMatchObject({ bound: true, ok: false, errorKind: 'network' });
    expect(probes.filter((probe) => probe.ok === true).length).toBe(8);

    const status = manager.marketSourceStatus();
    expect(status.find((s) => s.dataset === 'quote')?.lastErrorKind).toBe('network');
    expect(status.find((s) => s.dataset === 'daily-bars')?.lastSuccessAt).toBeDefined();
  });

  it('探测未启用的源：全部 bound=false，不执行任何请求', async () => {
    const fetchQuote = vi.fn(() => Promise.resolve({} as never));
    const manager = createTestMarketDataManager({
      primary: { name: 'eastmoney', fetchQuote, fetchDailyBars: () => Promise.resolve([]) },
      logger: silentLogger(),
    });
    const probes = await manager.probeSource('fuyao');
    expect(probes.every((probe) => !probe.bound && probe.ok === null)).toBe(true);
    expect(fetchQuote).not.toHaveBeenCalled();
  });
});
