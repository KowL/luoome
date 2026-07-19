import { describe, expect, it } from 'vitest';

import { DailyBarCache, LRU, QuoteCache } from './cache.js';

describe('market/cache', () => {
  describe('LRU', () => {
    it('基本 get / set / delete', () => {
      const lru = new LRU<string, number>(3);
      lru.set('a', 1);
      lru.set('b', 2);
      expect(lru.get('a')).toBe(1);
      expect(lru.get('b')).toBe(2);
      expect(lru.get('c')).toBeUndefined();
      expect(lru.delete('a')).toBe(true);
      expect(lru.get('a')).toBeUndefined();
    });

    it('超出 capacity 触发 LRU 淘汰', () => {
      const lru = new LRU<string, number>(2);
      lru.set('a', 1);
      lru.set('b', 2);
      lru.set('c', 3); // 淘汰 a
      expect(lru.get('a')).toBeUndefined();
      expect(lru.get('b')).toBe(2);
      expect(lru.get('c')).toBe(3);
      const stats = lru.stats();
      expect(stats.evictions).toBe(1);
      expect(stats.size).toBe(2);
    });

    it('get 命中即更新访问顺序', () => {
      const lru = new LRU<string, number>(2);
      lru.set('a', 1);
      lru.set('b', 2);
      lru.get('a'); // a 移到队尾
      lru.set('c', 3); // 淘汰 b
      expect(lru.get('a')).toBe(1);
      expect(lru.get('b')).toBeUndefined();
      expect(lru.get('c')).toBe(3);
    });

    it('TTL 过期等同 miss', async () => {
      const lru = new LRU<string, number>(2);
      lru.set('a', 1, 10);
      expect(lru.get('a')).toBe(1);
      await new Promise((r) => setTimeout(r, 15));
      expect(lru.get('a')).toBeUndefined();
      const stats = lru.stats();
      expect(stats.misses).toBeGreaterThanOrEqual(1);
    });

    it('capacity 必须 > 0', () => {
      expect(() => new LRU<string, number>(0)).toThrow();
    });

    it('stats 报告 hits / misses / size', () => {
      const lru = new LRU<string, number>(2);
      lru.set('a', 1);
      lru.get('a'); // hit
      lru.get('b'); // miss
      lru.set('a', 2); // 替换
      expect(lru.stats()).toMatchObject({ hits: 1, misses: 1, size: 1, capacity: 2 });
    });
  });

  describe('QuoteCache', () => {
    it('set / get 走 stockId', () => {
      const c = new QuoteCache();
      const q = {
        stockId: '002594.SZ',
        ts: new Date(),
        open: 1 as never,
        high: 1 as never,
        low: 1 as never,
        close: 1 as never,
        volume: 100,
        source: 'eastmoney',
      };
      c.set(q);
      expect(c.get('002594.SZ')).toEqual(q);
      expect(c.get('AAPL.US')).toBeUndefined();
    });

    it('TTL 过期后 miss', async () => {
      const c = new QuoteCache(1024, 10);
      c.set({
        stockId: 'X',
        ts: new Date(),
        open: 1 as never,
        high: 1 as never,
        low: 1 as never,
        close: 1 as never,
        volume: 0,
        source: 'mock',
      });
      await new Promise((r) => setTimeout(r, 15));
      expect(c.get('X')).toBeUndefined();
    });
  });

  describe('DailyBarCache', () => {
    it('key 含 from / to；不同 range 不互命中', () => {
      const c = new DailyBarCache();
      const a = {
        stockId: 'X',
        date: new Date('2026-07-01'),
        open: 1 as never,
        high: 1 as never,
        low: 1 as never,
        close: 1 as never,
        volume: 0,
        adjFactor: 1,
      };
      const b = {
        stockId: 'X',
        date: new Date('2026-07-02'),
        open: 1 as never,
        high: 1 as never,
        low: 1 as never,
        close: 1 as never,
        volume: 0,
        adjFactor: 1,
      };
      c.set('X', new Date('2026-07-01'), new Date('2026-07-02'), [a]);
      c.set('X', new Date('2026-07-02'), new Date('2026-07-03'), [b]);
      expect(c.get('X', new Date('2026-07-01'), new Date('2026-07-02'))?.[0]).toEqual(a);
      expect(c.get('X', new Date('2026-07-02'), new Date('2026-07-03'))?.[0]).toEqual(b);
    });
  });
});
