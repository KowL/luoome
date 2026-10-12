import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteMaintenanceGate } from '@luoome/db';
import {
  copyHostedBackupForRestore,
  createHostedBackup,
  verifyHostedBackup,
} from './hosted-backup.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-recovery-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dataRoot = join(root, 'data');
  mkdirSync(join(dataRoot, 'tenants', 'fixture', 'vault'), { recursive: true });
  const control = new Database(join(dataRoot, 'control.sqlite'));
  cleanups.push(() => control.close());
  control.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE sample(id TEXT PRIMARY KEY); INSERT INTO sample VALUES ("platform");',
  );
  const tenant = new Database(join(dataRoot, 'tenants', 'fixture', 'luoome.db'));
  cleanups.push(() => tenant.close());
  tenant.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE sample(id TEXT PRIMARY KEY); INSERT INTO sample VALUES ("tenant");',
  );
  writeFileSync(join(dataRoot, 'tenants', 'fixture', 'vault', 'note.md'), 'private fixture note');
  return { root, dataRoot, gate: createSqliteMaintenanceGate(control) };
};
test('one frozen recovery set includes SQLite WAL contents and private files', async () => {
  const f = fixture();
  const destination = join(f.root, 'backup');
  const manifest = await createHostedBackup({ dataRoot: f.dataRoot, destination, gate: f.gate });
  expect(manifest.files.length).toBe(3);
  expect(f.gate.state().mode).toBe('open');
  expect(verifyHostedBackup(destination)).toEqual(manifest);
  const restored = join(f.root, 'restored');
  copyHostedBackupForRestore({ source: destination, destination: restored, writersStopped: true });
  const db = new Database(join(restored, 'tenants', 'fixture', 'luoome.db'), { readonly: true });
  try {
    expect(db.query('SELECT id FROM sample').get()).toEqual({ id: 'tenant' });
  } finally {
    db.close();
  }
  expect(readFileSync(join(restored, 'tenants', 'fixture', 'vault', 'note.md'), 'utf8')).toBe(
    'private fixture note',
  );
});
test('does not copy files while any writer remains active', async () => {
  const f = fixture();
  const lease = f.gate.enter('worker');
  await expect(
    createHostedBackup({
      dataRoot: f.dataRoot,
      destination: join(f.root, 'blocked'),
      gate: f.gate,
      timeoutMs: 1,
    }),
  ).rejects.toThrow('backup_writers_not_drained');
  expect(f.gate.state().mode).toBe('open');
  lease?.release();
});
test('hash mismatch and symlink data are rejected, and existing live roots cannot be overwritten', async () => {
  const f = fixture();
  const destination = join(f.root, 'backup');
  await createHostedBackup({ dataRoot: f.dataRoot, destination, gate: f.gate });
  expect(() =>
    copyHostedBackupForRestore({
      source: destination,
      destination: f.dataRoot,
      writersStopped: true,
    }),
  ).toThrow('restore_requires_new_data_root');
  expect(() =>
    copyHostedBackupForRestore({
      source: destination,
      destination: join(f.root, 'new'),
      writersStopped: false,
    }),
  ).toThrow();
  writeFileSync(join(destination, 'tenants', 'fixture', 'vault', 'note.md'), 'tampered');
  expect(() => verifyHostedBackup(destination)).toThrow('backup_file_verification_failed');
  symlinkSync(join(f.root, 'backup'), join(f.dataRoot, 'tenants', 'fixture', 'vault', 'escape'));
  await expect(
    createHostedBackup({
      dataRoot: f.dataRoot,
      destination: join(f.root, 'symlink-backup'),
      gate: f.gate,
    }),
  ).rejects.toThrow('backup_symlink_rejected');
});
