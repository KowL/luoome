/**
 * 局部 LRU 实现（limit-up-ladder 自包含）。
 *
 * 不直接复用 packages/adapters/src/market/cache.ts 的 LRU 原因：
 * - market/cache.ts 是行情私有，未对外暴露（也未上提到 core）
 * - limit-up-ladder 的 key/value 形态与 quote 缓存差异较大，独立实现更直接
 *
 * Phase 2 评估：若再有第三处缓存需求，再统一提到 core/src/cache/lru.ts。
 */

interface Entry<V> {
  readonly value: V;
  readonly expiresAt: number;
}

export class LRU<K, V> {
  private readonly items = new Map<K, Entry<V>>();

  constructor(private readonly capacityValue: number = 512) {
    if (capacityValue <= 0) throw new Error('LRU capacity must be > 0');
  }

  get(key: K): V | undefined {
    const entry = this.items.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    this.items.delete(key);
    this.items.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    const expiresAt = ttlMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + ttlMs;
    if (this.items.has(key)) {
      this.items.delete(key);
    } else if (this.items.size >= this.capacityValue) {
      const oldestKey = this.items.keys().next().value;
      if (oldestKey !== undefined) this.items.delete(oldestKey);
    }
    this.items.set(key, { value, expiresAt });
  }

  delete(key: K): boolean {
    return this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }

  size(): number {
    return this.items.size;
  }
}
