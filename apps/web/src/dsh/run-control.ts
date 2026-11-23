/**
 * DSH 运行准入闸门（docs/ddd/dsh-plugin-platform-design.md §5.2、§10）。
 *
 * 升级/维护时先停止接收新 run，再等待在途 run 排空；排空期间新请求得到确定错误，
 * 不会静默排队或落到第二个实例。账户删除复用同一闸门：先阻断该账户，再等它在途
 * run 退出，确认后才允许清理会话目录。
 *
 * 状态只在 Web 进程内，不做多宿主协调。
 */

export interface DshRunIdentity {
  readonly runId: string;
  readonly accountId: string;
  readonly conversationId: string;
}

export type DshRunRejection =
  | { readonly kind: 'draining'; readonly message: string }
  | { readonly kind: 'account_blocked'; readonly message: string };

export interface DshRunAdmission {
  readonly kind: 'admitted';
  readonly runId: string;
  readonly release: () => void;
}

export interface DshRuntimeControlStatus {
  readonly accepting: boolean;
  readonly drainReason: string | null;
  readonly activeRuns: number;
  readonly blockedAccounts: readonly string[];
}

const POLL_INTERVAL_MS = 10;

const waitUntil = async (idle: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (!idle()) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return true;
};

export class DshRuntimeControl {
  #drainReason: string | null = null;
  readonly #blockedAccounts = new Set<string>();
  readonly #active = new Map<string, { accountId: string; conversationId: string }>();

  constructor(private readonly polling: typeof waitUntil = waitUntil) {}

  /** 停止接收新 run；已在途 run 继续执行到自己的终态。 */
  beginDrain(reason = 'maintenance'): { readonly reason: string; readonly activeRuns: number } {
    this.#drainReason = reason;
    return { reason, activeRuns: this.#active.size };
  }

  resume(): void {
    this.#drainReason = null;
  }

  blockAccount(accountId: string): void {
    this.#blockedAccounts.add(accountId);
  }

  unblockAccount(accountId: string): void {
    this.#blockedAccounts.delete(accountId);
  }

  tryEnter(identity: DshRunIdentity): DshRunAdmission | DshRunRejection {
    if (this.#drainReason !== null)
      return {
        kind: 'draining',
        message: `DSH 运行时正在排空（${this.#drainReason}），新请求暂不可用，请稍后再试。`,
      };
    if (this.#blockedAccounts.has(identity.accountId))
      return { kind: 'account_blocked', message: '该账户的 DSH 会话正在被清理，暂不接受新请求。' };
    this.#active.set(identity.runId, {
      accountId: identity.accountId,
      conversationId: identity.conversationId,
    });
    let released = false;
    return {
      kind: 'admitted',
      runId: identity.runId,
      release: () => {
        if (released) return;
        released = true;
        this.#active.delete(identity.runId);
      },
    };
  }

  /** 仍在运行的会话身份；会话目录保留策略用它避免删除在途会话。 */
  activeSessions(): readonly { accountId: string; conversationId: string }[] {
    return [...this.#active.values()].map((value) => ({ ...value }));
  }

  activeRuns(accountId?: string): number {
    if (accountId === undefined) return this.#active.size;
    return [...this.#active.values()].filter((value) => value.accountId === accountId).length;
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    return this.polling(() => this.#active.size === 0, timeoutMs);
  }

  waitForAccountIdle(accountId: string, timeoutMs: number): Promise<boolean> {
    return this.polling(() => this.activeRuns(accountId) === 0, timeoutMs);
  }

  status(): DshRuntimeControlStatus {
    return {
      accepting: this.#drainReason === null,
      drainReason: this.#drainReason,
      activeRuns: this.#active.size,
      blockedAccounts: [...this.#blockedAccounts].sort(),
    };
  }
}
