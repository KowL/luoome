import type { SchemaMigrationRecord, SchemaMigrationRepository } from '@luoome/core';
import type { DrizzleDatabase } from '../../database.js';
import type { Schema } from '../../schema/index.js';
import { schemaMigrations } from '../../schema/index.js';

/** 只读：诊断需要知道「哪些启动迁移已应用、何时应用」，不提供写入面。 */
export class DrizzleSchemaMigrationRepository implements SchemaMigrationRepository {
  constructor(private readonly db: DrizzleDatabase<Schema>) {}

  async list(): Promise<readonly SchemaMigrationRecord[]> {
    return this.db
      .select({ id: schemaMigrations.id, appliedAt: schemaMigrations.appliedAt })
      .from(schemaMigrations)
      .all();
  }
}
