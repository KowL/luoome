import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  canClaimPluginOperation,
  type PluginAuthorityRepository,
  PluginAutomationGrantSchema,
  type PluginOperation,
  type PluginOperationProof,
  type PluginTaskIdentity,
  type ToolContext,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';
import { defineTool, type Tool } from './define-tool.js';

export interface PluginPrincipal {
  readonly userId: string;
  readonly accountId: string;
}
export interface ConfirmablePluginTool {
  readonly tool: Tool;
  readonly scheduled: boolean;
  readonly hostBoundFields?: readonly ('accountId' | 'requestId')[];
  /**
   * 该 policy 保证「返回非 ok 结果 ⇒ 业务未提交」时置 true：内核据此把失败落成终态 `failed`，
   * 而不是保守的 `unknown`。抛出异常仍按 `unknown` 处理（业务可能已提交）。
   * 只有事务内自检失败、明确回滚的写入口（如数据导入 commit）才可声明。
   */
  readonly settleFailureAsFailed?: boolean;
  bind(input: unknown, principal: PluginPrincipal, operationId: string, ctx: ToolContext): unknown;
  receipt(input: unknown, ctx: ToolContext): Promise<ToolResult<unknown> | null>;
}

export class PluginOperationScopeError extends Error {
  constructor(readonly field: 'accountId' | 'requestId') {
    super(
      field === 'requestId'
        ? 'Omit requestId; the host supplies the top-level operation id'
        : 'Operation account must match the current owner account',
    );
  }
}

/**
 * 同账户异步互斥（T48 恢复 gate）。
 *
 * 边界：只在**同一 Node 写实例**内成立。SQLite 的写锁只覆盖单条语句，覆盖不了
 * prepare 里 `bind → insertOperation` 的 await 窗口，也覆盖不了 confirm 的
 * `read → claim → 业务 → settle`。跨进程多写实例需要持久 epoch/CAS 协议，本实现不声称支持，
 * 部署必须保证单写实例（见实施方案 §7）。
 *
 * 语义：非重入。持有者内部的调用链（`confirm → execute`、`executeScheduled → execute`、
 * 导入 handler 里的 commit）不得再次 acquire；否则同一个 Promise 永远等自己。
 * 需要复用 lease 的入口一律走内部不取锁的函数，或由外层已持锁的调用方直接调用。
 */
class AccountLease {
  private tail: Promise<void> = Promise.resolve();
  private holders = 0;
  private peak = 0;
  private waiters = 0;
  async acquire(): Promise<() => void> {
    this.waiters += 1;
    let releaseNext!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    this.waiters -= 1;
    this.holders += 1;
    this.peak = Math.max(this.peak, this.holders);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      releaseNext();
    };
  }
  stats(): { readonly holders: number; readonly peak: number; readonly waiters: number } {
    return { holders: this.holders, peak: this.peak, waiters: this.waiters };
  }
}

const operationInputSchema = ({ tool, hostBoundFields = [] }: ConfirmablePluginTool) => {
  const schema = z.toJSONSchema(tool.inputSchema, { io: 'input', unrepresentable: 'any' });
  if (schema.required)
    schema.required = schema.required.filter(
      (field) => !hostBoundFields.includes(field as 'accountId' | 'requestId'),
    );
  for (const field of hostBoundFields) {
    const property = schema.properties?.[field];
    if (schema.properties && property && typeof property === 'object')
      schema.properties[field] = {
        ...property,
        description:
          field === 'requestId'
            ? 'Host-bound: omit requestId. The host supplies the top-level operation id; if supplied it must equal that id.'
            : 'Host-bound: omit accountId to use the current owner account. A different account is rejected.',
      };
  }
  return schema;
};

