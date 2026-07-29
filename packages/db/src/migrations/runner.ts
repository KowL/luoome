import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

const MIGRATION_ID_PATTERN = /^[0-9]{8}_[0-9]{2}_[a-z0-9][a-z0-9_]*$/;
export const TARGET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface SchemaMigration {
  readonly id: string;
  readonly checksum: string;
  readonly up: (db: Database) => Record<string, unknown> | undefined;
}

export interface AppliedSchemaMigration {
  readonly id: string;
  readonly appliedAt: Date;
  readonly checksum: string;
  readonly details: Record<string, unknown>;
}

export interface MigrationRunResult {
  readonly applied: readonly AppliedSchemaMigration[];
  readonly skipped: readonly AppliedSchemaMigration[];
}

export class MigrationChecksumMismatchError extends Error {
  override readonly name = 'MigrationChecksumMismatchError';

  constructor(
    readonly migrationId: string,
    readonly expectedChecksum: string,
    readonly actualChecksum: string,
  ) {
    super(
      `migration "${migrationId}" checksum 冲突：数据库=${expectedChecksum}，装配=${actualChecksum}`,
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const migrationChecksum = (source: string): string =>
  createHash('sha256').update(source).digest('hex');

export const defineSchemaMigration = (input: {
  readonly id: string;
  /** 迁移 SQL/算法的稳定文本表示；修改它会触发 checksum 冲突。 */
  readonly source: string;
  readonly up: SchemaMigration['up'];
}): SchemaMigration => {
  if (!MIGRATION_ID_PATTERN.test(input.id)) {
    throw new Error(`migration id 不合法: "${input.id}"`);
  }
  return { id: input.id, checksum: migrationChecksum(input.source), up: input.up };
};

const ensureMigrationTable = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      checksum TEXT NOT NULL,
      details_json TEXT NOT NULL
    )
  `);
};

interface MigrationRow {
  readonly id: string;
  readonly applied_at: number;
  readonly checksum: string;
  readonly details_json: string;
}

const decodeRow = (row: MigrationRow): AppliedSchemaMigration => ({
  id: row.id,
  appliedAt: new Date(row.applied_at),
  checksum: row.checksum,
  details: JSON.parse(row.details_json) as Record<string, unknown>,
});

export const listAppliedSchemaMigrations = (db: Database): readonly AppliedSchemaMigration[] => {
  ensureMigrationTable(db);
  return db
    .query<MigrationRow, []>(
      'SELECT id, applied_at, checksum, details_json FROM schema_migrations ORDER BY id',
    )
    .all()
    .map(decodeRow);
};

/**
 * Repository-free migration runner。每项 migration 的业务写入与登记行在同一 SQLite 事务中。
 * 已应用且 checksum 相同会跳过；不同则拒绝启动，避免静默执行变化后的逻辑。
 */
export const runSchemaMigrations = (
  db: Database,
  migrations: readonly SchemaMigration[],
  options: { readonly clock?: () => Date } = {},
): MigrationRunResult => {
  ensureMigrationTable(db);
  const clock = options.clock ?? (() => new Date());
  const ids = new Set<string>();
  for (const migration of migrations) {
    if (ids.has(migration.id)) throw new Error(`重复 migration id: "${migration.id}"`);
    ids.add(migration.id);
  }

  const applied: AppliedSchemaMigration[] = [];
  const skipped: AppliedSchemaMigration[] = [];
  const find = db.query<MigrationRow, [string]>(
    'SELECT id, applied_at, checksum, details_json FROM schema_migrations WHERE id = ?',
  );
  const insert = db.prepare(
    'INSERT INTO schema_migrations (id, applied_at, checksum, details_json) VALUES (?, ?, ?, ?)',
  );

  for (const migration of migrations) {
    const existing = find.get(migration.id);
    if (existing !== null) {
      if (existing.checksum !== migration.checksum) {
        throw new MigrationChecksumMismatchError(
          migration.id,
          existing.checksum,
          migration.checksum,
        );
      }
      skipped.push(decodeRow(existing));
      continue;
    }

    const applyOne = db.transaction(() => {
      const details = migration.up(db) ?? {};
      const appliedAt = clock();
      insert.run(migration.id, appliedAt.getTime(), migration.checksum, JSON.stringify(details));
      return {
        id: migration.id,
        appliedAt,
        checksum: migration.checksum,
        details,
      } satisfies AppliedSchemaMigration;
    });
    applied.push(applyOne());
  }

  return { applied, skipped };
};

export type LegacyTargetKind = 'strategy' | 'watchlist' | 'alert-plan';

export interface LegacyIdResolution {
  readonly legacyId: string;
  readonly targetId: string;
  readonly conflict: boolean;
}

/** 默认保留 legacy id；冲突时使用目标前缀，二次冲突时追加稳定 hash。 */
export const resolveLegacyTargetId = (input: {
  readonly legacyId: string;
  readonly targetKind: LegacyTargetKind;
  readonly occupiedIds: ReadonlySet<string>;
}): LegacyIdResolution => {
  if (!TARGET_ID_PATTERN.test(input.legacyId)) {
    throw new Error(`legacy id 不符合统一 slug 规则: "${input.legacyId}"`);
  }
  if (!input.occupiedIds.has(input.legacyId)) {
    return { legacyId: input.legacyId, targetId: input.legacyId, conflict: false };
  }

  const prefixed = `${input.targetKind}-${input.legacyId}`;
  const candidate = prefixed.slice(0, 64);
  if (!input.occupiedIds.has(candidate)) {
    return { legacyId: input.legacyId, targetId: candidate, conflict: true };
  }
  const suffix = migrationChecksum(`${input.targetKind}:${input.legacyId}`).slice(0, 8);
  const targetId = `${prefixed.slice(0, 55)}-${suffix}`;
  return { legacyId: input.legacyId, targetId, conflict: true };
};
