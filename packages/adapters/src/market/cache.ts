import type { DailyBar, Quote } from '@luoome/core';

/**
 * 通用 LRU 缓存（v0.2 起）。
 *
 * 设计要点：
 * - 不引第三方（lru-cache 等）；仅依赖 Map 的插入顺序保证 + Set 跟踪访问顺序。
 * - 容量上限 1024：避免内存爆炸（同时约 1000 持仓的 quote + 2000 段日线在内存中可控）。
 * - 命中即更新访问顺序（get 时把 key 移到队尾），淘汰队首。
 * - TTL 在 get 时校验，过期等同 miss。
 *
 * 不变量：
 * - `size() <= capacity`（插入时若超容量会先淘汰 1 个）。
 * - get / set / delete 永不抛异常。
 */

interface Entry<V> {
  readonly value: V;
  readonly expiresAt: number; // ms epoch；Number.POSITIVE_INFINITY 表示无 TTL
}

export interface LRUStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly size: number;
  readonly capacity: number;
}

export class LRU<K, V> {
  private readonly items = new Map<K, Entry<V>>();
  private hitsCount = 0;
  private missesCount = 0;
  private evictionsCount = 0;

  constructor(private readonly capacityValue: number = 1024) {
    if (capacityValue <= 0) throw new Error('LRU capacity must be > 0');
  }

  /** O(1) get，命中更新访问顺序。 */
  get(key: K): V | undefined {
    const entry = this.items.get(key);
    if (entry === undefined) {
      this.missesCount += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.items.delete(key);
      this.missesCount += 1;
      return undefined;
    }
    // 命中 → 移到队尾：删了再 set（保留引用以避免重复构造）。
    this.items.delete(key);
    this.items.set(key, entry);
    this.hitsCount += 1;
    return entry.value;
  }

  /** O(1) set，必要时淘汰队首。ttlMs 缺省 = 不过期。 */
  set(key: K, value: V, ttlMs?: number): void {
    const expiresAt = ttlMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttlMs;
    if (this.items.has(key)) {
      this.items.delete(key);
    } else if (this.items.size >= this.capacityValue) {
      // 淘汰最早插入的（队首）
      const oldestKey = this.items.keys().next().value;
      if (oldestKey !== undefined) {
        this.items.delete(oldestKey);
        this.evictionsCount += 1;
      }
    }
    this.items.set(key, { value, expiresAt });
  }

  /** O(1) delete；不存在时 no-op。 */
  delete(key: K): boolean {
    return this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }

  size(): number {
    return this.items.size;
  }

  stats(): LRUStats {
    return {
      hits: this.hitsCount,
      misses: this.missesCount,
      evictions: this.evictionsCount,
      size: this.items.size,
      capacity: this.capacityValue,
    };
  }
}

/**
 * 行情快照缓存：key = stockCode（如 '002594.SZ'），TTL 默认 60s。
 * Manager 用它避免短时间重复 fetch；Adapter 切换 source 时也能命中。
 */
export class QuoteCache {
  private readonly lru: LRU<string, Quote>;

  constructor(
    capacity: number = 1024,
    private readonly ttlMs: number = 60_000,
  ) {
    this.lru = new LRU<string, Quote>(capacity);
  }

  get(stockCode: string): Quote | undefined {
    return this.lru.get(stockCode);
  }

  set(quote: Quote): void {
    this.lru.set(quote.stockId, quote, this.ttlMs);
  }

  clear(): void {
    this.lru.clear();
  }

  stats(): LRUStats {
    return this.lru.stats();
  }
}

/**
 * 日线缓存：key = `${stockCode}|${fromMs}-${toMs}`，TTL 默认 1 小时。
 * 注意：相同 (stockCode, from, to) 才命中；不同 range 即便重叠也要重 fetch。
 * 实战中 analyze_stock 总是固定 120 天窗口 → cache 命中率高。
 */
export class DailyBarCache {
  private readonly lru: LRU<string, readonly DailyBar[]>;

  constructor(
    capacity: number = 512,
    private readonly ttlMs: number = 3_600_000,
  ) {
    this.lru = new LRU<string, readonly DailyBar[]>(capacity);
  }

  private keyOf(stockCode: string, from: Date, to: Date): string {
    return `${stockCode}|${from.getTime()}-${to.getTime()}`;
  }

  get(stockCode: string, from: Date, to: Date): readonly DailyBar[] | undefined {
    return this.lru.get(this.keyOf(stockCode, from, to));
  }

  set(stockCode: string, from: Date, to: Date, bars: readonly DailyBar[]): void {
    this.lru.set(this.keyOf(stockCode, from, to), bars, this.ttlMs);
  }

  clear(): void {
    this.lru.clear();
  }

  stats(): LRUStats {
    return this.lru.stats();
  }
}
