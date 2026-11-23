import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSessionBinding, AgentSessionBindingRepository } from '@luoome/core';
import { DshRuntimeControl } from './run-control.js';
import {
  collectExpiredDshSessions,
  deleteDshAccountSessions,
  dshSessionDirectoryName,
  safeDshSessionDirectory,
} from './session-store.js';

const NOW = new Date('2026-11-24T00:00:00Z');
const OLD = new Date('2026-09-01T00:00:00Z');
const roots: string[] = [];
const root = () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-session-store-'));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const binding = (overrides: Partial<AgentSessionBinding> = {}): AgentSessionBinding => ({
  conversationId: 'c1',
  accountId: 'account-1',
  agentDefinitionId: 'general',
  dshSessionId: 'session-1',
  profileHash: null,
  configHash: 'sha256:cfg',
  lastSyncedMessageId: null,
  settledDraftReceiptsCursor: null,
  status: 'active',
  contextMode: 'rebuilt-history',
  pendingRunId: null,
  pendingAssistantMessageId: null,
  pendingMessageId: null,
  pendingReceiptsCursor: null,
  pendingClaimedAt: null,
  updatedAt: NOW,
  ...overrides,
});

class FakeBindings implements AgentSessionBindingRepository {
  constructor(readonly rows: AgentSessionBinding[] = []) {}
  async findByConversation(conversationId: string): Promise<AgentSessionBinding | null> {
    return this.rows.find((row) => row.conversationId === conversationId) ?? null;
  }
  async list(options?: { readonly accountId?: string }): Promise<readonly AgentSessionBinding[]> {
    return this.rows.filter(
      (row) => options?.accountId === undefined || row.accountId === options.accountId,
    );
  }
  async save(): Promise<void> {}
  async claim(): Promise<boolean> {
    return true;
  }
  async commit(): Promise<boolean> {
    return true;
  }
  async release(): Promise<boolean> {
    return true;
  }
  async remove(conversationId: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.conversationId === conversationId);
    if (index >= 0) this.rows.splice(index, 1);
  }
}

const directoryFor = (sessionsRoot: string, row: AgentSessionBinding, mtime: Date) => {
  const directory = join(sessionsRoot, dshSessionDirectoryName(row.accountId, row.conversationId));
  mkdirSync(join(directory, 'sessions'), { recursive: true });
  writeFileSync(join(directory, 'sessions', 'log.jsonl'), '{"fixture":true}\n');
  utimesSync(directory, mtime, mtime);
  return directory;
};

const collect = (
  sessionsRoot: string,
  rows: AgentSessionBinding[],
  overrides: Partial<Parameters<typeof collectExpiredDshSessions>[0]> = {},
) =>
  collectExpiredDshSessions({
    repos: { agentSessionBinding: new FakeBindings(rows) },
    sessionsRoot,
    policy: { mode: 'enforce', retentionDays: 30 },
    now: NOW,
    ...overrides,
  });