export const pluginInputJson = (input: unknown): string => {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, sort(v)]),
      );
    return value;
  };
  return JSON.stringify(sort(JSON.parse(JSON.stringify(input))));
};
export const pluginInputHash = (input: unknown): string =>
  createHash('sha256').update(pluginInputJson(input)).digest('hex');
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const denied = (): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required: 'current operation authority' },
});
/**
 * 被**自动化档位**拒绝（REQ-M4-06）。
 *
 * 与 `denied()` 分开是为了让调用方与测试能区分「档位不允许」与「授权链不通过」——
 * 两者都叫 `permission_denied` 时，用户看不出该去调档位还是该去授权，
 * 测试也无法证明「是档位拦的」。
 */
const deniedByTier = (): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required: 'automation tier allowing business writes' },
});
const invalid = (issues: readonly z.ZodIssue[] = []): ToolResult<never> => ({
  ok: false,
  error: { kind: 'invalid_input', message: 'Invalid or conflicting operation', issues },
});
const hasForce = (input: unknown): boolean =>
  input !== null &&
  typeof input === 'object' &&
  Object.entries(input).some(
    ([key, value]) => (key === 'force' && value === true) || hasForce(value),
  );
const publicOperation = (op: PluginOperation) => ({
  operationId: op.id,
  accountId: op.accountId,
  tool: op.tool,
  requiredCapabilities: op.requiredCapabilities,
  state: op.state,
  input: JSON.parse(op.inputJson) as unknown,
  expiresAt: op.expiresAt,
  result: op.resultJson === null ? null : (JSON.parse(op.resultJson) as unknown),
});

