import {
  AUTH_CHALLENGE_TTL_MS,
  AUTH_SESSION_ABSOLUTE_TTL_MS,
  AUTH_SESSION_IDLE_TTL_MS,
  AuthChallengeSchema,
  HostedSessionSchema,
  HostedUserSchema,
  LoginEmailSchema,
  LoginPasswordSchema,
  normalizeLoginEmail,
  sessionHasRecentAuthentication,
  TenantSchema,
  type ToolResult,
} from '@luoome/core';
import { z } from 'zod';
import { errAdapterError } from '../define-tool.js';
import { PlatformPrincipalSchema } from './context.js';
import {
  createAuthChallengeDigest,
  DUMMY_PASSWORD_HASH,
  deriveCsrfToken,
  hashCsrfToken,
  hashLoginEmail,
  hashLoginPassword,
  hashSessionToken,
  randomAuthId,
  randomOtpCode,
  randomSessionToken,
  verifyLoginPassword,
} from './crypto.js';
import { definePlatformTool } from './define-platform-tool.js';

const authDenied = (): ToolResult<never> => ({
  ok: false as const,
  error: { kind: 'permission_denied' as const, required: 'auth:valid-credentials' },
});

export const requestAuthChallengeTool = definePlatformTool({
  name: 'request_auth_challenge',
  description: 'Request a single-use, rate-limited email login challenge.',
  sideEffect: 'external',
  requiredCapabilities: ['write', 'external'],
  actors: ['anonymous', 'user'],
  input: z.object({ email: LoginEmailSchema }).strict(),
  output: z.object({ acknowledged: z.literal(true), challengeId: z.string(), expiresAt: z.date() }),
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'anonymous' && ctx.principal.kind !== 'user') return authDenied();
    if (!ctx.emailOtp.configured) return errAdapterError('email-otp', 'provider_unconfigured');
    const { email, emailKey } = normalizeLoginEmail(input.email);
    const now = ctx.clock();
    const challengeId = randomAuthId();
    const code = randomOtpCode();
    const expiresAt = new Date(now.getTime() + AUTH_CHALLENGE_TTL_MS);
    const challenge = AuthChallengeSchema.parse({
      id: challengeId,
      email,
      emailKey,
      purpose: 'login',
      digest: createAuthChallengeDigest(ctx.authSecret, {
        challengeId,
        emailKey,
        purpose: 'login',
        code,
      }),
      ipHash: ctx.principal.ipKey,
      attempts: 0,
      createdAt: now,
      expiresAt,
      consumedAt: null,
      invalidatedAt: null,
      deliveryState: 'pending',
      providerMessageId: null,
    });
    const accepted = await ctx.repos.auth.createChallenge({
      challenge,
      now,
      limits: ctx.authChallengeLimits,
    });
    if (!accepted.accepted) {
      return { ok: false, error: { kind: 'permission_denied', required: 'auth:rate-limit' } };
    }
    try {
      const delivery = await ctx.emailOtp.sendChallenge({
        challengeId,
        destination: email,
        code,
        purpose: 'login',
        expiresAt,
      });
      await ctx.repos.auth.setChallengeDelivery({
        id: challengeId,
        state: delivery.state,
        now: ctx.clock(),
        ...(delivery.state === 'accepted' ? { providerMessageId: delivery.providerMessageId } : {}),
      });
      if (delivery.state === 'failed')
        return errAdapterError('email-otp', 'challenge_delivery_failed', true);
      if (delivery.state === 'unknown')
        return errAdapterError('email-otp', 'challenge_delivery_unknown', true);
    } catch {
      await ctx.repos.auth.setChallengeDelivery({
        id: challengeId,
        state: 'unknown',
        now: ctx.clock(),
      });
      return errAdapterError('email-otp', 'challenge_delivery_unknown', true);
    }
    return { acknowledged: true as const, challengeId, expiresAt };
  },
});

