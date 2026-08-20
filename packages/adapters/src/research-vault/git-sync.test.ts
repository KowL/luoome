import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GitResearchVaultSyncAdapter } from './git-sync.js';

const roots: string[] = [];

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const configureAuthor = (cwd: string): void => {
  git(cwd, ['config', 'user.name', 'Luoome Test']);
  git(cwd, ['config', 'user.email', 'test@luoome.invalid']);
};

const createFixture = (): {
  root: string;
  vault: string;
  publisher: string;
  backupRoot: string;
} => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-vault-git-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const vault = join(root, 'vault');
  const publisher = join(root, 'publisher');
  const backupRoot = join(root, 'backups');
  git(root, ['init', '--bare', '--initial-branch=main', origin]);
  git(root, ['clone', origin, vault]);
  configureAuthor(vault);
  mkdirSync(join(vault, 'Research'), { recursive: true });
  writeFileSync(join(vault, 'Research', 'initial.md'), '# Initial\n');
  git(vault, ['add', 'Research/initial.md']);
  git(vault, ['commit', '-m', 'initial']);
  git(vault, ['push', '--set-upstream', 'origin', 'main']);
  git(root, ['clone', origin, publisher]);
  configureAuthor(publisher);
  return { root, vault, publisher, backupRoot };
};

const publish = (publisher: string, name: string, content: string): void => {
  writeFileSync(join(publisher, 'Research', name), content);
  git(publisher, ['add', `Research/${name}`]);
  git(publisher, ['commit', '-m', `publish ${name}`]);
  git(publisher, ['push', 'origin', 'main']);
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('GitResearchVaultSyncAdapter', () => {
  it('使用真实 Git 创建 0600 bundle 备份并仅 fast-forward 更新干净工作树', async () => {
    const fixture = createFixture();
    publish(fixture.publisher, 'remote.md', '# Remote\n');
    const before = git(fixture.vault, ['rev-parse', 'HEAD']);
    const adapter = new GitResearchVaultSyncAdapter({
      vaultPath: fixture.vault,
      backupRoot: fixture.backupRoot,
    });

    const result = await adapter.pull({ timeoutMs: 10_000 });

    expect(result).toMatchObject({ ok: true, status: 'updated' });
    expect(git(fixture.vault, ['rev-parse', 'HEAD'])).not.toBe(before);
    expect(git(fixture.vault, ['status', '--porcelain=v1'])).toBe('');
    expect(readFileSync(join(fixture.vault, 'Research', 'remote.md'), 'utf8')).toBe('# Remote\n');
    const bundle = readdirSync(fixture.backupRoot, { recursive: true }).find((entry) =>
      String(entry).endsWith('.bundle'),
    );
    expect(bundle).toBeDefined();
    if (bundle === undefined) return;
    const bundlePath = join(fixture.backupRoot, String(bundle));
    expect(statSync(bundlePath).mode & 0o777).toBe(0o600);
    expect(git(fixture.vault, ['bundle', 'verify', bundlePath])).toContain(
      'The bundle records a complete history',
    );
  });

  it('工作树含未跟踪文件时在 fetch 前停止且不改变 HEAD', async () => {
    const fixture = createFixture();
    publish(fixture.publisher, 'remote.md', '# Remote\n');
    writeFileSync(join(fixture.vault, 'local-secret.md'), 'do not touch');
    const before = git(fixture.vault, ['rev-parse', 'HEAD']);
    const adapter = new GitResearchVaultSyncAdapter({
      vaultPath: fixture.vault,
      backupRoot: fixture.backupRoot,
    });

    const result = await adapter.pull({ timeoutMs: 10_000 });

    expect(result).toMatchObject({ ok: false, reason: 'dirty-worktree', recoverable: true });
    expect(git(fixture.vault, ['rev-parse', 'HEAD'])).toBe(before);
    expect(readFileSync(join(fixture.vault, 'local-secret.md'), 'utf8')).toBe('do not touch');
  });

  it('本地和 upstream 分叉时停止，不自动 reset、rebase、合并或创建备份', async () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.vault, 'Research', 'local.md'), '# Local\n');
    git(fixture.vault, ['add', 'Research/local.md']);
    git(fixture.vault, ['commit', '-m', 'local change']);
    const before = git(fixture.vault, ['rev-parse', 'HEAD']);
    publish(fixture.publisher, 'remote.md', '# Remote\n');
    const adapter = new GitResearchVaultSyncAdapter({
      vaultPath: fixture.vault,
      backupRoot: fixture.backupRoot,
    });

    const result = await adapter.pull({ timeoutMs: 10_000 });

    expect(result).toMatchObject({ ok: false, reason: 'diverged', recoverable: false });
    expect(git(fixture.vault, ['rev-parse', 'HEAD'])).toBe(before);
    expect(readFileSync(join(fixture.vault, 'Research', 'local.md'), 'utf8')).toBe('# Local\n');
    expect(
      readdirSync(fixture.backupRoot, { recursive: true }).some((entry) =>
        String(entry).endsWith('.bundle'),
      ),
    ).toBe(false);
  });

  it('预先取消时停止 fetch，且拒绝内嵌密码的远端 URL', async () => {
    const fixture = createFixture();
    const adapter = new GitResearchVaultSyncAdapter({
      vaultPath: fixture.vault,
      backupRoot: fixture.backupRoot,
    });
    const controller = new AbortController();
    controller.abort();
    expect(await adapter.pull({ timeoutMs: 10_000, signal: controller.signal })).toMatchObject({
      ok: false,
      reason: 'cancelled',
    });

    git(fixture.vault, [
      'remote',
      'set-url',
      'origin',
      'https://user:secret@example.invalid/x.git',
    ]);
    expect(await adapter.pull({ timeoutMs: 10_000 })).toMatchObject({
      ok: false,
      reason: 'unsafe-remote',
      recoverable: false,
    });
  });

  it('真实 Git fetch 超时时终止等待且不更新工作树', async () => {
    const fixture = createFixture();
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test port');
    git(fixture.vault, [
      'remote',
      'set-url',
      'origin',
      `ssh://git@127.0.0.1:${address.port}/vault.git`,
    ]);
    const before = git(fixture.vault, ['rev-parse', 'HEAD']);
    const adapter = new GitResearchVaultSyncAdapter({
      vaultPath: fixture.vault,
      backupRoot: fixture.backupRoot,
    });

    try {
      expect(await adapter.pull({ timeoutMs: 50 })).toMatchObject({
        ok: false,
        reason: 'timeout',
        recoverable: true,
      });
      expect(git(fixture.vault, ['rev-parse', 'HEAD'])).toBe(before);
      expect(git(fixture.vault, ['status', '--porcelain=v1'])).toBe('');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
