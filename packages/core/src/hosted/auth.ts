import { z } from 'zod';

export const LocalExecutionIdentitySchema = z.object({
  mode: z.literal('local'),
  userId: z.string().min(1),
});

export const HostedExecutionIdentitySchema = z.object({
  mode: z.literal('hosted'),
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  tenantGeneration: z.number().int().positive(),
  actor: z.enum(['user', 'worker']),
  requestId: z.string().min(1),
  operationId: z.string().min(1).optional(),
});

export const ExecutionIdentitySchema = z.discriminatedUnion('mode', [
  LocalExecutionIdentitySchema,
  HostedExecutionIdentitySchema,
]);

export type LocalExecutionIdentity = z.infer<typeof LocalExecutionIdentitySchema>;
export type HostedExecutionIdentity = z.infer<typeof HostedExecutionIdentitySchema>;
export type ExecutionIdentity = z.infer<typeof ExecutionIdentitySchema>;

export const LoginEmailSchema = z.string().trim().max(254).email();
export const LoginPasswordSchema = z.string().min(8).max(128);
export const HostedPasswordCredentialSchema = z.object({
  id: z.string().min(1).max(160),
  passwordHash: z.string().regex(/^scrypt-v1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/),
  updatedAt: z.coerce.date(),
});
export type HostedPasswordCredential = z.infer<typeof HostedPasswordCredentialSchema>;
export const PasswordLoginAttemptSchema = z.object({
  id: z.string().min(1).max(160),
  emailHash: z.string().min(1).max(256),
  ipHash: z.string().min(1).max(256),
  createdAt: z.coerce.date(),
});
export type PasswordLoginAttempt = z.infer<typeof PasswordLoginAttemptSchema>;

export const normalizeLoginEmail = (email: string): { email: string; emailKey: string } => {
  const address = LoginEmailSchema.parse(email);
  return { email: address, emailKey: address.toLowerCase() };
};

export const AUTH_CHALLENGE_TTL_MS = 5 * 60_000;
export const AUTH_CHALLENGE_MAX_ATTEMPTS = 5;
export const AUTH_SESSION_IDLE_TTL_MS = 7 * 86_400_000;
export const AUTH_SESSION_ABSOLUTE_TTL_MS = 30 * 86_400_000;
export const AUTH_REAUTH_TTL_MS = 10 * 60_000;

export type AuthChallengePurpose = 'login' | 'reauth';

export interface EmailOtpRequest {
  readonly challengeId: string;
  readonly destination: string;
  readonly code: string;
  readonly purpose: AuthChallengePurpose;
  readonly expiresAt: Date;
}

export type EmailOtpDeliveryResult =
  | { readonly state: 'accepted'; readonly providerMessageId: string }
  | { readonly state: 'failed'; readonly reason: 'unconfigured' | 'rejected' }
  | { readonly state: 'unknown' };

export interface EmailOtpPort {
  readonly name: string;
  readonly providerKind: 'fixture' | 'live';
  readonly configured: boolean;
  sendChallenge(input: EmailOtpRequest): Promise<EmailOtpDeliveryResult>;
}

export const sessionHasRecentAuthentication = (authenticatedAt: Date, now: Date): boolean =>
  authenticatedAt.getTime() <= now.getTime() &&
  now.getTime() - authenticatedAt.getTime() <= AUTH_REAUTH_TTL_MS;
