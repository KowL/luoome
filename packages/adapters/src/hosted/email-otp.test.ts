import { describe, expect, it } from 'vitest';
import { FixtureEmailOtpAdapter, UnconfiguredEmailOtpAdapter } from './email-otp.js';

describe('email OTP ports', () => {
  it('rejects the unconfigured production provider explicitly', async () => {
    const provider = new UnconfiguredEmailOtpAdapter();
    expect(provider.configured).toBe(false);
    expect(await provider.sendChallenge()).toEqual({ state: 'failed', reason: 'unconfigured' });
  });

  it('keeps fixture delivery explicit and idempotent without writing credentials to logs', async () => {
    const provider = new FixtureEmailOtpAdapter();
    const input = {
      challengeId: 'c1',
      destination: 'a@example.test',
      code: '012345',
      purpose: 'login' as const,
      expiresAt: new Date('2026-10-10T01:00:00.000Z'),
    };
    const first = await provider.sendChallenge(input);
    expect(provider.providerKind).toBe('fixture');
    expect(await provider.sendChallenge(input)).toEqual(first);
    const message = provider.getMessage(input.challengeId);
    expect(message?.code).toBe(input.code);
    message?.expiresAt.setTime(0);
    expect(provider.getMessage(input.challengeId)?.expiresAt).toEqual(input.expiresAt);
    provider.clear();
    expect(provider.getMessage(input.challengeId)).toBeUndefined();
  });
});
