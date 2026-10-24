import { z } from 'zod';

const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative();
export const PluginCapabilitySchema = z.enum(['read', 'write', 'external']);
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
