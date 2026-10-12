import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type RepositoryRegistry, type Stock, StockSchema } from '@luoome/core';
import {
  createDrizzleRepos,
  type DrizzleReposHandle,
  type HostedMaintenanceGate,
  type MaintenanceLease,
  seedData,
} from '@luoome/db';
import { z } from 'zod';

export const HOSTED_TENANT_SCHEMA_VERSION = 1;
const TenantStorageIdSchema = z.union([z.string().uuid(), z.string().regex(/^[A-Za-z0-9_-]{43}$/)]);

export const TenantManifestSchema = z.object({
  tenantId: TenantStorageIdSchema,
  ownerUserId: TenantStorageIdSchema,
  generation: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
});
export type TenantManifest = z.infer<typeof TenantManifestSchema>;

export interface TenantRuntime {
  readonly tenantId: string;
  readonly generation: number;
  readonly dbPath: string;
  readonly repos: RepositoryRegistry;
}

interface RuntimeEntry {
  readonly handle: DrizzleReposHandle;
  readonly runtime: TenantRuntime;
  references: number;
  lastUsed: number;
  readonly manifest: TenantManifest;
  readonly registration?: MaintenanceLease;
}

export interface TenantRuntimeLease {
  readonly runtime: TenantRuntime;
  release(): void;
}

const assertPrivatePath = (path: string, directory: boolean): void => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error('invalid tenant storage entry');
  }
  chmodSync(path, directory ? 0o700 : 0o600);
};