export const createPluginOperationService = (options: {
  readonly repository: PluginAuthorityRepository;
  readonly policies: readonly ConfirmablePluginTool[];
  readonly capabilities: readonly ('read' | 'write' | 'external' | 'queue')[];
  readonly policyVersion: number;
  readonly now: () => number;
  readonly context: () => ToolContext | Promise<ToolContext>;
  readonly validateGrant?: (
    grant: import('@luoome/core').PluginAutomationGrant,
  ) => Promise<boolean>;
  /**
   * 是否允许**写业务数据**（REQ-M4-06 的 `notify` 档边界）。
   *
   * - 缺省 `true`（既有行为不变）
   * - 传 `false` 时，`sideEffect !== 'read'` 的 policy **一律不可执行**
   *
   * ## 为什么判据是 `sideEffect` 而不是工具名
   *
   * `sideEffect` 是工具契约的一部分（`defineTool` 强制声明），**新增写工具自动被覆盖**；
   * 按名字匹配（如 `name.includes('save')`）则新工具默认漏网。
   *
   * ## 为什么闸门在这里而不是 dispatch
   *
   * dispatch 只知道「这个 policy 要不要跑」，**不知道 policy 里调了哪些 tool**；
   * 在 dispatch 层拦等于「凭 policy 名字猜它写不写」，猜错就是漏洞。
   * 这里是所有 operation 调用的共同准入点（`allowed`），看得清这次调用是什么。
   */
  readonly allowBusinessWrite?: boolean;
  /**
   * **执行时**读取「当前是否允许写业务数据」（REQ-M4-06 P0）。
   *
   * ## 为什么必须是函数，而不是 boolean 常量
   *
   * `allowBusinessWrite` 是**构造时**算好的常量。用户在设置页把档位从 `notify`
   * 切到 `granted` 之后常量不会变 —— 于是「开关点得动、存得下、但派发行为不变」，
   * 比假开关更糟：**它看起来成功了**。
   *
   * 传了这个函数时以它为准（每次派发都重新读）；否则回退到常量（既有调用点不变）。
   */
  readonly resolveAllowBusinessWrite?: () => boolean | Promise<boolean>;
}) => {
  if (process.env.LUOOME_EXPOSE_TRADE === 'true')
    throw new Error('LUOOME_EXPOSE_TRADE=true is not allowed');
  z.number().int().positive().parse(options.policyVersion);
  const capabilities = new Set(options.capabilities);
  const policies = new Map<string, ConfirmablePluginTool>();
  for (const policy of options.policies) {
    if (policies.has(policy.tool.name)) throw new Error('Duplicate operation policy');
    // queue 只在受信任装配显式开启时用于精确 policy；trade 永不接受。
    if (
      policy.tool.requiredCapabilities.some((c) => c === 'trade') ||
      policy.tool.sideEffect === 'trade' ||
      (policy.tool.requiredCapabilities.some((c) => c === 'queue') && !capabilities.has('queue'))
    )
      throw new Error('Unsupported operation capability');
    policies.set(policy.tool.name, policy);
  }
  const repo = options.repository;
  let disposed = false;
  const leases = new Map<string, AccountLease>();
  const leaseFor = (accountId: string): AccountLease => {
    let lease = leases.get(accountId);
    if (lease === undefined) {
      lease = new AccountLease();
      leases.set(accountId, lease);
    }
    return lease;
  };
  /** 账户级临界区；调用方必须已经不在同账户 lease 内（非重入）。 */
  const withAccountLease = async <T>(accountId: string, run: () => Promise<T>): Promise<T> => {
    const release = await leaseFor(accountId).acquire();
    try {
      return await run();
    } finally {
      release();
    }
  };
  const allowBusinessWriteStatic = options.allowBusinessWrite !== false;
  /**
   * **每次判定都重新读档位**——切档位后立刻生效，不需要重启。
   *
   * 这里曾经是构造时常量（`options.allowBusinessWrite !== false`），
   * 于是「设置页切档位」能存能读、**但派发行为不变**。
   * 那比假开关更糟：它看起来成功了。
   */
  const currentAllowBusinessWrite = async (): Promise<boolean> =>
    options.resolveAllowBusinessWrite === undefined
      ? allowBusinessWriteStatic
      : await options.resolveAllowBusinessWrite();
  const allowed = (policy: ConfirmablePluginTool) =>
    !disposed &&
    policy.tool.requiredCapabilities.every((c) =>
      capabilities.has(c as 'read' | 'write' | 'external' | 'queue'),
    );
  /**
   * `notify` 档的业务写入闸门（REQ-M4-06）。
   *
   * ## 只约束**定时派发**，不约束用户手动操作
   *
   * `off` / `notify` 说的是「**自动**能做什么」，不是「用户不能做什么」。
   * 用户手动点一次写入，与他把档位调到 `off` 并不矛盾——档位管的是
   * 「机器自己跑的时候允许做什么」。所以判据里带上 `authorization.kind`：
   * 只有 `schedule` 授权（定时派发）才受档位约束。
   *
   * ## 判据是 `sideEffect`，不是工具名
   *
   * `sideEffect` 是工具契约的一部分，**新增写工具自动被覆盖**；
   * 按名字匹配（`name.includes('save')`）则名字不含写词的写工具会漏网。
   */
  const scheduleDeniedByTier = async (
    policy: ConfirmablePluginTool,
    authorization: { kind: string },
  ): Promise<boolean> =>
    authorization.kind === 'schedule' &&
    policy.tool.sideEffect !== 'read' &&
    !(await currentAllowBusinessWrite());

  const grantInput = z
    .object({
      grant: PluginAutomationGrantSchema,
      // 缺省即 null：null 表示“只允许创建 version 1，已存在则失败”，不会覆盖既有授权。
      expectedVersion: z.number().int().positive().nullable().default(null),
    })
    .strict();
  const grantTool = defineTool({
    name: 'configure_plugin_automation',
    description: 'Confirm an exact task authorization',
    sideEffect: 'write',
    input: grantInput,
    output: z.object({ grantId: z.string(), version: z.number() }),
    handler: async ({ grant, expectedVersion }) => {
      if (
        grant.enabled &&
        (grant.expiresAt <= options.now() ||
          !options.validateGrant ||
          !(await options.validateGrant(grant)))
      )
        return denied();
      if (!(await repo.saveGrant(grant, expectedVersion))) return invalid();
      return { grantId: grant.id, version: grant.version };
    },
  });
  if (policies.has(grantTool.name)) throw new Error('Reserved operation policy');
  policies.set(grantTool.name, {
    tool: grantTool,
    scheduled: false,
    async bind(raw, principal, _operationId, ctx) {
      const input = grantInput.parse(raw);
      if (
        input.grant.identity.userId !== principal.userId ||
        input.grant.policyVersion !== options.policyVersion
      )
        throw new Error('Grant scope mismatch');
      for (const call of input.grant.allowedCalls) {
        if (!input.grant.enabled) {
          if (call.accountId !== principal.accountId) throw new Error('Grant scope mismatch');
          continue;
        }
        const policy = policies.get(call.tool);
        if (
          call.accountId !== principal.accountId ||
          !policy?.scheduled ||
          !allowed(policy) ||
          // 注意：**不在这里**判档位。`configure_plugin_automation` 本身就是 write，
          // 若被 `notify` 档拦住，用户就永远无法从 notify 升到 granted——死锁。
          // 档位闸门只在 `executeScheduled`（真正派发业务工具时）生效。
          policy.tool.requiredCapabilities.some(
            (c) => !call.capabilities.includes(c as 'read' | 'write' | 'external' | 'queue'),
          )
        )
          throw new Error('Grant scope mismatch');
        const bound = await policy.bind(
          JSON.parse(call.inputJson),
          principal,
          'grant-preview',
          ctx,
        );
        if (
          hasForce(bound) ||
          !policy.tool.inputSchema.safeParse(bound).success ||
          pluginInputJson(bound) !== call.inputJson ||
          pluginInputHash(bound) !== call.inputHash
        )
          throw new Error('Grant scope mismatch');
      }
      return input;
    },
    async receipt(raw) {
      const { grant } = grantInput.parse(raw);
      const stored = await repo.findGrant(grant.id, grant.identity.userId);
      return stored && pluginInputJson(stored) === pluginInputJson(grant)
        ? { ok: true, data: { grantId: grant.id, version: grant.version } }
        : null;
    },
  });

  const makeOperation = async (
    principal: PluginPrincipal,
    id: string,
    policy: ConfirmablePluginTool,
    raw: unknown,
    authorization: PluginOperation['authorization'],
  ): Promise<PluginOperation> => {
    const input = await policy.bind(raw, principal, id, await options.context());
    // Freeze wire input; preserve the original tool's validation/default/transform pipeline.
    // Freeze bound content after patch resolution, before requesting approval.
    const parsed = policy.tool.inputSchema.parse(JSON.parse(pluginInputJson(input)));
    const inputJson = pluginInputJson(parsed);
    const now = options.now();
    return {
      id,
      ...principal,
      tool: policy.tool.name,
      inputJson,
      inputHash: pluginInputHash(JSON.parse(inputJson)),
      policyVersion: options.policyVersion,
      requiredCapabilities: policy.tool
        .requiredCapabilities as PluginOperation['requiredCapabilities'],
      authorization,
      state: 'pending',
      claimToken: null,
      resultJson: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 600_000,
    };
  };
  const identical = (a: PluginOperation, b: PluginOperation) =>
    a.tool === b.tool &&
    a.inputHash === b.inputHash &&
    a.policyVersion === b.policyVersion &&
    a.authorization.kind === b.authorization.kind &&
    (a.authorization.kind !== 'schedule' ||
      (b.authorization.kind === 'schedule' &&
        a.authorization.grantId === b.authorization.grantId &&
        a.authorization.grantVersion === b.authorization.grantVersion));

  const execute = async (
    operation: PluginOperation,
    proof: PluginOperationProof,
    signal: AbortSignal,
  ): Promise<ToolResult<unknown>> => {
    const policy = policies.get(operation.tool);
    if (
      !policy ||
      !allowed(policy) ||
      signal.aborted ||
      operation.policyVersion !== options.policyVersion
    )
      return denied();
    if (operation.state !== 'pending') return { ok: true, data: publicOperation(operation) };
    const ctx = await options.context();
    if (!allowed(policy) || signal.aborted) return denied();
    // `notify` 档下，定时派发不得写业务数据（用户手动操作不受此限）。
    if (await scheduleDeniedByTier(policy, operation.authorization)) return deniedByTier();
    const claimToken = randomUUID();
    const claimed = await repo.claimOperation({
      ...proof,
      now: options.now(),
      claimToken,
    });
    if (!claimed) {
      const current = await repo.findOperation(proof);
      return current && current.state !== 'pending'
        ? { ok: true, data: publicOperation(current) }
        : denied();
    }
    let result: ToolResult<unknown> | null = null;
    try {
      if (!signal.aborted && !disposed)
        result = await policy.tool.execute(JSON.parse(claimed.inputJson), {
          ...ctx,
          abortSignal:
            ctx.abortSignal === undefined ? signal : AbortSignal.any([signal, ctx.abortSignal]),
        });
    } catch {
      // A thrown/failed business call may already have committed; never blindly replay it.
    }
    const state =
      result?.ok === true
        ? 'succeeded'
        : result !== null && policy.settleFailureAsFailed === true
          ? 'failed'
          : 'unknown';
    await repo.settleOperation({
      ...proof,
      claimToken,
      state,
      resultJson: result === null ? null : JSON.stringify(result),
      now: options.now(),
    });
    const saved = await repo.findOperation(proof);
    return saved ? { ok: true, data: publicOperation(saved) } : denied();
  };
  const safe = async (fn: () => Promise<ToolResult<unknown>>): Promise<ToolResult<unknown>> => {
    if (disposed) return denied();
    try {
      return await fn();
    } catch {
      return {
        ok: false,
        error: {
          kind: 'internal',
          cause: 'Operation unavailable; query its status before retrying',
        },
      };
    }
  };
  return {
    descriptors() {
      return [...policies.values()].filter(allowed).map((policy) => ({
        name: policy.tool.name,
        description: policy.tool.description,
        inputSchema: operationInputSchema(policy),
      }));
    },
    prepare(principal: PluginPrincipal, request: { id: string; tool: string; input: unknown }) {
      // 整段 bind → insertOperation 都在账户 lease 内：bind 的 await 窗口里 Operation 尚未入库，
      // 只靠数据库查询看不见它，必须由 lease 挡住同账户的恢复提交。
      return safe(() =>
        withAccountLease(principal.accountId, async () => {
          const policy = policies.get(request.tool);
          if (!policy || !allowed(policy)) return denied();
          if (!z.uuid().safeParse(request.id).success) return invalid();
          const token = randomBytes(32).toString('base64url');
          let op: PluginOperation;
          try {
            op = await makeOperation(principal, request.id, policy, request.input, {
              kind: 'human',
              tokenHash: tokenHash(token),
            });
          } catch (error) {
            return invalid(
              error instanceof PluginOperationScopeError
                ? [{ code: 'custom', path: [error.field], message: error.message }]
                : error instanceof z.ZodError
                  ? error.issues.map((issue) => ({
                      code: 'custom',
                      path: issue.path,
                      message:
                        issue.code === 'invalid_type'
                          ? `Expected ${issue.expected}`
                          : `Invalid value (${issue.code})`,
                    }))
                  : [],
            );
          }
          if (!(await repo.insertOperation(op))) {
            const existing = await repo.findOperation({ ...principal, id: request.id });
            return existing && identical(existing, op)
              ? { ok: true, data: publicOperation(existing) }
              : invalid();
          }
          return { ok: true, data: { ...publicOperation(op), confirmationToken: token } };
        }),
      );
    },
    confirm(
      principal: PluginPrincipal,
      request: { id: string; token: string },
      signal: AbortSignal,
    ) {
      // read → claim → 业务 → settle 全程持锁：中途不放开，恢复提交才拿得到一致视图。
      return safe(() =>
        withAccountLease(principal.accountId, async () => {
          const op = await repo.findOperation({ ...principal, id: request.id });
          if (
            op?.authorization.kind !== 'human' ||
            op.authorization.tokenHash !== tokenHash(request.token)
          )
            return denied();
          return execute(
            op,
            {
              ...principal,
              id: op.id,
              now: options.now(),
              policyVersion: options.policyVersion,
              authorization: { kind: 'human', tokenHash: tokenHash(request.token) },
            },
            signal,
          );
        }),
      );
    },
    cancel(principal: PluginPrincipal, request: { id: string; token: string }) {
      return safe(() =>
        withAccountLease(principal.accountId, async () =>
          (await repo.cancelOperation({
            ...principal,
            id: request.id,
            now: options.now(),
            policyVersion: options.policyVersion,
            authorization: { kind: 'human', tokenHash: tokenHash(request.token) },
          }))
            ? { ok: true, data: { state: 'cancelled' } }
            : denied(),
        ),
      );
    },
    get(principal: PluginPrincipal, id: string) {
      // 只读状态查询不取锁：面板刷新不能排在写操作后面，也不能被长任务拖住。
      return safe(async () => {
        const op = await repo.findOperation({ ...principal, id });
        return op ? { ok: true, data: publicOperation(op) } : denied();
      });
    },
    reconcile(principal: PluginPrincipal, id: string) {
      // reconcile 会按业务回执把 executing/unknown 升级成 succeeded，本身就是一次判定写入。
      return safe(() =>
        withAccountLease(principal.accountId, async () => {
          const op = await repo.findOperation({ ...principal, id });
          const policy = op && policies.get(op.tool);
          if (!op || !policy || !allowed(policy)) return denied();
          if (op.state === 'executing' || op.state === 'unknown') {
            const receipt = await policy.receipt(JSON.parse(op.inputJson), await options.context());
            await repo.settleOperation({
              ...principal,
              id,
              claimToken: op.claimToken,
              state: receipt?.ok ? 'succeeded' : 'unknown',
              resultJson: receipt?.ok ? JSON.stringify(receipt) : op.resultJson,
              now: options.now(),
            });
          }
          const saved = await repo.findOperation({ ...principal, id });
          return saved ? { ok: true, data: publicOperation(saved) } : denied();
        }),
      );
    },
    executeScheduled(
      identity: PluginTaskIdentity,
      request: {
        grantId: string;
        grantVersion: number;
        occurrenceId: string;
        tool: string;
        accountId: string;
        input: unknown;
      },
      signal: AbortSignal,
    ) {
      return safe(() =>
        withAccountLease(request.accountId, async () => {
          const policy = policies.get(request.tool);
          if (
            !policy?.scheduled ||
            !allowed(policy) ||
            !request.occurrenceId ||
            hasForce(request.input)
          )
            return denied();
          // **档位闸门放在最前**：早于 grant 校验，这样「被档位拒」的原因不会
          // 被「授权链不通过」掩盖——用户能看出该去调档位，而不是去补授权。
          if (await scheduleDeniedByTier(policy, { kind: 'schedule' })) return deniedByTier();
          const principal = { userId: identity.userId, accountId: request.accountId };
          const id = `schedule:${pluginInputHash({ identity, occurrenceId: request.occurrenceId, tool: request.tool, accountId: request.accountId })}`;
          let op: PluginOperation;
          try {
            op = await makeOperation(principal, id, policy, request.input, {
              kind: 'schedule',
              grantId: request.grantId,
              grantVersion: request.grantVersion,
            });
          } catch {
            return invalid();
          }
          // Validate current authority before creating even a pending record; claim repeats this atomically.
          const grant = await repo.findGrant(request.grantId, identity.userId);
          const proof: PluginOperationProof = {
            ...principal,
            id,
            now: options.now(),
            policyVersion: options.policyVersion,
            authorization: { kind: 'schedule', identity },
          };
          if (!canClaimPluginOperation(op, proof, grant)) return denied();
          if (!(await repo.insertOperation(op))) {
            const existing = await repo.findOperation({ ...principal, id });
            if (!existing || !identical(existing, op)) return invalid();
            op = existing;
          }
          return execute(op, proof, signal);
        }),
      );
    },
    /** 观测用：同账户 lease 的当前持有者/峰值/等待者；峰值 >1 即说明互斥失效。 */
    accountLease(accountId: string) {
      return leaseFor(accountId).stats();
    },
    dispose() {
      disposed = true;
    },
  };
};
