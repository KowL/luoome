import type { PlatformRepositoryRegistry } from '@luoome/core';
import { createPlatformRepositories } from './platform-repositories.js';
import {
  PLATFORM_TABLES,
  type PlatformRecords,
  type PlatformStore,
  type PlatformTable,
} from './platform-store.js';

class MemoryPlatformStore implements PlatformStore {
  private records = new Map<PlatformTable, Map<string, unknown>>(
    PLATFORM_TABLES.map((name) => [name, new Map()]),
  );

  transaction<T>(work: () => T): T {
    const snapshot = structuredClone(this.records);
    try {
      return work();
    } catch (error) {
      this.records = snapshot;
      throw error;
    }
  }

  get<K extends PlatformTable>(table: K, id: string): PlatformRecords[K] | null {
    const value = this.records.get(table)?.get(id);
    return value === undefined ? null : (structuredClone(value) as PlatformRecords[K]);
  }

  list<K extends PlatformTable>(
    table: K,
    where: Partial<PlatformRecords[K]> = {},
  ): PlatformRecords[K][] {
    return [...(this.records.get(table)?.values() ?? [])]
      .filter((value) =>
        Object.entries(where).every(
          ([key, expected]) => (value as Record<string, unknown>)[key] === expected,
        ),
      )
      .map((value) => structuredClone(value) as PlatformRecords[K]);
  }

  put<K extends PlatformTable>(table: K, entity: PlatformRecords[K]): void {
    this.records.get(table)?.set(entity.id, structuredClone(entity));
  }

  remove<K extends PlatformTable>(table: K, id: string): void {
    this.records.get(table)?.delete(id);
  }
}

export const createInMemoryPlatformRepos = (): PlatformRepositoryRegistry =>
  createPlatformRepositories(new MemoryPlatformStore());
