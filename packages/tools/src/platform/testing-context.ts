import { FixtureEmailOtpAdapter } from '@luoome/adapters/hosted';
import type { PlatformRepositoryRegistry } from '@luoome/core';
import { createInMemoryPlatformRepos } from '@luoome/db/memory';
import { createAuthSessionTool, requestAuthChallengeTool, resolveAuthSessionTool } from './auth.js';
import { buildPlatformContext, type PlatformContext } from './context.js';
import { claimHostedJobTool, completeTenantProvisioningTool } from './jobs.js';

export const PLATFORM_TEST_NOW = new Date('2026-10-10T01:00:00.000Z');
export const PLATFORM_TEST_SECRET = 'fixture-authentication-secret-32-bytes-minimum';

export const buildPlatformTestContext = (
  input: {
    readonly repos?: PlatformRepositoryRegistry;
    readonly clock?: () => Date;
    readonly registrationEnabled?: boolean;
    readonly maxUsers?: number;
  } = {},
) => {
  const emailOtp = new FixtureEmailOtpAdapter();
  const ctx = buildPlatformContext({
    repos: input.repos ?? createInMemoryPlatformRepos(),
    principal: { kind: 'anonymous', ipKey: 'a'.repeat(64), requestId: 'fixture-http-request' },
    authSecret: PLATFORM_TEST_SECRET,
    environment: 'development',
    emailOtp,
    registration: { enabled: input.registrationEnabled ?? true, maxUsers: input.maxUsers ?? 30 },
    capabilities: { write: true, external: true },
    jobPolicies: {
      'watchlist-facts': {
        units: 1,
        partialUnits: 0,
        budgetMicro: 100_000,
        priority: 50,
        acceptDeadlineMs: 900_000,
      },
    },
    clock: input.clock ?? (() => new Date(PLATFORM_TEST_NOW)),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return { ctx, emailOtp };
};

export const loginPlatformTestUser = async (
  fixture: ReturnType<typeof buildPlatformTestContext>,
  email = 'research@example.test',
) => {
  const challenge = await requestAuthChallengeTool.execute({ email }, fixture.ctx);
  if (!challenge.ok) throw new Error(`Fixture challenge failed: ${challenge.error.kind}`);
  const message = fixture.emailOtp.getMessage(challenge.data.challengeId);
  if (message === undefined) throw new Error('Fixture challenge was not delivered');
  const login = await createAuthSessionTool.execute(
    { challengeId: challenge.data.challengeId, code: message.code },
    fixture.ctx,
  );
  if (!login.ok) throw new Error(`Fixture login failed: ${login.error.kind}`);
  const resolved = await resolveAuthSessionTool.execute(
    { sessionToken: login.data.sessionToken },
    fixture.ctx,
  );
  if (!resolved.ok) throw new Error(`Fixture session failed: ${resolved.error.kind}`);
  const userCtx = buildPlatformContext({ ...fixture.ctx, principal: resolved.data.principal });
  return { ...login.data, ctx: userCtx };
};

export const buildPlatformWorkerTestContext = (ctx: PlatformContext): PlatformContext =>
  buildPlatformContext({
    ...ctx,
    principal: { kind: 'worker', workerId: 'fixture-worker', requestId: 'fixture-worker-request' },
  });

export const provisionPlatformTestTenant = async (ctx: PlatformContext) => {
  const worker = buildPlatformWorkerTestContext(ctx);
  const claim = await claimHostedJobTool.execute({}, worker);
  if (!claim.ok || claim.data === null || claim.data.attemptId === null)
    throw new Error('Fixture provisioning could not claim');
  const result = await completeTenantProvisioningTool.execute(
    {
      jobId: claim.data.id,
      fence: claim.data.fence,
      attemptId: claim.data.attemptId,
      schemaVersion: 1,
    },
    worker,
  );
  if (!result.ok) throw new Error(`Fixture provisioning failed: ${result.error.kind}`);
  return result.data;
};