export const createAuthSessionTool = definePlatformTool({
  name: 'create_auth_session',
  description: 'Atomically consume a challenge and establish a fresh hashed session.',
  sideEffect: 'write',
  actors: ['anonymous', 'user'],
  input: z
    .object({
      challengeId: z.string().min(1).max(160),
      code: z.string().regex(/^\d{6}$/),
      password: LoginPasswordSchema.optional(),
    })
    .strict(),
  output: z.object({
    sessionToken: z.string(),
    csrfToken: z.string(),
    user: HostedUserSchema,
    tenant: TenantSchema,
    session: HostedSessionSchema,
  }),
  handler: async (input, ctx) => {
    const challenge = await ctx.repos.auth.findChallenge(input.challengeId);
    const now = ctx.clock();
    if (
      challenge === null ||
      challenge.expiresAt <= now ||
      challenge.consumedAt !== null ||
      challenge.invalidatedAt !== null ||
      challenge.attempts >= 5
    )
      return authDenied();
    const sessionToken = randomSessionToken();
    const csrfToken = deriveCsrfToken(ctx.authSecret, sessionToken);
    const result = await ctx.repos.auth.consumeChallengeAndCreateSession({
      challengeId: challenge.id,
      digest: createAuthChallengeDigest(ctx.authSecret, {
        challengeId: challenge.id,
        emailKey: challenge.emailKey,
        purpose: challenge.purpose,
        code: input.code,
      }),
      now,
      userId: randomAuthId(),
      tenantId: randomAuthId(),
      provisioningJobId: randomAuthId(),
      registration: ctx.registration,
      ...(input.password === undefined
        ? {}
        : { passwordHash: await hashLoginPassword(input.password) }),
      ...(ctx.principal.kind === 'user' ? { rotateSessionId: ctx.principal.sessionId } : {}),
      session: {
        id: randomAuthId(),
        tokenHash: hashSessionToken(sessionToken),
        csrfHash: hashCsrfToken(csrfToken),
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt: new Date(now.getTime() + AUTH_SESSION_IDLE_TTL_MS),
        absoluteExpiresAt: new Date(now.getTime() + AUTH_SESSION_ABSOLUTE_TTL_MS),
        revokedAt: null,
      },
    });
    if (!result.authenticated) return authDenied();
    return {
      sessionToken,
      csrfToken,
      user: result.user,
      tenant: result.tenant,
      session: result.session,
    };
  },
});

export const createPasswordSessionTool = definePlatformTool({
  name: 'create_password_session',
  description: 'Establish a rate-limited session using a verified email and password.',
  sideEffect: 'write',
  actors: ['anonymous', 'user'],
  input: z.object({ email: LoginEmailSchema, password: z.string().min(1).max(128) }).strict(),
  output: z.object({ sessionToken: z.string(), userId: z.string(), tenantStatus: z.string() }),
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'anonymous' && ctx.principal.kind !== 'user') return authDenied();
    const { emailKey } = normalizeLoginEmail(input.email);
    const now = ctx.clock();
    const allowed = await ctx.repos.auth.reservePasswordAttempt({
      id: randomAuthId(),
      emailHash: hashLoginEmail(ctx.authSecret, emailKey),
      ipHash: ctx.principal.ipKey,
      now,
    });
    if (!allowed)
      return {
        ok: false,
        error: { kind: 'permission_denied', required: 'auth:password-rate-limit' },
      };
    const account = await ctx.repos.auth.findPasswordByEmail(emailKey);
    const passwordHash = account?.credential?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const valid = await verifyLoginPassword(input.password, passwordHash);
    if (!valid || account?.credential === null || account === null) return authDenied();
    const sessionToken = randomSessionToken();
    const csrfToken = deriveCsrfToken(ctx.authSecret, sessionToken);
    const result = await ctx.repos.auth.createPasswordSession({
      userId: account.user.id,
      expectedPasswordHash: passwordHash,
      now,
      ...(ctx.principal.kind === 'user' ? { rotateSessionId: ctx.principal.sessionId } : {}),
      session: {
        id: randomAuthId(),
        tokenHash: hashSessionToken(sessionToken),
        csrfHash: hashCsrfToken(csrfToken),
        createdAt: now,
        lastSeenAt: now,
        idleExpiresAt: new Date(now.getTime() + AUTH_SESSION_IDLE_TTL_MS),
        absoluteExpiresAt: new Date(now.getTime() + AUTH_SESSION_ABSOLUTE_TTL_MS),
        revokedAt: null,
      },
    });
    if (result === null) return authDenied();
    return { sessionToken, userId: result.user.id, tenantStatus: result.tenant.status };
  },
});

export const changeLoginPasswordTool = definePlatformTool({
  name: 'change_login_password',
  description:
    'Set an initial password or verify the current password before changing it and revoking sessions.',
  sideEffect: 'write',
  actors: ['user'],
  input: z
    .object({
      currentPassword: z.string().min(1).max(128).optional(),
      newPassword: LoginPasswordSchema,
    })
    .strict(),
  output: z.object({ changed: z.literal(true), requiresLogin: z.literal(true) }),
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'user') return authDenied();
    const now = ctx.clock();
    const credential = await ctx.repos.auth.findPasswordByUserId(ctx.principal.userId);
    if (credential === null) {
      if (!sessionHasRecentAuthentication(ctx.principal.authenticatedAt, now))
        return {
          ok: false,
          error: { kind: 'permission_denied', required: 'auth:recent-email-verification' },
        };
    } else {
      const allowed = await ctx.repos.auth.reservePasswordAttempt({
        id: randomAuthId(),
        emailHash: hashLoginEmail(ctx.authSecret, ctx.principal.userId),
        ipHash: ctx.principal.ipKey,
        now,
      });
      if (!allowed)
        return {
          ok: false,
          error: { kind: 'permission_denied', required: 'auth:password-rate-limit' },
        };
      if (
        input.currentPassword === undefined ||
        !(await verifyLoginPassword(input.currentPassword, credential.passwordHash))
      )
        return authDenied();
    }
    const changed = await ctx.repos.auth.changePassword({
      userId: ctx.principal.userId,
      sessionId: ctx.principal.sessionId,
      expectedPasswordHash: credential?.passwordHash ?? null,
      passwordHash: await hashLoginPassword(input.newPassword),
      now,
    });
    return changed ? { changed: true as const, requiresLogin: true as const } : authDenied();
  },
});

