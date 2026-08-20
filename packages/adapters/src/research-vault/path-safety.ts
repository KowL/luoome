import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

export const isPathWithin = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export const resolveSafeVaultRoot = (vaultPath: string): string => {
  if (!isAbsolute(vaultPath)) throw new Error('vault path must be absolute');
  const root = realpathSync(vaultPath);
  const filesystemRoot = parse(root).root;
  const currentProject = realpathSync(process.cwd());
  if (
    root === filesystemRoot ||
    root === realpathSync(homedir()) ||
    root === currentProject ||
    basename(root) === '.obsidian'
  ) {
    throw new Error('vault path is too broad or reserved');
  }
  return root;
};

export const resolveThroughExistingAncestor = (path: string): string => {
  const absolute = resolve(path);
  let ancestor = absolute;
  const missingSegments: string[] = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('path has no existing ancestor');
    missingSegments.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missingSegments);
};

export const resolveBackupRootOutsideVault = (vaultRoot: string, backupRoot: string): string => {
  const resolved = resolveThroughExistingAncestor(backupRoot);
  if (isPathWithin(vaultRoot, resolved)) {
    throw new Error('backup root must be outside vault');
  }
  return resolved;
};
