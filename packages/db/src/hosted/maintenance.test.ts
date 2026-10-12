import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMemoryMaintenanceGate,
  createSqliteMaintenanceGate,
  type HostedMaintenanceGate,
} from './maintenance.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const contract = (name: string, factory: () => HostedMaintenanceGate) =>
  describe(name, () => {
    test('only one migration owner can enter a tenant until explicit release', () => {
      const gate = factory();
      const migration = gate.enterExclusive('tenant-migration:A');
      expect(migration).not.toBeNull();
      expect(gate.enterExclusive('tenant-migration:A')).toBeNull();
      expect(gate.enterExclusive('tenant-migration:B')).not.toBeNull();
      migration?.release();
      expect(gate.enterExclusive('tenant-migration:A')).not.toBeNull();
      gate.begin('backup');
      expect(gate.enterExclusive('tenant-migration:C')).toBeNull();
    });
    test('drains every writer category and refuses new work until explicitly reopened', () => {
      const gate = factory();
      const login = gate.enter('auth-session-touch');
      const callback = gate.enter('payment-callback');
      const worker = gate.enter('worker');
      expect(gate.state().activities).toBe(3);
      gate.begin('backup-A');
      expect(gate.enter('cache-write')).toBeNull();
      expect(() => gate.freeze('backup-A')).toThrow('maintenance_not_drained');
      login?.release();
      login?.release();
      callback?.release();
      worker?.release();
      gate.freeze('backup-A');
      expect(gate.state()).toEqual({ mode: 'frozen', owner: 'backup-A', activities: 0 });
      expect(() => gate.finish('backup-B')).toThrow('maintenance_owner_conflict');
      gate.finish('backup-A');
      expect(gate.enter('request')).not.toBeNull();
    });
    test('does not discard active writers merely because time has passed', () => {
      const gate = factory();
      gate.enter('slow-provider-call');
      gate.begin('backup');
      expect(() => gate.freeze('backup')).toThrow();
      expect(gate.state().activities).toBe(1);
    });
  });
contract('memory maintenance', createMemoryMaintenanceGate);
contract('SQLite maintenance', () => {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  return createSqliteMaintenanceGate(db);
});
test('independent processes use the same persisted barrier', () => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-maintenance-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const first = new Database(join(root, 'control.sqlite'));
  const second = new Database(join(root, 'control.sqlite'));
  cleanup.push(
    () => first.close(),
    () => second.close(),
  );
  const web = createSqliteMaintenanceGate(first);
  const worker = createSqliteMaintenanceGate(second);
  const migration = web.enterExclusive('tenant-migration:A');
  expect(worker.enterExclusive('tenant-migration:A')).toBeNull();
  migration?.release();
  const successor = worker.enterExclusive('tenant-migration:A');
  expect(successor).not.toBeNull();
  successor?.release();
  const lease = worker.enter('worker');
  web.begin('backup');
  expect(worker.enter('new-job')).toBeNull();
  expect(() => web.freeze('backup')).toThrow();
  lease?.release();
  web.freeze('backup');
  expect(worker.state().mode).toBe('frozen');
});
