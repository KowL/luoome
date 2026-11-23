import { createHash } from 'node:crypto';

/**
 * DSH 运行时灰度门控（R13 最小切片）。
 *
 * DSH 是否对某个账户启用由显式开关、账户 allowlist 和稳定百分比哈希决定；
 * 未命中的请求得到确定拒绝，不会自动落到另一个运行时重跑。关闭开关即可一键回退
 * （新请求不再进入 DSH），已在途的执行按自己的终态收尾。
 */

export interface DshRolloutPolicy {
  readonly enabled: boolean;
  readonly accountAllowlist: readonly string[];
  /** 0–100；按 accountId 稳定哈希分桶，跨进程/重启结果一致。 */
  readonly percent: number;
}

export const CLOSED_DSH_ROLLOUT: DshRolloutPolicy = {
  enabled: false,
  accountAllowlist: [],
  percent: 0,
};

/** 稳定分桶：同一 accountId 永远落在同一个 0–99 桶。 */
export const dshRolloutBucket = (accountId: string): number =>
  createHash('sha256').update(accountId).digest().readUInt32BE(0) % 100;

export const dshRolloutAllows = (policy: DshRolloutPolicy, accountId: string): boolean => {
  if (!policy.enabled) return false;
  if (policy.accountAllowlist.includes(accountId)) return true;
  if (policy.percent >= 100) return true;
  if (policy.percent <= 0) return false;
  return dshRolloutBucket(accountId) < policy.percent;
};

export class DshRolloutGate {
  #policy: DshRolloutPolicy;

  constructor(policy: DshRolloutPolicy = CLOSED_DSH_ROLLOUT) {
    this.#policy = Object.freeze({
      ...policy,
      accountAllowlist: Object.freeze([...policy.accountAllowlist]),
    });
  }

  get policy(): DshRolloutPolicy {
    return this.#policy;
  }

  /** 回退/放量都走这里；只影响后续请求。 */
  update(policy: DshRolloutPolicy): void {
    this.#policy = Object.freeze({
      ...policy,
      accountAllowlist: Object.freeze([...policy.accountAllowlist]),
    });
  }

  allows(accountId: string): boolean {
    return dshRolloutAllows(this.#policy, accountId);
  }
}

let shared: DshRolloutGate | undefined;

/** 进程内共享同一门：保存 AI 设置重建 runtime 不会丢掉已生效的灰度/回退状态。 */
export const sharedDshRolloutGate = (policy: DshRolloutPolicy): DshRolloutGate => {
  shared ??= new DshRolloutGate(policy);
  return shared;
};
