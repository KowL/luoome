import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'vitest';

import {
  defineSchemaMigration,
  listAppliedSchemaMigrations,
  MigrationChecksumMismatchError,
  resolveLegacyTargetId,
  runSchemaMigrations,
} from './runner.js';

const clock = (): Date => new Date('2026-07-29T00:00:00.000Z');

describe('schema migration runner', () => {
  it('空库和空 registry：只建立 migration registry', () => {
    const db = new Database(':memory:');
    expect(runSchemaMigrations(db, [], { clock })).toEqual({ applied: [], skipped: [] });
    expect(listAppliedSchemaMigrations(db)).toEqual([]);
    db.close();
  });

  it('同一 migration 重复运行只执行一次并保留 details', () => {
    const db = new Database(':memory:');
    const migration = defineSchemaMigration({
      id: '20260729_01_fixture',
      source: 'CREATE TABLE fixture (id TEXT PRIMARY KEY)',
      up: (sqlite) => {
        sqlite.exec('CREATE TABLE fixture (id TEXT PRIMARY KEY)');
        return { created: 1 };
      },
    });

    expect(runSchemaMigrations(db, [migration], { clock }).applied).toHaveLength(1);
    const rerun = runSchemaMigrations(db, [migration], { clock });
    expect(rerun.applied).toEqual([]);
    expect(rerun.skipped).toHaveLength(1);
    expect(listAppliedSchemaMigrations(db)[0]).toMatchObject({
      id: migration.id,
      appliedAt: clock(),
      details: { created: 1 },
    });
    db.close();
  });

  it('已应用 id 的 checksum 变化会拒绝', () => {
    const db = new Database(':memory:');
    const first = defineSchemaMigration({
      id: '20260729_01_fixture',
      source: 'v1',
      up: () => {},
    });
    const changed = defineSchemaMigration({
      id: first.id,
      source: 'v2',
      up: () => {},
    });
    runSchemaMigrations(db, [first], { clock });
    expect(() => runSchemaMigrations(db, [changed], { clock })).toThrow(
      MigrationChecksumMismatchError,
    );
    db.close();
  });

  it('migration 中途抛错会回滚业务行和登记行', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE fixture (id TEXT PRIMARY KEY)');
    const broken = defineSchemaMigration({
      id: '20260729_01_broken',
      source: 'insert then fail',
      up: (sqlite) => {
        sqlite.exec("INSERT INTO fixture (id) VALUES ('must-rollback')");
        throw new Error('boom');
      },
    });
    expect(() => runSchemaMigrations(db, [broken], { clock })).toThrow('boom');
    expect(db.query('SELECT * FROM fixture').all()).toEqual([]);
    expect(listAppliedSchemaMigrations(db)).toEqual([]);
    db.close();
  });

  it('legacy id 默认保持，冲突时产生稳定映射', () => {
    expect(
      resolveLegacyTargetId({
        legacyId: 'trend-following',
        targetKind: 'strategy',
        occupiedIds: new Set(),
      }),
    ).toEqual({
      legacyId: 'trend-following',
      targetId: 'trend-following',
      conflict: false,
    });
    expect(
      resolveLegacyTargetId({
        legacyId: 'trend-following',
        targetKind: 'strategy',
        occupiedIds: new Set(['trend-following']),
      }),
    ).toEqual({
      legacyId: 'trend-following',
      targetId: 'strategy-trend-following',
      conflict: true,
    });
  });
});
