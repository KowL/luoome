import { z } from 'zod';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative();
/**
 * 持久操作/授权可声明的能力。`queue` 只用于精确的交互分析 policy（record_*），
 * 由受信任装配显式开启；它不是通用写能力，也不会被授权给任意工具或定时 grant。
 */
export const PluginCapabilitySchema = z.enum(['read', 'write', 'external', 'queue']);
export const PluginTaskIdentitySchema = z
  .object({
    userId: id,
    profile: id,
    sessionId: id,
    taskId: id,
  })
  .strict();
export type PluginTaskIdentity = z.infer<typeof PluginTaskIdentitySchema>;

export const PluginAutomationGrantSchema = z
  .object({
    id,
    identity: PluginTaskIdentitySchema,
    scheduleHash: hash,
    version: z.number().int().positive(),
    policyVersion: z.number().int().positive(),
    enabled: z.boolean(),
    allowedCalls: z
      .array(
        z
          .object({
            tool: id,
            accountId: id,
            inputHash: hash,
            inputJson: z.string().min(1),
            capabilities: z.array(PluginCapabilitySchema).min(1),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    createdAt: time,
    updatedAt: time,
    expiresAt: time,
  })
  .strict()
  .refine(
    (v) => v.updatedAt >= v.createdAt && v.expiresAt > v.createdAt,
    'Invalid grant time window',
  );
export type PluginAutomationGrant = z.infer<typeof PluginAutomationGrantSchema>;

const PluginOperationBase = z
  .object({
    id,
    userId: id,
    accountId: id,
    tool: id,
    inputJson: z.string().min(1),
    inputHash: hash,
    policyVersion: z.number().int().positive(),
    requiredCapabilities: z.array(PluginCapabilitySchema).min(1),
    authorization: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('human'), tokenHash: hash }).strict(),
      z
        .object({
          kind: z.literal('schedule'),
          grantId: id,
          grantVersion: z.number().int().positive(),
        })
        .strict(),
    ]),
    createdAt: time,
    updatedAt: time,
    expiresAt: time,
  })
  .strict();

export const PluginOperationSchema = z
  .discriminatedUnion('state', [
    PluginOperationBase.extend({
      state: z.enum(['pending', 'cancelled']),
      claimToken: z.null(),
      resultJson: z.null(),
    }),
    PluginOperationBase.extend({
      state: z.enum(['executing', 'unknown', 'failed']),
      claimToken: id,
      resultJson: z.string().nullable(),
    }),
    PluginOperationBase.extend({
      state: z.literal('succeeded'),
      claimToken: id,
      resultJson: z.string(),
    }),
  ])
  .refine(
    (v) => v.updatedAt >= v.createdAt && v.expiresAt > v.createdAt,
    'Invalid operation time window',
  );
export type PluginOperation = z.infer<typeof PluginOperationSchema>;

/**
 * 尚未终结的 Operation 状态。恢复互斥 gate 与导入提交的权威复查都以这三个状态为准：
 * pending 覆盖「已 prepare 未 claim」，executing 覆盖「已 claim 业务未落地」，unknown 覆盖
 * 「业务可能已提交但 settle 丢失」。terminal（succeeded/failed/cancelled）不阻断。
 */
export const PLUGIN_OPERATION_NON_TERMINAL_STATES = ['pending', 'executing', 'unknown'] as const;
export type PluginOperationNonTerminalState = (typeof PLUGIN_OPERATION_NON_TERMINAL_STATES)[number];

/**
 * 窄投影：只用于「同账户是否还有未终结操作」的判定，刻意不含 inputJson/resultJson/claimToken。
 * 恢复互斥 gate 只需要身份与状态，不需要也不应该把业务输入带进判定路径。
 */
export interface PluginOperationNonTerminal {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
  readonly state: PluginOperationNonTerminalState;
  readonly tool: string;
}

export interface PluginOperationScope {
  readonly id: string;
  readonly userId: string;
  readonly accountId: string;
}
export interface PluginOperationProof extends PluginOperationScope {
  readonly now: number;
  readonly policyVersion: number;
  readonly authorization:
    | { readonly kind: 'human'; readonly tokenHash: string }
    | { readonly kind: 'schedule'; readonly identity: PluginTaskIdentity };
}

export const samePluginTask = (a: PluginTaskIdentity, b: PluginTaskIdentity): boolean =>
  a.userId === b.userId &&
  a.profile === b.profile &&
  a.sessionId === b.sessionId &&
  a.taskId === b.taskId;

export const canClaimPluginOperation = (
  operation: PluginOperation,
  proof: PluginOperationProof,
  grant: PluginAutomationGrant | null,
): boolean => {
  if (
    operation.state !== 'pending' ||
    operation.id !== proof.id ||
    operation.userId !== proof.userId ||
    operation.accountId !== proof.accountId ||
    proof.now < operation.createdAt ||
    proof.now >= operation.expiresAt ||
    operation.policyVersion !== proof.policyVersion
  )
    return false;
  if (operation.authorization.kind === 'human')
    return (
      proof.authorization.kind === 'human' &&
      operation.authorization.tokenHash === proof.authorization.tokenHash
    );
  if (
    proof.authorization.kind !== 'schedule' ||
    !grant ||
    !grant.enabled ||
    grant.id !== operation.authorization.grantId ||
    grant.version !== operation.authorization.grantVersion ||
    grant.policyVersion !== proof.policyVersion ||
    proof.now < grant.createdAt ||
    proof.now >= grant.expiresAt ||
    grant.identity.userId !== operation.userId ||
    !samePluginTask(grant.identity, proof.authorization.identity)
  )
    return false;
  return grant.allowedCalls.some(
    (call) =>
      call.tool === operation.tool &&
      call.accountId === operation.accountId &&
      call.inputHash === operation.inputHash &&
      operation.requiredCapabilities.every((c) => call.capabilities.includes(c)),
  );
};
