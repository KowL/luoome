import { money, type PublicMarketStore, type Quote } from '@luoome/core';
import { describe, expect, it, vi } from 'vitest';
import {
  MarketRequestCoordinator,
  marketRequestConfigFromEnv,
} from '../../adapters/src/market/request-coordinator.js';

const T0 = Date.parse('2026-10-15T02:00:00Z');
const config = { ...marketRequestConfigFromEnv({}), cacheTtlMs: 1000, requestsPerWindow: 100 };
const quote = (stockId: string, now: number, price = 120): Quote => ({
  stockId,
  source: 'eastmoney',
  observedAt: new Date(now),
  fetchedAt: new Date(now),
  ts: new Date(now),
  timestampSource: 'upstream',
  open: money(price),
  high: money(price),
  low: money(price),
  close: money(price),
  volume: 100,
});
/** 公共行情共享存储的进程内实现：只存配额与冷却事实，不含租户身份或投资数据。 */
const createMemoryPublicMarketStore = (): PublicMarketStore => {
  const entries = new Map<string, { value: string; retainUntil: number }>();
  const read = (key: string, now: number): string | null => {
    const entry = entries.get(key);
    return entry !== undefined && entry.retainUntil > now ? entry.value : null;
  };
  return {
    read,
    update: (key, now, retainUntil, change) => {
      const next = change(read(key, now));
      for (const [id, entry] of entries) {
        if (entry.retainUntil <= now) entries.delete(id);
      }
      entries.set(key, { value: next.value, retainUntil });
      return next.result;
    },
  };
};

describe('公共行情故障注入', () => {
  it.each(['429', 'network'] as const)(
    '%s cooldown 在重建协调器后仍然共享，被拒绝的股票不能推迟其截止时间',
    async (failure) => {
      let now = T0;
      const shared = createMemoryPublicMarketStore();
      const http = vi.fn(async () => {
        if (http.mock.calls.length > 1) return Response.json({ ok: true });
        if (failure === 'network') throw new TypeError('injected offline');
        return new Response(null, { status: 429, headers: { 'retry-after': '120' } });
      });
      const perform = async (stockId: string, single = false) => {
        const coordinator = new MarketRequestCoordinator(shared, config, () => now);
        const fetch = coordinator.fetchFor('eastmoney', http as unknown as typeof globalThis.fetch);
        if (single)
          return coordinator.execute(
            {
              source: 'eastmoney',
              capability: 'quote',
              coverage: [],
              execute: async ({ stockId }) => {
                await fetch('https://push2.eastmoney.com/quote');
                return quote(stockId, now);
              },
            },
            { stockId },
          );
        return coordinator.execute(
          {
            source: 'eastmoney',
            capability: 'batch-quote',
            coverage: [],
            execute: async ({ stockIds }) => {
              await fetch('https://push2.eastmoney.com/batch');
              return stockIds.map((id) => quote(id, now));
            },
          },
          { stockIds: [stockId] },
        );
      };
      await expect(perform('600519.SH')).rejects.toMatchObject({
        kind: failure === '429' ? 'rate_limited' : 'network',
      });
      const deadline = T0 + (failure === '429' ? 120_000 : 60_000);
      for (const offset of [1, 10_000, 30_000, deadline - T0 - 1]) {
        now = T0 + offset;
        await expect(perform(`blocked-${offset}.SH`, offset % 2 === 1)).rejects.toMatchObject({
          kind: failure === '429' ? 'rate_limited' : 'network',
        });
        await expect(perform('600519.SH')).rejects.toMatchObject({
          kind: failure === '429' ? 'rate_limited' : 'network',
        });
        expect(JSON.parse(shared.read('provider:eastmoney', now) ?? '{}')).toMatchObject({
          blockedUntil: deadline,
          attempts: now - T0 < config.windowMs ? [T0] : [],
        });
        expect(http).toHaveBeenCalledTimes(1);
      }
      now = deadline;
      await expect(perform('recovered.SH')).resolves.toMatchObject([
        { stockId: 'recovered.SH', observedAt: new Date(deadline) },
      ]);
      expect(http).toHaveBeenCalledTimes(2);
    },
  );
});
