import type {
  AuditLoggerLike,
  AuthChallengeLimits,
  EmailOtpPort,
  HostedJob,
  HostedNotificationPort,
  HostedPaymentPort,
  Logger,
  PlatformRepositoryRegistry,
} from '@luoome/core';
import { z } from 'zod';
import { requireAuthSecret } from './crypto.js';

const Id = z.string().min(1).max(160);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);

export const PlatformPrincipalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('anonymous'),
    ipKey: Digest,
    requestId: Id,
  }),
  z.object({
    kind: z.literal('user'),
    userId: Id,
    tenantId: Id,
    tenantGeneration: z.number().int().positive(),
    sessionId: Id,
    tokenHash: Digest,
    csrfHash: Digest,
    csrfToken: Digest,
    authenticatedAt: z.date(),
    requestId: Id,
    ipKey: Digest,
  }),
  z.object({ kind: z.literal('worker'), workerId: Id, requestId: Id }),
  z.object({ kind: z.literal('webhook'), provider: Id, eventId: Id, requestId: Id }),
  z.object({ kind: z.literal('admin'), userId: Id, requestId: Id, ipKey: Digest }),
]);

export type PlatformPrincipal = z.infer<typeof PlatformPrincipalSchema>;
export type PlatformActorKind = PlatformPrincipal['kind'];

export interface HostedJobPolicy {
  readonly units: number;
  readonly partialUnits?: number;
  readonly budgetMicro: number;
  readonly priority: number;
  readonly acceptDeadlineMs: number;
}

export interface PlatformContext {
  readonly repos: PlatformRepositoryRegistry;
  readonly principal: Readonly<PlatformPrincipal>;
  readonly authSecret: string;
  readonly environment: 'development' | 'production';
  readonly emailOtp: EmailOtpPort;
  readonly notification?: HostedNotificationPort;
  readonly payment?: HostedPaymentPort;
  readonly publicOrigin?: string;
  readonly allowInsecureHttp?: boolean;
  readonly registration: { readonly enabled: boolean; readonly maxUsers: number };
  readonly authChallengeLimits: AuthChallengeLimits;
  readonly capabilities: { readonly write: boolean; readonly external: boolean };
  readonly jobPolicies: Readonly<Partial<Record<HostedJob['kind'], HostedJobPolicy>>>;
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly auditLog?: AuditLoggerLike;
  readonly auditCaller?: string;
}

export interface BuildPlatformContextInput
  extends Omit<PlatformContext, 'clock' | 'logger' | 'authChallengeLimits' | 'jobPolicies'> {
  readonly clock?: () => Date;
  readonly logger?: Logger;
  readonly authChallengeLimits?: AuthChallengeLimits;
  readonly jobPolicies?: PlatformContext['jobPolicies'];
}

export const buildPlatformContext = (input: BuildPlatformContextInput): PlatformContext => {
  requireAuthSecret(input.authSecret);
  const principal = Object.freeze(PlatformPrincipalSchema.parse(input.principal));
  if (input.environment === 'production' && input.emailOtp.providerKind === 'fixture') {
    throw new Error('Fixture email provider is prohibited in hosted production');
  }
  if (input.environment === 'production' && input.notification?.providerKind === 'fixture') {
    throw new Error('Fixture notification provider is prohibited in hosted production');
  }
  if (input.environment === 'production' && input.payment?.providerKind === 'fixture') {
    throw new Error('Fixture payment provider is prohibited in hosted production');
  }
  if (input.publicOrigin !== undefined) {
    const origin = new URL(input.publicOrigin);
    if (
      (origin.protocol !== 'https:' &&
        !(origin.protocol === 'http:' && input.allowInsecureHttp === true)) ||
      origin.origin !== input.publicOrigin ||
      origin.username ||
      origin.password
    )
      throw new Error(
        'Hosted notification origin must be a fixed HTTPS origin; HTTP requires explicit opt-in',
      );
  }
  z.object({ enabled: z.boolean(), maxUsers: z.number().int().positive() }).parse(
    input.registration,
  );
  const authChallengeLimits = input.authChallengeLimits ?? {
    cooldownSeconds: 60,
    emailHourly: 5,
    emailDaily: 10,
    ipHourly: 30,
    globalHourly: 500,
  };
  z.object({
    cooldownSeconds: z.number().int().positive().safe(),
    emailHourly: z.number().int().positive().safe(),
    emailDaily: z.number().int().positive().safe(),
    ipHourly: z.number().int().positive().safe(),
    globalHourly: z.number().int().positive().safe(),
  }).parse(authChallengeLimits);
  const jobPolicies = input.jobPolicies ?? {};
  for (const policy of Object.values(jobPolicies)) {
    z.object({
      units: z.number().int().nonnegative().safe(),
      partialUnits: z.number().int().nonnegative().safe().optional(),
      budgetMicro: z.number().int().nonnegative().safe(),
      priority: z.number().int().min(0).max(100),
      acceptDeadlineMs: z.number().int().positive().safe(),
    }).parse(policy);
    if ((policy.partialUnits ?? 0) !== 0)
      throw new Error('hosted-facts-v1 partial results do not consume research units');
  }
  return {
    ...input,
    principal,
    registration: Object.freeze({ ...input.registration }),
    capabilities: Object.freeze({ ...input.capabilities }),
    authChallengeLimits: Object.freeze({ ...authChallengeLimits }),
    jobPolicies: Object.freeze(
      Object.fromEntries(
        Object.entries(jobPolicies).map(([kind, policy]) => [kind, Object.freeze({ ...policy })]),
      ),
    ),
    clock: input.clock ?? (() => new Date()),
    logger: input.logger ?? console,
  };
};