describe('会话目录保留策略', () => {
  it('清理超过保留期且不是 active 的目录，保留期内的目录不动', async () => {
    const sessionsRoot = root();
    const stale = binding({ status: 'invalidated', dshSessionId: null });
    const orphan = binding({ conversationId: 'c2', status: 'interrupted' });
    const fresh = binding({ conversationId: 'c3', status: 'invalidated', dshSessionId: null });
    const staleDirectory = directoryFor(sessionsRoot, stale, OLD);
    directoryFor(sessionsRoot, orphan, OLD);
    const freshDirectory = directoryFor(sessionsRoot, fresh, NOW);
    const report = await collect(sessionsRoot, [stale, orphan, fresh]);
    expect(report.removed).toEqual(
      [stale, orphan]
        .map((row) => dshSessionDirectoryName(row.accountId, row.conversationId))
        .sort(),
    );
    expect(report.retained).toEqual([
      {
        name: dshSessionDirectoryName(fresh.accountId, fresh.conversationId),
        reason: 'retention',
      },
    ]);
    expect(readdirSync(sessionsRoot)).not.toContain(
      dshSessionDirectoryName(stale.accountId, stale.conversationId),
    );
    expect(readdirSync(sessionsRoot)).not.toContain(
      dshSessionDirectoryName(orphan.accountId, orphan.conversationId),
    );
    expect(readdirSync(freshDirectory)).toEqual(['sessions']);
    expect(staleDirectory).not.toBe(freshDirectory);
  });

  it('active 绑定、pending 认领与进程内在途 run 即使过期也不清理', async () => {
    const sessionsRoot = root();
    const activeBinding = binding({ conversationId: 'c1' });
    const pending = binding({
      conversationId: 'c2',
      status: 'interrupted',
      dshSessionId: null,
      pendingRunId: 'run-1',
      pendingAssistantMessageId: 'assistant_run-1',
      pendingClaimedAt: NOW,
    });
    const running = binding({ conversationId: 'c3', status: 'invalidated', dshSessionId: null });
    for (const row of [activeBinding, pending, running]) directoryFor(sessionsRoot, row, OLD);
    const report = await collect(sessionsRoot, [activeBinding, pending, running], {
      activeSessions: [{ accountId: 'account-1', conversationId: 'c3' }],
    });
    expect(report.removed).toEqual([]);
    expect(report.retained.map((entry) => entry.reason).sort()).toEqual([
      'active_binding',
      'active_run',
      'pending_claim',
    ]);
    expect(readdirSync(sessionsRoot)).toHaveLength(3);
  });

  it('dry-run 只报告不删除，off 完全不触碰文件系统', async () => {
    const sessionsRoot = root();
    const stale = binding({ status: 'invalidated', dshSessionId: null });
    directoryFor(sessionsRoot, stale, OLD);
    const dryRun = await collect(sessionsRoot, [stale], {
      policy: { mode: 'dry-run', retentionDays: 30 },
    });
    expect(dryRun.removed).toHaveLength(1);
    expect(readdirSync(sessionsRoot)).toHaveLength(1);
    const off = await collect(sessionsRoot, [stale], {
      policy: { mode: 'off', retentionDays: 30 },
      sessionsRoot: join(sessionsRoot, 'missing'),
    });
    expect(off).toEqual({ mode: 'off', scanned: 0, removed: [], retained: [], skipped: [] });
  });

  it('拒绝越界名称、符号链接和非会话目录，不会删除 root 外的目标', async () => {
    const sessionsRoot = root();
    const outside = root();
    const victim = join(outside, 'victim');
    mkdirSync(victim);
    writeFileSync(join(victim, 'keep.txt'), 'keep');
    const linkName = dshSessionDirectoryName('account-1', 'escape');
    symlinkSync(victim, join(sessionsRoot, linkName));
    writeFileSync(join(sessionsRoot, 'not-a-session'), 'x');
    expect(safeDshSessionDirectory(sessionsRoot, '../escape')).toBeNull();
    expect(safeDshSessionDirectory(sessionsRoot, linkName)).toBeNull();
    expect(safeDshSessionDirectory(sessionsRoot, 'not-a-session')).toBeNull();
    const report = await collect(sessionsRoot, []);
    expect(report.removed).toEqual([]);
    expect(report.skipped).toEqual(
      expect.arrayContaining([
        { name: linkName, reason: 'symlink' },
        { name: 'not-a-session', reason: 'unknown_directory' },
      ]),
    );
    expect(readdirSync(victim)).toEqual(['keep.txt']);
  });

  it('没有绑定的孤儿目录同样受保留期约束', async () => {
    const sessionsRoot = root();
    const name = dshSessionDirectoryName('account-x', 'gone');
    const directory = join(sessionsRoot, name);
    mkdirSync(directory);
    utimesSync(directory, OLD, OLD);
    const report = await collect(sessionsRoot, []);
    expect(report.removed).toEqual([name]);
  });
});

describe('账户删除时的会话清理', () => {
  const input = (sessionsRoot: string, rows: AgentSessionBinding[], control: DshRuntimeControl) => {
    const bindings = new FakeBindings(rows);
    return {
      bindings,
      args: {
        repos: { agentSessionBinding: bindings },
        sessionsRoot,
        accountId: 'account-1',
        gate: control,
        timeoutMs: 500,
      },
    };
  };

  it('排空后删除该账户的会话目录与绑定，并恢复闸门', async () => {
    const sessionsRoot = root();
    const own = binding();
    const other = binding({ conversationId: 'c9', accountId: 'account-2' });
    directoryFor(sessionsRoot, own, OLD);
    directoryFor(sessionsRoot, other, OLD);
    const control = new DshRuntimeControl();
    const { args, bindings } = input(sessionsRoot, [own, other], control);
    expect(await deleteDshAccountSessions(args)).toEqual({
      kind: 'removed',
      bindings: 1,
      directories: 1,
    });
    expect(bindings.rows).toEqual([other]);
    expect(readdirSync(sessionsRoot)).toEqual([
      dshSessionDirectoryName(other.accountId, other.conversationId),
    ]);
    expect(control.status().blockedAccounts).toEqual([]);
    expect(
      control.tryEnter({ runId: 'after', accountId: 'account-1', conversationId: 'c2' }),
    ).toMatchObject({ kind: 'admitted' });
  });

  it('在途 run 未排空时不删除任何目录或绑定，并返回明确状态', async () => {
    const sessionsRoot = root();
    const own = binding();
    directoryFor(sessionsRoot, own, OLD);
    const control = new DshRuntimeControl();
    const running = control.tryEnter({
      runId: 'run-in-flight',
      accountId: 'account-1',
      conversationId: 'c1',
    });
    if (running.kind !== 'admitted') throw new Error('expected admitted');
    const { args, bindings } = input(sessionsRoot, [own], control);
    expect(await deleteDshAccountSessions(args)).toEqual({ kind: 'not_drained', activeRuns: 1 });
    expect(bindings.rows).toHaveLength(1);
    expect(readdirSync(sessionsRoot)).toHaveLength(1);
    expect(control.status().blockedAccounts).toEqual([]);
    running.release();
  });
});
