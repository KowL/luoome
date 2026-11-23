/**
 * DSH 模型调用的服务端原子账本（docs/ddd/dsh-plugin-platform-design.md §9，R05/AC06）。
 *
 * 每一次供应商 attempt 在发出前先在同一账本预占额度，结束后按真实 usage 结算：
 * 重试、隐式请求和子调用都走同一条路径，因此无法绕过门禁。取消、断流或进程崩溃
 * 无法确认 usage 时保留预占并记为 unknown，绝不把未知成本归零。
 *
 * 账本只在 Web 进程内（单宿主）；货币换算与供应商对账不在本切片内，只按 token 计。
 */

export interface ModelAttemptUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelBudgetPolicy {
  /** 每个窗口内允许消耗的总 token（预占与已结算共用）。 */
  readonly maxTokens: number;
  /** 每个窗口内允许的供应商请求次数（含重试）。 */
  readonly maxRequests: number;
  readonly windowMs: number;
}

export type ModelBudgetDecision =
  | { readonly kind: 'admitted'; readonly attemptId: string; readonly reservedTokens: number }
  | { readonly kind: 'exhausted'; readonly reason: 'tokens' | 'requests' };

export interface ModelBudgetSnapshot {
  readonly accountId: string;
  readonly windowStartedAt: Date;
  readonly tokensUsed: number;
  readonly tokensReserved: number;
  readonly tokensUnknown: number;
  readonly requests: number;
  readonly unknownAttempts: number;
  readonly maxTokens: number;
  readonly maxRequests: number;
}

interface BudgetState {
  windowStartedAt: number;
  settledTokens: number;
  unknownTokens: number;
  unknownAttempts: number;
  requests: number;
  readonly inFlight: Map<string, number>;
}

export class ModelBudgetLedger {
  readonly #accounts = new Map<string, BudgetState>();
  readonly #attemptAccount = new Map<string, string>();
  #sequence = 0;

  constructor(
    private readonly policy: ModelBudgetPolicy,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!(policy.maxTokens > 0) || !(policy.maxRequests > 0) || !(policy.windowMs > 0))
      throw new Error('Model budget limits must be positive');
  }

  #state(accountId: string): BudgetState {
    const now = this.clock().getTime();
    const existing = this.#accounts.get(accountId);
    if (existing !== undefined && now - existing.windowStartedAt < this.policy.windowMs)
      return existing;
    const next: BudgetState = {
      windowStartedAt: now,
      settledTokens: 0,
      unknownTokens: 0,
      unknownAttempts: 0,
      requests: 0,
      inFlight: new Map(),
    };
    // 窗口滚动只清账，不丢弃仍在途的预占。
    if (existing !== undefined)
      for (const [id, tokens] of existing.inFlight) next.inFlight.set(id, tokens);
    this.#accounts.set(accountId, next);
    return next;
  }

  #reserved(state: BudgetState): number {
    let total = 0;
    for (const tokens of state.inFlight.values()) total += tokens;
    return total;
  }

  /** 同步检查并预占；JS 单线程内的读写是原子的，过期账本不会被并发翻倍。 */
  admit(input: {
    readonly accountId: string;
    readonly runId: string;
    readonly maxTokens: number;
  }): ModelBudgetDecision {
    const state = this.#state(input.accountId);
    if (state.requests >= this.policy.maxRequests) return { kind: 'exhausted', reason: 'requests' };
    const remaining = Math.max(
      0,
      this.policy.maxTokens - state.settledTokens - state.unknownTokens - this.#reserved(state),
    );
    if (remaining <= 0) return { kind: 'exhausted', reason: 'tokens' };
    const reservedTokens = Math.min(Math.max(1, Math.trunc(input.maxTokens)), remaining);
    this.#sequence += 1;
    const attemptId = `${input.runId}#${this.#sequence}`;
    state.inFlight.set(attemptId, reservedTokens);
    state.requests += 1;
    this.#attemptAccount.set(attemptId, input.accountId);
    return { kind: 'admitted', attemptId, reservedTokens };
  }

  /** 已知 usage 按实际值结算；null 表示无法确认成本，保留预占并标记 unknown。 */
  settle(attemptId: string, usage: ModelAttemptUsage | null): void {
    const accountId = this.#attemptAccount.get(attemptId);
    if (accountId === undefined) return;
    this.#attemptAccount.delete(attemptId);
    const state = this.#accounts.get(accountId);
    const reserved = state?.inFlight.get(attemptId);
    if (state === undefined || reserved === undefined) return;
    state.inFlight.delete(attemptId);
    if (usage === null) {
      state.unknownTokens += reserved;
      state.unknownAttempts += 1;
      return;
    }
    state.settledTokens += Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
  }

  snapshot(accountId: string): ModelBudgetSnapshot {
    const state = this.#state(accountId);
    return {
      accountId,
      windowStartedAt: new Date(state.windowStartedAt),
      tokensUsed: state.settledTokens + state.unknownTokens,
      tokensReserved: this.#reserved(state),
      tokensUnknown: state.unknownTokens,
      requests: state.requests,
      unknownAttempts: state.unknownAttempts,
      maxTokens: this.policy.maxTokens,
      maxRequests: this.policy.maxRequests,
    };
  }
}

const ledgers = new Map<string, ModelBudgetLedger>();

/** 同一策略在进程内复用同一账本；保存 AI 设置重建 runtime 不会重置预算与未知成本。 */
export const sharedModelBudgetLedger = (policy: ModelBudgetPolicy): ModelBudgetLedger => {
  const key = `${policy.maxTokens}:${policy.maxRequests}:${policy.windowMs}`;
  let ledger = ledgers.get(key);
  if (ledger === undefined) {
    ledger = new ModelBudgetLedger(policy);
    ledgers.set(key, ledger);
  }
  return ledger;
};
