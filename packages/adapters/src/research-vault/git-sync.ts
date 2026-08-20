import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type {
  ResearchVaultGitPullFailureReason,
  ResearchVaultGitPullResult,
  ResearchVaultGitSyncAdapterLike,
} from '@luoome/core';

interface GitCommandResult {
  readonly status: 'ok' | 'error' | 'spawn-error' | 'timeout' | 'cancelled';
  readonly exitCode?: number;
  readonly stdout: string;
}

interface RunGitOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly cancellable?: boolean;
}

const MAX_CAPTURE_BYTES = 1024 * 1024;

const capture = (chunks: Buffer[], size: number, chunk: Buffer): number => {
  if (size >= MAX_CAPTURE_BYTES) return size;
  const remaining = MAX_CAPTURE_BYTES - size;
  const value = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  chunks.push(value);
  return size + value.length;
};

const runGit = (
  gitBin: string,
  vaultRoot: string,
  args: readonly string[],
  options: RunGitOptions,
): Promise<GitCommandResult> => {
  if (options.cancellable !== false && options.signal?.aborted === true) {
    return Promise.resolve({ status: 'cancelled', stdout: '' });
  }
  return new Promise((resolveResult) => {
    const detached = process.platform !== 'win32';
    const stdout: Buffer[] = [];
    let stdoutSize = 0;
    let stopReason: 'timeout' | 'cancelled' | undefined;
    let settled = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(gitBin, ['-C', vaultRoot, ...args], {
      detached,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const terminate = (signal: NodeJS.Signals): void => {
      if (detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // 进程组可能已退出；再尝试直接终止 Git 进程。
        }
      }
      child.kill(signal);
    };
    const finish = (result: GitCommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (forceKill !== undefined) clearTimeout(forceKill);
      options.signal?.removeEventListener('abort', cancel);
      resolveResult(result);
    };
    const stop = (reason: 'timeout' | 'cancelled'): void => {
      if (settled || stopReason !== undefined) return;
      stopReason = reason;
      terminate('SIGTERM');
      forceKill = setTimeout(() => terminate('SIGKILL'), 1_000);
    };
    const cancel = (): void => {
      if (options.cancellable !== false) stop('cancelled');
    };
    if (options.timeoutMs > 0) timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutSize = capture(stdout, stdoutSize, chunk);
    });
    // stderr 故意不收集：Git remote 诊断可能包含带凭证的 URL。
    child.stderr.resume();
    child.on('error', () => finish({ status: 'spawn-error', stdout: '' }));
    child.on('close', (code) => {
      const text = Buffer.concat(stdout).toString('utf8');
      if (stopReason !== undefined) {
        finish({ status: stopReason, stdout: text });
        return;
      }
      finish({
        status: code === 0 ? 'ok' : 'error',
        ...(code === null ? {} : { exitCode: code }),
        stdout: text,
      });
    });
  });
};

const failure = (
  reason: ResearchVaultGitPullFailureReason,
  message: string,
  recoverable: boolean,
): ResearchVaultGitPullResult => ({ ok: false, reason, message, recoverable });

const cleanOutput = (value: string): string => value.replaceAll('\0', '').trim();

const remoteIsSafe = (remoteUrl: string): boolean => {
  if (/\r|\n|\0/.test(remoteUrl) || remoteUrl.startsWith('-') || remoteUrl.startsWith('ext::')) {
    return false;
  }
  if (/^https?:\/\//i.test(remoteUrl)) {
    try {
      const parsed = new URL(remoteUrl);
      return (
        parsed.protocol === 'https:' && parsed.username.length === 0 && parsed.password.length === 0
      );
    } catch {
      return false;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl)) {
    try {
      const parsed = new URL(remoteUrl);
      return parsed.protocol === 'ssh:' || parsed.protocol === 'file:';
    } catch {
      return false;
    }
  }
  return (
    isAbsolute(remoteUrl) ||
    remoteUrl.startsWith('./') ||
    remoteUrl.startsWith('../') ||
    /^[^\s@:]+@[^\s:]+:.+$/.test(remoteUrl)
  );
};

export interface GitResearchVaultSyncOptions {
  readonly vaultPath: string;
  readonly backupRoot: string;
  readonly gitBin?: string;
}

export class GitResearchVaultSyncAdapter implements ResearchVaultGitSyncAdapterLike {
  readonly name = 'research-vault-git-sync';
  readonly provider = 'git' as const;
  private readonly vaultRoot: string;
  private readonly backupRoot: string;
  private readonly hooksRoot: string;
  private readonly gitBin: string;

