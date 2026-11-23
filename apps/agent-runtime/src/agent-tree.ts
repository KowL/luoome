import type { JsonObject } from '@luoome/dsh-bridge/protocol';

/**
 * 本 Run 的 Agent 树（docs/ddd/luoome-dsh-transformation-detailed-design.md §5.5）。
 *
 * 进程内子 Agent 不受根 Agent 生命周期保护：根进入 idle 时后代可能仍在运行，
 * 因此完成判定必须等全部派生 Agent 进入终态；取消时后代随 Host 关闭进程一并终止。
 * 只接收本 Run 插件发出的带父子关联审计事件，不解析 DSH 私有会话日志。
 */

export type RunAgentStatus = 'active' | 'terminal';

export interface RunAgentNode {
  readonly agentId: string;
  readonly parentAgentId: string | null;
  readonly depth: number;
  readonly status: RunAgentStatus;
}

const POLL_INTERVAL_MS = 10;

export class RunAgentTree {
  readonly #rootAgentId: string;
  readonly #nodes = new Map<string, RunAgentNode>();

  constructor(rootAgentId: string) {
    this.#rootAgentId = rootAgentId;
    this.#nodes.set(rootAgentId, {
      agentId: rootAgentId,
      parentAgentId: null,
      depth: 0,
      status: 'active',
    });
  }

  /** 重复的派生审计是幂等的；深度按已登记的父级计算，不信任事件里的数字。 */
  spawn(agentId: string, parentAgentId: string): void {
    if (agentId === this.#rootAgentId || this.#nodes.has(agentId)) return;
    const parent = this.#nodes.get(parentAgentId);
    if (parent === undefined) return;
    this.#nodes.set(agentId, {
      agentId,
      parentAgentId,
      depth: parent.depth + 1,
      status: 'active',
    });
  }

  dispose(agentId: string): void {
    const node = this.#nodes.get(agentId);
    if (node === undefined || node.agentId === this.#rootAgentId) return;
    if (node.status === 'terminal') return;
    this.#nodes.set(agentId, { ...node, status: 'terminal' });
  }

  hasActiveDescendants(): boolean {
    for (const node of this.#nodes.values()) {
      if (node.parentAgentId !== null && node.status === 'active') return true;
    }
    return false;
  }

  /** 取消/排空时把仍活跃的后代一并标记为终态，保证结果确定且审计完整。 */
  terminateDescendants(): void {
    for (const [agentId, node] of this.#nodes) {
      if (node.parentAgentId !== null && node.status === 'active') {
        this.#nodes.set(agentId, { ...node, status: 'terminal' });
      }
    }
  }

  snapshot(): readonly RunAgentNode[] {
    return [...this.#nodes.values()];
  }
}

/** 只读本 Run 的派生/终止审计；其它诊断与畸形 payload 一律忽略。 */
export const recordAgentDiagnostic = (tree: RunAgentTree, payload: JsonObject): boolean => {
  const { code, agentId, parentAgentId } = payload;
  if (typeof code !== 'string' || typeof agentId !== 'string') return false;
  if (code === 'subagent.disposed') {
    tree.dispose(agentId);
    return true;
  }
  if (code !== 'subagent.spawn' || typeof parentAgentId !== 'string') return false;
  tree.spawn(agentId, parentAgentId);
  return true;
};

export interface DescendantWaitOptions {
  /** 绝对截止时间（与 Run 授权/超时同一口径）。 */
  readonly deadline: number;
  readonly cancelled: () => boolean;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 根 Agent 已 idle 后仍需等全部后代进入终态；返回 false 表示超时或被取消。 */
export const awaitDescendants = async (
  tree: RunAgentTree,
  options: DescendantWaitOptions,
): Promise<boolean> => {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  while (tree.hasActiveDescendants()) {
    if (options.cancelled() || now() >= options.deadline) return false;
    await sleep(POLL_INTERVAL_MS);
  }
  return true;
};
