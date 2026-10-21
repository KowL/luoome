import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { HostedMaintenanceGate } from '@luoome/db';
import { z } from 'zod';
import workspacePackage from '../../../package.json';
import { writePrivateArtifact } from './hosted-runtime.js';

const FileSchema = z
  .object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const HostedBackupManifestSchema = z
  .object({
    version: z.literal(1),
    productPolicyVersion: z.enum(['hosted-facts-v1', 'hosted-web-v2']),
    backupId: z.uuid(),
    appVersion: z.string().min(1),
    platformSchemaVersion: z.literal(1),
    tenantSchemaVersion: z.literal(1),
    createdAt: z.string().datetime(),
    files: z.array(FileSchema),
  })
  .strict();
export type HostedBackupManifest = z.infer<typeof HostedBackupManifestSchema>;
const hashFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const flushArtifact = (path: string) => {
  for (const target of [path, dirname(path)]) {
    const descriptor = openSync(target, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
};
const safeRelativePath = (path: string) => {
  if (
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => part === '..' || part === '.' || part === '')
  )
    throw new Error('invalid_backup_path');
  return path;
};
const privateDirectory = (path: string, enforcePermissions = true) => {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('invalid_backup_directory');
  if (enforcePermissions) chmodSync(path, 0o700);
};
const walk = (root: string, path = root): string[] => {
  const paths: string[] = [];
  for (const entry of readdirSync(path)) {
    const absolute = join(path, entry);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('backup_symlink_rejected');
    if (stat.isDirectory()) paths.push(...walk(root, absolute));
    else if (stat.isFile()) paths.push(relative(root, absolute).split(sep).join('/'));
    else throw new Error('unsupported_backup_entry');
  }
  return paths.sort();
};
const sqliteSnapshot = (source: string, target: string) => {
  const database = new Database(source, { create: false, readonly: true });
  try {
    database.query('VACUUM INTO ?').run(target);
    const verify = new Database(target, { create: false, readonly: true });
    try {
      const rows = verify.query('PRAGMA integrity_check').all() as Array<{
        integrity_check: string;
      }>;
      if (rows.some((row) => row.integrity_check !== 'ok'))
        throw new Error('backup_integrity_failed');
    } finally {
      verify.close();
    }
  } finally {
    database.close();
  }
  chmodSync(target, 0o600);
};

export const createHostedBackup = async (input: {
  readonly dataRoot: string;
  readonly destination: string;
  readonly gate: HostedMaintenanceGate;
  readonly productPolicyVersion?: HostedBackupManifest['productPolicyVersion'];
  readonly timeoutMs?: number;
  readonly clock?: () => Date;
}): Promise<HostedBackupManifest> => {
  const root = realpathSync(input.dataRoot);
  const destination = resolve(input.destination);
  if (destination === root || destination.startsWith(`${root}${sep}`) || existsSync(destination))
    throw new Error('backup_destination_must_be_new_and_outside_data_root');
  privateDirectory(dirname(destination), false);
  const canonicalDestination = join(
    realpathSync(dirname(destination)),
    destination.split(sep).at(-1) as string,
  );
  if (canonicalDestination.startsWith(`${root}${sep}`))
    throw new Error('backup_destination_inside_data_root');
  const owner = `backup:${crypto.randomUUID()}`;
  input.gate.begin(owner);
  try {
    const deadline = Date.now() + (input.timeoutMs ?? 30_000);
    while (input.gate.state().activities !== 0) {
      if (Date.now() >= deadline) throw new Error('backup_writers_not_drained');
      await Bun.sleep(100);
    }
    input.gate.freeze(owner);
    privateDirectory(canonicalDestination);
    const paths = [
      'control.sqlite',
      ...['operator/ai-settings.json', 'operator/market.env'].filter((path) =>
        existsSync(join(root, path)),
      ),
      ...walk(join(root, 'tenants')).map((path) => `tenants/${path}`),
    ].filter((path) => !/^tenants\/[A-Za-z0-9_-]+\/luoome\.db-(wal|shm)$/.test(path));
    const files: HostedBackupManifest['files'] = [];
    for (const path of paths) {
      safeRelativePath(path);
      const source = join(root, path);
      const target = join(canonicalDestination, path);
      const stat = lstatSync(source);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('backup_symlink_rejected');
      privateDirectory(dirname(target));
      if (path === 'control.sqlite' || /^tenants\/[A-Za-z0-9_-]+\/luoome\.db$/.test(path))
        sqliteSnapshot(source, target);
      else {
        copyFileSync(source, target);
        chmodSync(target, 0o600);
      }
      flushArtifact(target);
      files.push({ path, bytes: lstatSync(target).size, sha256: hashFile(target) });
    }
    const manifest = HostedBackupManifestSchema.parse({
      version: 1,
      productPolicyVersion: input.productPolicyVersion ?? 'hosted-facts-v1',
      backupId: crypto.randomUUID(),
      appVersion: workspacePackage.version,
      platformSchemaVersion: 1,
      tenantSchemaVersion: 1,
      createdAt: (input.clock?.() ?? new Date()).toISOString(),
      files,
    });
    writePrivateArtifact(canonicalDestination, 'manifest.json', JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    input.gate.finish(owner);
  }
};

export const verifyHostedBackup = (source: string): HostedBackupManifest => {
  const canonicalRoot = realpathSync(source);
  const manifestStat = lstatSync(join(source, 'manifest.json'));
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile())
    throw new Error('invalid_backup_manifest');
  const manifest = HostedBackupManifestSchema.parse(
    JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')),
  );
  const paths = new Set<string>();
  for (const file of manifest.files) {
    safeRelativePath(file.path);
    if (paths.has(file.path)) throw new Error('duplicate_backup_path');
    paths.add(file.path);
    const path = join(source, file.path);
    const stat = lstatSync(path);
    if (
      !realpathSync(path).startsWith(`${canonicalRoot}${sep}`) ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size !== file.bytes ||
      hashFile(path) !== file.sha256
    )
      throw new Error('backup_file_verification_failed');
  }
  if (!paths.has('control.sqlite')) throw new Error('backup_control_database_missing');
  return manifest;
};

export const copyHostedBackupForRestore = (input: {
  readonly source: string;
  readonly destination: string;
  readonly writersStopped: boolean;
}): HostedBackupManifest => {
  if (!input.writersStopped) throw new Error('restore_requires_writers_stopped');
  const manifest = verifyHostedBackup(input.source);
  const destination = resolve(input.destination);
  if (existsSync(join(destination, 'control.sqlite')))
    throw new Error('restore_requires_new_data_root');
  privateDirectory(destination);
  if (readdirSync(destination).some((name) => name !== 'deletion-ledger'))
    throw new Error('restore_requires_empty_data_root');
  for (const file of manifest.files) {
    const target = join(destination, file.path);
    privateDirectory(dirname(target));
    copyFileSync(join(input.source, file.path), target);
    chmodSync(target, 0o600);
    flushArtifact(target);
  }
  return manifest;
};