export const writePrivateArtifact = (directory: string, leaf: string, content: string): void => {
  if (!/^[A-Za-z0-9_.-]+$/.test(leaf) || leaf === '.' || leaf === '..')
    throw new Error('invalid private artifact');
  assertPrivatePath(directory, true);
  const path = join(directory, leaf);
  if (existsSync(path)) assertPrivatePath(path, false);
  const temporary = join(directory, `.write-${crypto.randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
    const directoryDescriptor = openSync(directory, 'r');
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
};

const assertDatabaseFiles = (path: string): void => {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) assertPrivatePath(file, false);
  }
};
const assertPrivateTree = (path: string): void => {
  assertPrivatePath(path, true);
  for (const child of readdirSync(path)) {
    const entry = join(path, child);
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink()) throw new Error('tenant deletion symlink rejected');
    if (stat.isDirectory()) assertPrivateTree(entry);
    else assertPrivatePath(entry, false);
  }
};

export const prepareHostedDataRoot = (root: string): string => {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivatePath(root, true);
  const canonical = realpathSync(root);
  const tenants = join(canonical, 'tenants');
  mkdirSync(tenants, { mode: 0o700, recursive: true });
  assertPrivatePath(tenants, true);
  return canonical;
};

export class TenantRuntimeManager {
  private readonly root: string;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly initialized = new Set<string>();
  private stopped = false;
  private readonly pruning?: ReturnType<typeof setInterval>;
  private pruningPromise: Promise<void> | undefined;

  constructor(
    root: string,
    private readonly maximumOpen = 16,
    private readonly clock: () => number = Date.now,
    private readonly lifecycle?: {
      readonly maintenance: HostedMaintenanceGate;
      readonly isCurrent: (manifest: TenantManifest) => Promise<boolean>;
    },
  ) {
    if (!Number.isSafeInteger(maximumOpen) || maximumOpen < 1) {
      throw new Error('runtime capacity must be positive');
    }
    this.root = prepareHostedDataRoot(root);
    if (lifecycle !== undefined) {
      this.pruning = setInterval(() => {
        if (this.pruningPromise !== undefined || this.stopped) return;
        this.pruningPromise = this.pruneUnavailable()
          .catch(() => {})
          .finally(() => {
            this.pruningPromise = undefined;
          });
      }, 500);
      this.pruning.unref();
    }
  }

  private closeEntry(id: string, entry: RuntimeEntry): void {
    entry.handle.close();
    entry.registration?.release();
    this.entries.delete(id);
  }

  async pruneUnavailable(): Promise<void> {
    if (this.lifecycle === undefined) return;
    for (const [id, entry] of this.entries) {
      if (
        !(await this.lifecycle.isCurrent(entry.manifest)) &&
        entry.references === 0 &&
        this.entries.get(id) === entry
      )
        this.closeEntry(id, entry);
    }
  }

  private directory(tenantId: string): string {
    TenantStorageIdSchema.parse(tenantId);
    return join(this.root, 'tenants', tenantId);
  }

  private assertManifest(expected: TenantManifest): string {
    const directory = this.directory(expected.tenantId);
    assertPrivatePath(directory, true);
    const manifestPath = join(directory, 'identity.json');
    assertPrivatePath(manifestPath, false);
    const manifest = TenantManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
    if (
      manifest.tenantId !== expected.tenantId ||
      manifest.ownerUserId !== expected.ownerUserId ||
      manifest.generation !== expected.generation ||
      manifest.schemaVersion !== HOSTED_TENANT_SCHEMA_VERSION ||
      expected.schemaVersion !== HOSTED_TENANT_SCHEMA_VERSION
    ) {
      throw new Error('tenant identity or schema mismatch');
    }
    return directory;
  }

  async provision(
    expected: TenantManifest,
    stocks: readonly z.infer<typeof StockSchema>[] = [],
  ): Promise<DrizzleReposHandle> {
    if (this.stopped) throw new Error('runtime manager stopped');
    TenantManifestSchema.parse(expected);
    if (expected.schemaVersion !== HOSTED_TENANT_SCHEMA_VERSION) {
      throw new Error('incompatible tenant schema');
    }
    const migration = this.lifecycle?.maintenance.enterExclusive(
      `tenant-migration:${expected.tenantId}`,
    );
    if (this.lifecycle !== undefined && migration == null)
      throw new Error('tenant migration unavailable');
    const registration = this.lifecycle?.maintenance.registerTenantRuntime(expected);
    if (this.lifecycle !== undefined && registration == null) {
      migration?.release();
      throw new Error('tenant runtime generation unavailable');
    }
    try {
      const directory = this.directory(expected.tenantId);
      if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
      assertPrivatePath(directory, true);
      const manifestPath = join(directory, 'identity.json');
      if (existsSync(manifestPath)) {
        this.assertManifest(expected);
      } else {
        if (existsSync(join(directory, 'luoome.db'))) {
          throw new Error('tenant database has no identity manifest');
        }
        writePrivateArtifact(directory, 'identity.json', JSON.stringify(expected));
      }
      for (const child of ['exports', 'vault']) {
        const path = join(directory, child);
        mkdirSync(path, { mode: 0o700, recursive: true });
        assertPrivatePath(path, true);
      }
      const dbPath = join(directory, 'luoome.db');
      assertDatabaseFiles(dbPath);
      const handle = createDrizzleRepos(dbPath);
      assertDatabaseFiles(dbPath);
      try {
        await seedData(handle.repos, {
          stocks: stocks.map((stock) => StockSchema.parse(stock) as Stock),
        });
        this.initialized.add(`${expected.tenantId}:${expected.generation}`);
      } catch (error) {
        handle.close();
        throw error;
      }
      let closed = false;
      return {
        ...handle,
        close: () => {
          if (closed) return;
          closed = true;
          handle.close();
          registration?.release();
        },
      };
    } catch (error) {
      registration?.release();
      throw error;
    } finally {
      migration?.release();
    }
  }

  acquire(expected: TenantManifest): TenantRuntimeLease {
    if (this.stopped) throw new Error('runtime manager stopped');
    const directory = this.assertManifest(expected);
    let entry = this.entries.get(expected.tenantId);
    if (entry !== undefined && entry.runtime.generation !== expected.generation) {
      if (entry.references !== 0) throw new Error('previous tenant generation still active');
      this.closeEntry(expected.tenantId, entry);
      entry = undefined;
    }
    if (entry === undefined) {
      if (this.entries.size >= this.maximumOpen) {
        const idle = [...this.entries.entries()]
          .filter(([, candidate]) => candidate.references === 0)
          .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (idle === undefined) throw new Error('tenant runtime capacity busy');
        this.closeEntry(idle[0], idle[1]);
      }
      const dbPath = join(directory, 'luoome.db');
      assertPrivatePath(dbPath, false);
      assertDatabaseFiles(dbPath);
      const migration = this.lifecycle?.maintenance.enterExclusive(
        `tenant-migration:${expected.tenantId}`,
      );
      if (this.lifecycle !== undefined && migration == null)
        throw new Error('tenant migration unavailable');
      const registration = this.lifecycle?.maintenance.registerTenantRuntime(expected);
      if (this.lifecycle !== undefined && registration == null) {
        migration?.release();
        throw new Error('tenant runtime generation unavailable');
      }
      let handle: DrizzleReposHandle;
      try {
        handle = createDrizzleRepos(dbPath, {
          migrate:
            this.lifecycle !== undefined &&
            !this.initialized.has(`${expected.tenantId}:${expected.generation}`),
        });
        assertDatabaseFiles(dbPath);
        this.initialized.add(`${expected.tenantId}:${expected.generation}`);
      } catch (error) {
        registration?.release();
        throw error;
      } finally {
        migration?.release();
      }
      entry = {
        handle,
        runtime: Object.freeze({
          tenantId: expected.tenantId,
          generation: expected.generation,
          dbPath,
          repos: handle.repos,
        }),
        references: 0,
        lastUsed: this.clock(),
        manifest: expected,
        ...(registration == null ? {} : { registration }),
      };
      this.entries.set(expected.tenantId, entry);
    }
    entry.references += 1;
    const acquired = entry;
    let released = false;
    return {
      runtime: acquired.runtime,
      release: () => {
        if (released) return;
        released = true;
        acquired.references -= 1;
        acquired.lastUsed = this.clock();
        if (this.stopped && acquired.references === 0) {
          this.closeEntry(expected.tenantId, acquired);
        }
      },
    };
  }

  drain(tenantId: string): boolean {
    const entry = this.entries.get(tenantId);
    if (entry === undefined) return true;
    if (entry.references !== 0) return false;
    this.closeEntry(tenantId, entry);
    return true;
  }

  writeExport(expected: TenantManifest, exportId: string, content: string): void {
    z.string()
      .regex(/^[A-Za-z0-9_-]{1,160}$/)
      .parse(exportId);
    const directory = join(this.assertManifest(expected), 'exports');
    writePrivateArtifact(directory, `${exportId}.json`, content);
  }

  readExport(expected: TenantManifest, exportId: string): Uint8Array {
    z.string()
      .regex(/^[A-Za-z0-9_-]{1,160}$/)
      .parse(exportId);
    const directory = join(this.assertManifest(expected), 'exports');
    assertPrivatePath(directory, true);
    const path = join(directory, `${exportId}.json`);
    assertPrivatePath(path, false);
    return readFileSync(path);
  }

  removeExport(tenantId: string, exportId: string): void {
    z.string()
      .regex(/^[A-Za-z0-9_-]{1,160}$/)
      .parse(exportId);
    const directory = this.directory(tenantId);
    if (!existsSync(directory)) return;
    assertPrivatePath(directory, true);
    const exports = join(directory, 'exports');
    if (!existsSync(exports)) return;
    assertPrivatePath(exports, true);
    const path = join(exports, `${exportId}.json`);
    if (existsSync(path)) {
      assertPrivatePath(path, false);
      rmSync(path);
    }
  }

  removeTenant(tenantId: string): boolean {
    if (!this.drain(tenantId) || (this.lifecycle?.maintenance.runtimeCount(tenantId) ?? 0) !== 0)
      return false;
    const directory = this.directory(tenantId);
    if (existsSync(directory)) {
      assertPrivateTree(directory);
      rmSync(directory, { recursive: true });
    }
    return true;
  }

  get status(): { readonly open: number; readonly activeReferences: number } {
    return {
      open: this.entries.size,
      activeReferences: [...this.entries.values()].reduce(
        (sum, entry) => sum + entry.references,
        0,
      ),
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.pruning !== undefined) clearInterval(this.pruning);
    for (const [id, entry] of this.entries) {
      if (entry.references === 0) {
        this.closeEntry(id, entry);
      }
    }
  }
}
