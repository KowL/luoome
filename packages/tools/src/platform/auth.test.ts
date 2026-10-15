import { UnconfiguredEmailOtpAdapter } from '@luoome/adapters/hosted';
import { describe, expect, it } from 'vitest';
import {
  changeLoginPasswordTool,
  createAuthSessionTool,
  createPasswordSessionTool,
  getPlatformMeTool,
  requestAuthChallengeTool,
  resolveAuthSessionTool,
  revokeAuthSessionTool,
} from './auth.js';
import { buildPlatformContext } from './context.js';
import { createAuthChallengeDigest } from './crypto.js';
import {
  buildPlatformTestContext,
  loginPlatformTestUser,
  PLATFORM_TEST_NOW,
  PLATFORM_TEST_SECRET,
  provisionPlatformTestTenant,
} from './testing-context.js';

describe('platform login tools', () => {
  it('requires email verification for password registration, then signs in without sending email', async () => {
    const fixture = buildPlatformTestContext();
    const challenge = await requestAuthChallengeTool.execute(
      { email: 'Password@Example.test' },
      fixture.ctx,
    );
    if (!challenge.ok) throw new Error('challenge failed');
    const code = fixture.emailOtp.getMessage(challenge.data.challengeId)?.code;
    const registered = await createAuthSessionTool.execute(
      { challengeId: challenge.data.challengeId, code, password: 'fixture-password' },
      fixture.ctx,
    );
    if (!registered.ok) throw new Error('registration failed');
    const credential = await fixture.ctx.repos.auth.findPasswordByUserId(registered.data.user.id);
    expect(credential?.passwordHash).not.toContain('fixture-password');
    expect(registered.data.user).not.toHaveProperty('passwordHash');
    const loggedIn = await createPasswordSessionTool.execute(
      { email: 'password@example.test', password: 'fixture-password' },
      fixture.ctx,
    );
    expect(loggedIn.ok && loggedIn.data.userId).toBe(registered.data.user.id);
    expect(await fixture.ctx.repos.tenants.list()).toHaveLength(1);
    expect(
      (
        await createPasswordSessionTool.execute(
          { email: 'password@example.test', password: 'wrong-password' },
          fixture.ctx,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await createPasswordSessionTool.execute(
          { email: 'unknown@example.test', password: 'wrong-password' },
          fixture.ctx,
        )
      ).ok,
    ).toBe(false);
  });

  it('lets a recently verified legacy user set a password, then verifies the current password and revokes all sessions', async () => {
    const fixture = buildPlatformTestContext();
    const legacy = await loginPlatformTestUser(fixture);
    expect(
      await changeLoginPasswordTool.execute({ newPassword: 'fixture-first-password' }, legacy.ctx),
    ).toEqual({ ok: true, data: { changed: true, requiresLogin: true } });
    expect(
      (await resolveAuthSessionTool.execute({ sessionToken: legacy.sessionToken }, fixture.ctx)).ok,
    ).toBe(false);
    const loggedIn = await createPasswordSessionTool.execute(
      { email: legacy.user.email, password: 'fixture-first-password' },
      fixture.ctx,
    );
    if (!loggedIn.ok) throw new Error('password login failed');
    const resolved = await resolveAuthSessionTool.execute(
      { sessionToken: loggedIn.data.sessionToken },
      fixture.ctx,
    );
    if (!resolved.ok) throw new Error('session failed');
    const ctx = buildPlatformContext({ ...fixture.ctx, principal: resolved.data.principal });
    expect(
      (
        await changeLoginPasswordTool.execute(
          { currentPassword: 'wrong-password', newPassword: 'fixture-second-password' },
          ctx,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await changeLoginPasswordTool.execute(
          { currentPassword: 'fixture-first-password', newPassword: 'fixture-second-password' },
          ctx,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await createPasswordSessionTool.execute(
          { email: legacy.user.email, password: 'fixture-first-password' },
          fixture.ctx,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await createPasswordSessionTool.execute(
          { email: legacy.user.email, password: 'fixture-second-password' },
          fixture.ctx,
        )
      ).ok,
    ).toBe(true);
    expect(
      (
        await resolveAuthSessionTool.execute(
          { sessionToken: loggedIn.data.sessionToken },
          fixture.ctx,
        )
      ).ok,
    ).toBe(false);
  });

  it('does not install a password from an expired legacy verification or leak credentials through errors', async () => {
    let now = new Date(PLATFORM_TEST_NOW);
    const fixture = buildPlatformTestContext({ clock: () => now });
    const legacy = await loginPlatformTestUser(fixture);
    now = new Date(now.getTime() + 600_001);
    const result = await changeLoginPasswordTool.execute(
      { newPassword: 'private-new-password' },
      legacy.ctx,
    );
    expect(result).toEqual({
      ok: false,
      error: { kind: 'permission_denied', required: 'auth:recent-email-verification' },
    });
    expect(JSON.stringify(result)).not.toContain('private-new-password');
    expect(await fixture.ctx.repos.auth.findPasswordByUserId(legacy.user.id)).toBeNull();
  });
  it('stores only HMAC/hash credentials and creates exactly one provisioning tenant', async () => {
    const fixture = buildPlatformTestContext();
    const requested = await requestAuthChallengeTool.execute(
      { email: 'A.B+Research@Example.test' },
      fixture.ctx,
    );
    expect(requested.ok).toBe(true);
    if (!requested.ok) return;
    expect(requested.data).not.toHaveProperty('code');
    const message = fixture.emailOtp.getMessage(requested.data.challengeId);
    if (message === undefined) throw new Error('missing fixture email');
    const stored = await fixture.ctx.repos.auth.findChallenge(requested.data.challengeId);
    expect(stored?.emailKey).toBe('a.b+research@example.test');
    expect(stored).not.toHaveProperty('code');
    expect(stored?.digest).toBe(
      createAuthChallengeDigest(PLATFORM_TEST_SECRET, {
        challengeId: requested.data.challengeId,
        emailKey: 'a.b+research@example.test',
        purpose: 'login',
        code: message.code,
      }),
    );
    const results = await Promise.all([
      createAuthSessionTool.execute(
        { challengeId: requested.data.challengeId, code: message.code },
        fixture.ctx,
      ),
      createAuthSessionTool.execute(
        { challengeId: requested.data.challengeId, code: message.code },
        fixture.ctx,
      ),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const login = results.find((result) => result.ok);
    if (login === undefined || !login.ok) return;
    expect(login.data.tenant.status).toBe('provisioning');
    expect(login.data.session.tokenHash).not.toBe(login.data.sessionToken);
    expect(login.data.session.csrfHash).not.toBe(login.data.csrfToken);
    expect(await fixture.ctx.repos.tenants.list()).toHaveLength(1);
    const jobs = await fixture.ctx.repos.jobs.list({});
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.kind).toBe('provision-tenant');
    expect(jobs[0]?.tenantId).toBe(login.data.tenant.id);
  });

  it('invalidates the previous challenge when resending and rejects replay', async () => {
    let now = new Date(PLATFORM_TEST_NOW);
    const fixture = buildPlatformTestContext({ clock: () => now });
    const first = await requestAuthChallengeTool.execute({ email: 'r@example.test' }, fixture.ctx);
    if (!first.ok) throw new Error('request failed');
    const old = fixture.emailOtp.getMessage(first.data.challengeId);
    now = new Date(now.getTime() + 60_000);
    const second = await requestAuthChallengeTool.execute({ email: 'R@example.test' }, fixture.ctx);
    expect(second.ok).toBe(true);
    expect(
      (await fixture.ctx.repos.auth.findChallenge(first.data.challengeId))?.invalidatedAt,
    ).toEqual(now);
    expect(
      (
        await createAuthSessionTool.execute(
          { challengeId: first.data.challengeId, code: old?.code },
          fixture.ctx,
        )
      ).ok,
    ).toBe(false);
  });

  it('blocks the sixth attempt even when its OTP is correct', async () => {
    const fixture = buildPlatformTestContext();
    const challenge = await requestAuthChallengeTool.execute(
      { email: 'r@example.test' },
      fixture.ctx,
    );
    if (!challenge.ok) throw new Error('request failed');
    const code = fixture.emailOtp.getMessage(challenge.data.challengeId)?.code;
    const wrong = code === '000000' ? '000001' : '000000';
    for (let attempt = 0; attempt < 5; attempt++)
      expect(
        (
          await createAuthSessionTool.execute(
            { challengeId: challenge.data.challengeId, code: wrong },
            fixture.ctx,
          )
        ).ok,
      ).toBe(false);
    expect(
      (
        await createAuthSessionTool.execute(
          { challengeId: challenge.data.challengeId, code },
          fixture.ctx,
        )
      ).ok,
    ).toBe(false);
    expect((await fixture.ctx.repos.auth.findChallenge(challenge.data.challengeId))?.attempts).toBe(
      5,
    );
  });

  it('does not accept expired challenges', async () => {
    let now = new Date(PLATFORM_TEST_NOW);
    const fixture = buildPlatformTestContext({ clock: () => now });
    const challenge = await requestAuthChallengeTool.execute(
      { email: 'r@example.test' },
      fixture.ctx,
    );
    if (!challenge.ok) throw new Error('request failed');
    now = new Date(now.getTime() + 300_000);
    expect(
      (
        await createAuthSessionTool.execute(
          {
            challengeId: challenge.data.challengeId,
            code: fixture.emailOtp.getMessage(challenge.data.challengeId)?.code,
          },
          fixture.ctx,
        )
      ).ok,
    ).toBe(false);
  });

  it('supports initialization status, revocation and immediate rejection of the old cookie', async () => {
    const fixture = buildPlatformTestContext();
    const user = await loginPlatformTestUser(fixture);
    const me = await getPlatformMeTool.execute({}, user.ctx);
    expect(me.ok && me.data.tenant.status).toBe('provisioning');
    expect(me.ok && me.data.csrfToken).toBe(user.csrfToken);
    expect(me.ok && Object.keys(me.data)).not.toContain('sessionToken');
    expect(await revokeAuthSessionTool.execute({}, user.ctx)).toEqual({
      ok: true,
      data: { revoked: true },
    });
    expect(
      (await resolveAuthSessionTool.execute({ sessionToken: user.sessionToken }, fixture.ctx)).ok,
    ).toBe(false);
    expect((await getPlatformMeTool.execute({}, user.ctx)).ok).toBe(false);
  });

  it('extends idle expiration without extending the absolute lifetime', async () => {
    let now = new Date(PLATFORM_TEST_NOW);
    const fixture = buildPlatformTestContext({ clock: () => now });
    const user = await loginPlatformTestUser(fixture);
    for (let day = 6; day <= 24; day += 6) {
      now = new Date(PLATFORM_TEST_NOW.getTime() + day * 86_400_000);
      expect(
        (await resolveAuthSessionTool.execute({ sessionToken: user.sessionToken }, fixture.ctx)).ok,
      ).toBe(true);
    }
    now = new Date(PLATFORM_TEST_NOW.getTime() + 29 * 86_400_000);
    const session = await resolveAuthSessionTool.execute(
      { sessionToken: user.sessionToken },
      fixture.ctx,
    );
    expect(session.ok && session.data.session.idleExpiresAt).toEqual(
      user.session.absoluteExpiresAt,
    );
    now = new Date(user.session.absoluteExpiresAt);
    expect(
      (await resolveAuthSessionTool.execute({ sessionToken: user.sessionToken }, fixture.ctx)).ok,
    ).toBe(false);
  });

  it('rotates the authenticated session while retaining the same user and tenant', async () => {
    let now = new Date(PLATFORM_TEST_NOW);
    const fixture = buildPlatformTestContext({ clock: () => now });
    const user = await loginPlatformTestUser(fixture);
    now = new Date(now.getTime() + 60_000);
    const challenge = await requestAuthChallengeTool.execute(
      { email: 'Research@example.test' },
      user.ctx,
    );
    if (!challenge.ok) throw new Error('request failed');
    const rotated = await createAuthSessionTool.execute(
      {
        challengeId: challenge.data.challengeId,
        code: fixture.emailOtp.getMessage(challenge.data.challengeId)?.code,
      },
      user.ctx,
    );
    expect(rotated.ok && rotated.data.tenant.id).toBe(user.tenant.id);
    expect(rotated.ok && rotated.data.user.id).toBe(user.user.id);
    expect(
      (await resolveAuthSessionTool.execute({ sessionToken: user.sessionToken }, fixture.ctx)).ok,
    ).toBe(false);
  });

  it('honors write/external opt-ins and rejects the unconfigured provider', async () => {
    const fixture = buildPlatformTestContext();
    expect(
      await requestAuthChallengeTool.execute(
        { email: 'r@example.test' },
        { ...fixture.ctx, capabilities: { write: true, external: false } },
      ),
    ).toEqual({ ok: false, error: { kind: 'permission_denied', required: 'external' } });
    const unavailable = await requestAuthChallengeTool.execute(
      { email: 'r@example.test' },
      { ...fixture.ctx, emailOtp: new UnconfiguredEmailOtpAdapter() },
    );
    expect(unavailable).toEqual({
      ok: false,
      error: {
        kind: 'adapter_error',
        adapter: 'email-otp',
        cause: 'provider_unconfigured',
        recoverable: false,
      },
    });
    expect(await fixture.ctx.repos.auth.findChallenge('r')).toBeNull();
  });

  it('does not expose provider exceptions, OTP or secret in failure output', async () => {
    const fixture = buildPlatformTestContext();
    const result = await requestAuthChallengeTool.execute(
      { email: 'r@example.test' },
      {
        ...fixture.ctx,
        emailOtp: {
          configured: true,
          name: 'failing-fixture',
          providerKind: 'fixture',
          sendChallenge: async (input) => {
            throw new Error(`${input.code} ${PLATFORM_TEST_SECRET} ${input.destination}`);
          },
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'adapter_error',
        adapter: 'email-otp',
        cause: 'challenge_delivery_unknown',
        recoverable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain(PLATFORM_TEST_SECRET);
  });

  it('does not acknowledge delivery when the SMTP outcome is unknown', async () => {
    const fixture = buildPlatformTestContext();
    const result = await requestAuthChallengeTool.execute(
      { email: 'r@example.test' },
      {
        ...fixture.ctx,
        emailOtp: {
          configured: true,
          name: 'unknown-fixture',
          providerKind: 'fixture',
          sendChallenge: async () => ({ state: 'unknown' as const }),
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'adapter_error',
        adapter: 'email-otp',
        cause: 'challenge_delivery_unknown',
        recoverable: true,
      },
    });
  });

  it('rejects fixture providers in production', () => {
    const fixture = buildPlatformTestContext();
    expect(() => buildPlatformContext({ ...fixture.ctx, environment: 'production' })).toThrow(
      'Fixture email provider',
    );
  });

  it('keeps platform HTTP origins behind a trusted explicit opt-in', () => {
    const fixture = buildPlatformTestContext();
    const http = { ...fixture.ctx, publicOrigin: 'http://example.test:5173' };
    expect(() => buildPlatformContext(http)).toThrow('HTTPS');
    expect(buildPlatformContext({ ...http, allowInsecureHttp: true }).publicOrigin).toBe(
      http.publicOrigin,
    );
    expect(() =>
      buildPlatformContext({
        ...http,
        allowInsecureHttp: true,
        publicOrigin: 'http://example.test/path',
      }),
    ).toThrow();
  });

  it('prevents new registrations after the cap without blocking existing users', async () => {
    let now = new Date(PLATFORM_TEST_NOW);
    const fixture = buildPlatformTestContext({ maxUsers: 1, clock: () => now });
    const first = await loginPlatformTestUser(fixture, 'first@example.test');
    await provisionPlatformTestTenant(first.ctx);
    const challenge = await requestAuthChallengeTool.execute(
      { email: 'second@example.test' },
      fixture.ctx,
    );
    if (!challenge.ok) throw new Error('request failed');
    expect(
      (
        await createAuthSessionTool.execute(
          {
            challengeId: challenge.data.challengeId,
            code: fixture.emailOtp.getMessage(challenge.data.challengeId)?.code,
          },
          fixture.ctx,
        )
      ).ok,
    ).toBe(false);
    now = new Date(now.getTime() + 60_000);
    const old = await loginPlatformTestUser(fixture, 'first@example.test');
    expect(old.tenant.id).toBe(first.tenant.id);
    expect(await fixture.ctx.repos.tenants.list()).toHaveLength(1);
  });
});
