import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { RepositoryRegistry } from '@luoome/core';

/**
 * DSH 持久会话目录的命名、保留策略与账户清理（docs/ddd/dsh-plugin-platform-design.md §10）。
 *
 * Host 把 SDK 会话日志写在 `$LUOOME_HOME/dsh-sessions/<hash>`；目录落在私人数据里，
 * 需要可审计的保留策略和删除路径。这里只做保守清理：默认关闭，active/在途一律不动，
 * 目录名必须匹配会话哈希，任何越界或符号链接都拒绝。
 */

const SESSION_DIRECTORY_PATTERN = /^[a-f0-9]{32}$/;

/** 会话目录名：与 chat-runtime 注入 Host 的 sessionHome 必须一致。 */
export const dshSessionDirectoryName = (accountId: string, conversationId: string): string =>
  createHash('sha256').update(`${accountId}:${conversationId}`).digest('hex').slice(0, 32);

export type DshSessionRetentionMode = 'off' | 'dry-run' | 'enforce';

export interface DshSessionRetentionPolicy {
  readonly mode: DshSessionRetentionMode;
  readonly retentionDays: number;
}

export type DshSessionSkipReason = 'unknown_directory' | 'symlink' | 'outside_root' | 'unreadable';

export type DshSessionRetainReason =
  | 'active_run'
  | 'pending_claim'
  | 'active_binding'
  | 'retention'
  | 'remove_failed';

export interface DshSessionRetentionReport {
  readonly mode: DshSessionRetentionMode;
  readonly scanned: number;
  readonly removed: readonly string[];
  readonly retained: readonly { readonly name: string; readonly reason: DshSessionRetainReason }[];
  readonly skipped: readonly { readonly name: string; readonly reason: DshSessionSkipReason }[];
}

const inside = (root: string, candidate: string): boolean => candidate.startsWith(`${root}${sep}`);

/**
 * 解析一个会话目录的绝对路径；越界、符号链接或非会话命名返回 null。
 * 先 realpath 根目录再校验子项，避免 `..` 与符号链接把删除目标带出 sessionsRoot。
 */