  constructor(options: GitResearchVaultSyncOptions) {
    this.vaultRoot = realpathSync(options.vaultPath);
    this.backupRoot = resolve(options.backupRoot);
    this.hooksRoot = join(this.backupRoot, '.disabled-hooks');
    this.gitBin = options.gitBin ?? 'git';
  }

  private command(args: readonly string[], options: RunGitOptions): Promise<GitCommandResult> {
    return runGit(this.gitBin, this.vaultRoot, args, options);
  }

  private async checkClean(timeoutMs: number): Promise<ResearchVaultGitPullResult | null> {
    const status = await this.command(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      timeoutMs,
      cancellable: false,
    });
    if (status.status === 'spawn-error') {
      return failure('git-unavailable', 'Git 命令不可用', false);
    }
    if (status.status !== 'ok') {
      return failure('not-git-repository', 'Vault 不是可读取的 Git 工作树', false);
    }
    if (status.stdout.length > 0) {
      return failure('dirty-worktree', 'Vault Git 工作树存在未提交或未跟踪改动，已停止同步', true);
    }
    return null;
  }

  private async operationInProgress(timeoutMs: number): Promise<boolean> {
    for (const ref of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      const result = await this.command(['rev-parse', '-q', '--verify', ref], {
        timeoutMs,
        cancellable: false,
      });
      if (result.status === 'ok') return true;
    }
    const gitDir = await this.command(['rev-parse', '--absolute-git-dir'], {
      timeoutMs,
      cancellable: false,
    });
    if (gitDir.status !== 'ok') return true;
    const root = cleanOutput(gitDir.stdout);
    return ['rebase-apply', 'rebase-merge', 'BISECT_LOG'].some((name) =>
      existsSync(join(root, name)),
    );
  }

  private async createBackup(timeoutMs: number): Promise<string | null> {
    mkdirSync(this.backupRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.hooksRoot, { recursive: true, mode: 0o700 });
    const vaultKey = createHash('sha256').update(this.vaultRoot).digest('hex').slice(0, 16);
    const directory = join(this.backupRoot, vaultKey);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const backupId = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const target = join(directory, `${backupId}.bundle`);
    const temporary = `${target}.tmp-${process.pid}`;
    const bundled = await this.command(['bundle', 'create', temporary, 'HEAD'], {
      timeoutMs,
      cancellable: false,
    });
    if (bundled.status !== 'ok') {
      if (existsSync(temporary)) unlinkSync(temporary);
      return null;
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    chmodSync(target, 0o600);
    return backupId;
  }

  async pull(input: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  }): Promise<ResearchVaultGitPullResult> {
    const commandTimeoutMs = Math.max(1_000, Math.min(input.timeoutMs, 300_000));
    try {
      const topLevel = await this.command(['rev-parse', '--show-toplevel'], {
        timeoutMs: commandTimeoutMs,
        cancellable: false,
      });
      if (topLevel.status === 'spawn-error') {
        return failure('git-unavailable', 'Git 命令不可用', false);
      }
      if (topLevel.status !== 'ok') {
        return failure('not-git-repository', 'Vault 不是 Git 工作树', false);
      }
      const repositoryRoot = realpathSync(cleanOutput(topLevel.stdout));
      if (repositoryRoot !== this.vaultRoot) {
        return failure('not-git-repository', 'Vault 必须是独立 Git 工作树根目录', false);
      }
      const dirty = await this.checkClean(commandTimeoutMs);
      if (dirty !== null) return dirty;
      if (await this.operationInProgress(commandTimeoutMs)) {
        return failure('operation-in-progress', 'Vault Git 工作树存在未完成操作，已停止同步', true);
      }

      const branchResult = await this.command(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        timeoutMs: commandTimeoutMs,
        cancellable: false,
      });
      if (branchResult.status !== 'ok') {
        return failure('detached-head', 'Vault Git 工作树处于 detached HEAD，已停止同步', true);
      }
      const branch = cleanOutput(branchResult.stdout);
      const upstream = await this.command(
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
        { timeoutMs: commandTimeoutMs, cancellable: false },
      );
      if (upstream.status !== 'ok') {
        return failure('missing-upstream', '当前 Vault 分支未配置 upstream', true);
      }
      const remoteResult = await this.command(['config', '--get', `branch.${branch}.remote`], {
        timeoutMs: commandTimeoutMs,
        cancellable: false,
      });
      const remote = cleanOutput(remoteResult.stdout);
      if (remoteResult.status !== 'ok' || remote.length === 0 || remote === '.') {
        return failure('missing-upstream', '当前 Vault 分支未配置可拉取的远端', true);
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote)) {
        return failure('unsafe-remote', 'Vault Git remote 名称不安全，已拒绝执行', false);
      }
      const uploadPack = await this.command(['config', '--get', `remote.${remote}.uploadpack`], {
        timeoutMs: commandTimeoutMs,
        cancellable: false,
      });
      if (uploadPack.status === 'ok' && cleanOutput(uploadPack.stdout).length > 0) {
        return failure(
          'unsafe-remote',
          'Vault Git remote 配置了自定义 uploadpack，已拒绝执行',
          false,
        );
      }
      const remoteUrlResult = await this.command(['remote', 'get-url', remote], {
        timeoutMs: commandTimeoutMs,
        cancellable: false,
      });
      if (remoteUrlResult.status !== 'ok' || !remoteIsSafe(cleanOutput(remoteUrlResult.stdout))) {
        return failure(
          'unsafe-remote',
          'Vault Git remote 必须使用 HTTPS、SSH 或本地文件路径，且 HTTPS 不得内嵌认证信息',
          false,
        );
      }

      mkdirSync(this.hooksRoot, { recursive: true, mode: 0o700 });
      const fetched = await this.command(
        [
          '-c',
          `core.hooksPath=${this.hooksRoot}`,
          '-c',
          'submodule.recurse=false',
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          '--',
          remote,
        ],
        {
          timeoutMs: input.timeoutMs,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      if (fetched.status === 'cancelled') {
        return failure('cancelled', 'Git fetch 已取消；工作树未更新', true);
      }
      if (fetched.status === 'timeout') {
        return failure('timeout', 'Git fetch 超时；工作树未更新', true);
      }
      if (fetched.status !== 'ok') {
        return failure('fetch-failed', 'Git fetch 失败；请检查远端和本机凭证管理器', true);
      }
      if (input.signal?.aborted === true) {
        return failure('cancelled', 'Git fetch 后收到取消请求；工作树未更新', true);
      }

      const dirtyAfterFetch = await this.checkClean(commandTimeoutMs);
      if (dirtyAfterFetch !== null) return dirtyAfterFetch;
      if (await this.operationInProgress(commandTimeoutMs)) {
        return failure('operation-in-progress', 'Git fetch 后检测到未完成操作，已停止同步', true);
      }
      const before = await this.command(['rev-parse', 'HEAD'], {
        timeoutMs: commandTimeoutMs,
        cancellable: false,
      });
      const after = await this.command(['rev-parse', '@{upstream}'], {
        timeoutMs: commandTimeoutMs,
        cancellable: false,
      });
      if (before.status !== 'ok' || after.status !== 'ok') {
        return failure('missing-upstream', '无法解析 Vault 本地或 upstream 提交', true);
      }
      const beforeHead = cleanOutput(before.stdout);
      const upstreamHead = cleanOutput(after.stdout);
      if (beforeHead === upstreamHead) return { ok: true, status: 'up-to-date' };

      const canFastForward = await this.command(
        ['merge-base', '--is-ancestor', beforeHead, upstreamHead],
        { timeoutMs: commandTimeoutMs, cancellable: false },
      );
      if (canFastForward.status !== 'ok') {
        const remoteBehind = await this.command(
          ['merge-base', '--is-ancestor', upstreamHead, beforeHead],
          { timeoutMs: commandTimeoutMs, cancellable: false },
        );
        if (remoteBehind.status === 'ok') return { ok: true, status: 'up-to-date' };
        return failure('diverged', 'Vault 本地分支与 upstream 已分叉，拒绝自动合并', false);
      }

      const backupId = await this.createBackup(commandTimeoutMs);
      if (backupId === null) {
        return failure('backup-failed', '创建 pull 前 Git bundle 备份失败，工作树未更新', true);
      }
      // 进入本地 fast-forward 后不再响应取消，避免信号中断 checkout 留下半更新工作树。
      const integrated = await this.command(
        [
          '-c',
          `core.hooksPath=${this.hooksRoot}`,
          '-c',
          'submodule.recurse=false',
          'merge',
          '--ff-only',
          '--no-edit',
          upstreamHead,
        ],
        { timeoutMs: 0, cancellable: false },
      );
      if (integrated.status !== 'ok') {
        return failure(
          'integrate-failed',
          `Git fast-forward 失败；备份 ${backupId} 已保留，未执行 reset/rebase`,
          false,
        );
      }
      const finalDirty = await this.checkClean(commandTimeoutMs);
      if (finalDirty !== null) {
        return failure(
          'integrate-failed',
          `Git fast-forward 后工作树非干净状态；备份 ${backupId} 已保留，已停止索引`,
          false,
        );
      }
      return { ok: true, status: 'updated', backupId };
    } catch {
      return failure('integrate-failed', 'Git 同步发生未预期错误；未执行自动恢复', false);
    }
  }
}
