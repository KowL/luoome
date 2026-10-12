import { afterEach, describe, expect, it } from 'bun:test';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOSTED_TENANT_SCHEMA_VERSION,
  type TenantManifest,
  TenantRuntimeManager,
} from './hosted-runtime.js';

const roots: string[] = [];
const managers: TenantRuntimeManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.stop();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const setup = (capacity = 2) => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-hosted-runtime-'));
  roots.push(root);
  const manager = new TenantRuntimeManager(root, capacity);
  managers.push(manager);
  const manifest = (): TenantManifest => ({
    tenantId: crypto.randomUUID(),
    ownerUserId: crypto.randomUUID(),
    generation: 1,
    schemaVersion: HOSTED_TENANT_SCHEMA_VERSION,
  });
  return { root, manager, manifest };
};

describe('tenant runtime lifecycle', () => {
  it('provisions idempotently without fabricated investment accounts or cash', async () => {
    const { root, manager, manifest } = setup();
    const identity = manifest();
    (await manager.provision(identity)).close();
    (await manager.provision(identity)).close();
    const lease = manager.acquire(identity);
    expect(await lease.runtime.repos.account.list()).toEqual([]);
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(lease.runtime.dbPath).mode & 0o777).toBe(0o600);
    lease.release();
  });

  it('isolates the same object identifier in separate tenant databases', async () => {
    const { manager, manifest } = setup();
    const a = manifest();
    const b = manifest();
    (await manager.provision(a)).close();
    (await manager.provision(b)).close();
    const first = manager.acquire(a);
    const second = manager.acquire(b);
    const now = new Date();
    await first.runtime.repos.watchlist.save({
      id: 'same-id',
      name: 'Private A',
      kind: 'personal',
      membershipPolicy: 'manual',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    expect(await second.runtime.repos.watchlist.findById('same-id')).toBeNull();
    await second.runtime.repos.watchlist.save({
      id: 'same-id',
      name: 'Private B',
      kind: 'personal',
      membershipPolicy: 'manual',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    expect((await first.runtime.repos.watchlist.findById('same-id'))?.name).toBe('Private A');
    first.release();
    second.release();
  });

  it('evicts only released runtimes and drains shutdown references safely', async () => {
    const { manager, manifest } = setup(1);
    const a = manifest();
    const b = manifest();
    (await manager.provision(a)).close();
    (await manager.provision(b)).close();
    const held = manager.acquire(a);
    expect(() => manager.acquire(b)).toThrow('capacity');
    expect(manager.drain(a.tenantId)).toBe(false);
    expect(await held.runtime.repos.account.list()).toEqual([]);
    held.release();
    held.release();
    const next = manager.acquire(b);
    manager.stop();
    expect(manager.status).toEqual({ open: 1, activeReferences: 1 });
    expect(await next.runtime.repos.account.list()).toEqual([]);
    next.release();
    expect(manager.status).toEqual({ open: 0, activeReferences: 0 });
  });

  it('rejects identity, generation, schema and symlink substitutions without migration', async () => {
    const { root, manager, manifest } = setup();
    const identity = manifest();
    (await manager.provision(identity)).close();
    expect(() => manager.acquire({ ...identity, generation: 2 })).toThrow('mismatch');
    expect(() => manager.acquire({ ...identity, ownerUserId: crypto.randomUUID() })).toThrow(
      'mismatch',
    );
    expect(() => manager.acquire({ ...identity, schemaVersion: 999 })).toThrow('mismatch');
    expect(() => manager.acquire({ ...identity, tenantId: '../outside' })).toThrow();
    const directory = join(root, 'tenants', identity.tenantId);
    const db = join(directory, 'luoome.db');
    const saved = readFileSync(db);
    rmSync(db);
    const external = join(root, 'outside.db');
    writeFileSync(external, saved);
    symlinkSync(external, db);
    expect(() => manager.acquire(identity)).toThrow('storage');
    expect(readFileSync(external)).toEqual(saved);
  });
});
