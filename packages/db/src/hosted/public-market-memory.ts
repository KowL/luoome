import type { PublicMarketStore } from '@luoome/core';

export const createMemoryPublicMarketStore = (): PublicMarketStore => {
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