export const safeDshSessionDirectory = (sessionsRoot: string, name: string): string | null => {
  if (!isAbsolute(sessionsRoot) || !SESSION_DIRECTORY_PATTERN.test(name)) return null;
  const candidate = resolve(sessionsRoot, name);
  try {
    const root = realpathSync(sessionsRoot);
    const entry = lstatSync(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    if (!inside(root, realpathSync(candidate))) return null;
  } catch {
    return null;
  }
  return candidate;
};

const EMPTY_REPORT = (mode: DshSessionRetentionMode): DshSessionRetentionReport => ({
  mode,
  scanned: 0,
  removed: [],
  retained: [],
  skipped: [],
});

export interface CollectDshSessionsInput {
  readonly repos: Pick<RepositoryRegistry, 'agentSessionBinding'>;
  readonly sessionsRoot: string;
  readonly policy: DshSessionRetentionPolicy;
  /** 进程内仍有租约的会话；即使超过保留期也不清理。 */
  readonly activeSessions?: readonly {
    readonly accountId: string;
    readonly conversationId: string;
  }[];
  readonly now?: Date;
}

/**
 * 按保留策略清理会话目录。
 *
 * 保守规则：active 绑定、存在 pending 认领、进程内有在途 run 的目录永不删除；
 * 其余目录只有超过保留期才进入删除范围。`dry-run` 只报告，`off` 不触碰文件系统。
 */
export const collectExpiredDshSessions = async (
  input: CollectDshSessionsInput,
): Promise<DshSessionRetentionReport> => {
  const { mode, retentionDays } = input.policy;
  if (mode === 'off') return EMPTY_REPORT(mode);
  let names: string[];
  try {
    names = readdirSync(input.sessionsRoot).sort();
  } catch {
    return EMPTY_REPORT(mode);
  }
  const now = input.now ?? new Date();
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const bindings = await input.repos.agentSessionBinding.list();
  const byDirectory = new Map(
    bindings.map((binding) => [
      dshSessionDirectoryName(binding.accountId, binding.conversationId),
      binding,
    ]),
  );
  const active = new Set(
    (input.activeSessions ?? []).map((session) =>
      dshSessionDirectoryName(session.accountId, session.conversationId),
    ),
  );

  const removed: string[] = [];
  const retained: { name: string; reason: DshSessionRetainReason }[] = [];
  const skipped: { name: string; reason: DshSessionSkipReason }[] = [];
  let scanned = 0;
  for (const name of names) {
    if (!SESSION_DIRECTORY_PATTERN.test(name)) {
      skipped.push({ name, reason: 'unknown_directory' });
      continue;
    }
    let entry: ReturnType<typeof lstatSync>;
    try {
      entry = lstatSync(resolve(input.sessionsRoot, name));
    } catch {
      skipped.push({ name, reason: 'unreadable' });
      continue;
    }
    if (entry.isSymbolicLink()) {
      skipped.push({ name, reason: 'symlink' });
      continue;
    }
    if (!entry.isDirectory()) {
      skipped.push({ name, reason: 'unknown_directory' });
      continue;
    }
    const directory = safeDshSessionDirectory(input.sessionsRoot, name);
    if (directory === null) {
      skipped.push({ name, reason: 'outside_root' });
      continue;
    }
    scanned += 1;
    if (active.has(name)) {
      retained.push({ name, reason: 'active_run' });
      continue;
    }
    const binding = byDirectory.get(name);
    if (binding !== undefined && binding.pendingRunId !== null) {
      retained.push({ name, reason: 'pending_claim' });
      continue;
    }
    if (binding?.status === 'active') {
      retained.push({ name, reason: 'active_binding' });
      continue;
    }
    if (entry.mtimeMs > cutoff) {
      retained.push({ name, reason: 'retention' });
      continue;
    }
    if (mode === 'dry-run') {
      removed.push(name);
      continue;
    }
    try {
      rmSync(directory, { recursive: true });
      removed.push(name);
    } catch {
      retained.push({ name, reason: 'remove_failed' });
    }
  }
  return { mode, scanned, removed, retained, skipped };
};

export type DshAccountSessionDeletion =
  | { readonly kind: 'removed'; readonly bindings: number; readonly directories: number }
  | { readonly kind: 'not_drained'; readonly activeRuns: number };

/** 账户级运行闸门：阻断新 run + 等待在途排空。`DshRuntimeControl` 可直接满足。 */
export interface DshAccountSessionGate {
  blockAccount(accountId: string): void;
  unblockAccount(accountId: string): void;
  waitForAccountIdle(accountId: string, timeoutMs: number): Promise<boolean>;
  activeRuns(accountId: string): number;
}

export interface DeleteDshAccountSessionsInput {
  readonly repos: Pick<RepositoryRegistry, 'agentSessionBinding'>;
  readonly sessionsRoot: string;
  readonly accountId: string;
  /** 闸门先阻断该账户，再等待在途 run 排空；未排空时不删任何东西。 */
  readonly gate: DshAccountSessionGate;
  readonly timeoutMs: number;
}

/**
 * 账户删除时的会话清理：阻断新 run → 等在途 run 排空 → 删目录 → 删绑定。
 * 未确认排空时保留全部会话数据，返回明确状态，避免删除仍在写的会话日志。
 */
export const deleteDshAccountSessions = async (
  input: DeleteDshAccountSessionsInput,
): Promise<DshAccountSessionDeletion> => {
  const bindings = await input.repos.agentSessionBinding.list({ accountId: input.accountId });
  input.gate.blockAccount(input.accountId);
  try {
    const drained = await input.gate.waitForAccountIdle(input.accountId, input.timeoutMs);
    if (!drained)
      return { kind: 'not_drained', activeRuns: input.gate.activeRuns(input.accountId) };
    let directories = 0;
    for (const binding of bindings) {
      const name = dshSessionDirectoryName(binding.accountId, binding.conversationId);
      const directory = safeDshSessionDirectory(input.sessionsRoot, name);
      if (directory === null) continue;
      try {
        rmSync(directory, { recursive: true });
        directories += 1;
      } catch {
        /* 目录已消失或不可删：不阻断绑定清理。 */
      }
    }
    for (const binding of bindings)
      await input.repos.agentSessionBinding.remove(binding.conversationId);
    return { kind: 'removed', bindings: bindings.length, directories };
  } finally {
    input.gate.unblockAccount(input.accountId);
  }
};