export const resolveAuthSessionTool = definePlatformTool({
  name: 'resolve_auth_session',
  description: 'Resolve and extend an unexpired session from the trusted cookie transport.',
  sideEffect: 'write',
  actors: ['anonymous', 'user'],
  input: z.object({ sessionToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  output: z.object({
    user: HostedUserSchema,
    tenant: TenantSchema,
    session: HostedSessionSchema,
    csrfToken: z.string(),
    principal: PlatformPrincipalSchema,
  }),
  handler: async (input, ctx) => {
    if (ctx.principal.kind !== 'anonymous' && ctx.principal.kind !== 'user') return authDenied();
    const result = await ctx.repos.auth.resolveSession({
      tokenHash: hashSessionToken(input.sessionToken),
      now: ctx.clock(),
      touch: true,
      idleTtlMs: AUTH_SESSION_IDLE_TTL_MS,
    });
    if (result === null) return authDenied();
    const csrfToken = deriveCsrfToken(ctx.authSecret, input.sessionToken);
    if (hashCsrfToken(csrfToken) !== result.session.csrfHash) return authDenied();
    return {
      ...result,
      csrfToken,
      principal: {
        kind: 'user' as const,
        userId: result.user.id,
        tenantId: result.tenant.id,
        tenantGeneration: result.tenant.generation,
        sessionId: result.session.id,
        tokenHash: result.session.tokenHash,
        csrfHash: result.session.csrfHash,
        csrfToken,
        authenticatedAt: result.session.createdAt,
        requestId: ctx.principal.requestId,
        ipKey: ctx.principal.ipKey,
      },
    };
  },
});

export const getPlatformMeTool = definePlatformTool({
  name: 'get_platform_me',
  description: 'Read the current user, tenant initialization state and session-bound CSRF token.',
  sideEffect: 'read',
  actors: ['user'],
  input: z.object({}).strict(),
  output: z.object({
    user: HostedUserSchema.pick({ id: true, email: true, status: true }),
    tenant: TenantSchema.pick({
      id: true,
      status: true,
      generation: true,
      provisioningErrorKind: true,
    }),
    csrfToken: z.string(),
    authenticatedAt: z.date(),
    sessionExpiresAt: z.date(),
    passwordConfigured: z.boolean(),
  }),
  handler: async (_input, ctx) => {
    if (ctx.principal.kind !== 'user') return authDenied();
    const result = await ctx.repos.auth.resolveSession({
      tokenHash: ctx.principal.tokenHash,
      now: ctx.clock(),
      touch: false,
    });
    if (
      result === null ||
      result.user.id !== ctx.principal.userId ||
      result.tenant.id !== ctx.principal.tenantId ||
      result.tenant.generation !== ctx.principal.tenantGeneration
    )
      return authDenied();
    return {
      user: { id: result.user.id, email: result.user.email, status: result.user.status },
      tenant: {
        id: result.tenant.id,
        status: result.tenant.status,
        generation: result.tenant.generation,
        provisioningErrorKind: result.tenant.provisioningErrorKind,
      },
      csrfToken: ctx.principal.csrfToken,
      authenticatedAt: result.session.createdAt,
      sessionExpiresAt: result.session.idleExpiresAt,
      passwordConfigured: (await ctx.repos.auth.findPasswordByUserId(result.user.id)) !== null,
    };
  },
});

export const revokeAuthSessionTool = definePlatformTool({
  name: 'revoke_auth_session',
  description: 'Immediately revoke the current session.',
  sideEffect: 'write',
  actors: ['user'],
  input: z.object({}).strict(),
  output: z.object({ revoked: z.literal(true) }),
  handler: async (_input, ctx) => {
    if (ctx.principal.kind !== 'user') return authDenied();
    await ctx.repos.auth.revokeSession({ id: ctx.principal.sessionId, now: ctx.clock() });
    return { revoked: true as const };
  },
});

export const platformAuthTools = [
  requestAuthChallengeTool,
  createAuthSessionTool,
  createPasswordSessionTool,
  changeLoginPasswordTool,
  resolveAuthSessionTool,
  getPlatformMeTool,
  revokeAuthSessionTool,
] as const;
