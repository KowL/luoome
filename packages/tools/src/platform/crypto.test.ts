import { describe, expect, it } from 'vitest';
import {
  createAuthChallengeDigest,
  deriveCsrfToken,
  hashCsrfToken,
  hashSessionToken,
  randomAuthId,
  randomOtpCode,
  randomSessionToken,
  requireAuthSecret,
  verifyCsrfToken,
} from './crypto.js';

const secret = 'fixture-authentication-secret-32-bytes-minimum';

describe('hosted authentication cryptography', () => {
  it('uses 256-bit opaque identities and sessions and exactly six OTP digits', () => {
    expect(Buffer.from(randomAuthId(), 'base64url').length).toBe(32);
    expect(Buffer.from(randomSessionToken(), 'base64url').length).toBe(32);
    expect(randomOtpCode()).toMatch(/^\d{6}$/);
  });

  it('binds the HMAC to challenge, identity, purpose and secret', () => {
    const input = {
      challengeId: 'challenge-1',
      emailKey: 'a@example.test',
      purpose: 'login' as const,
      code: '012345',
    };
    const digest = createAuthChallengeDigest(secret, input);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(createAuthChallengeDigest(secret, { ...input, challengeId: 'challenge-2' })).not.toBe(
      digest,
    );
    expect(createAuthChallengeDigest(`${secret}x`, input)).not.toBe(digest);
    expect(createAuthChallengeDigest(secret, { ...input, purpose: 'reauth' })).not.toBe(digest);
  });

  it('derives and verifies CSRF exclusively for the original session', () => {
    const token = randomSessionToken();
    const csrf = deriveCsrfToken(secret, token);
    expect(hashSessionToken(token)).not.toBe(token);
    expect(verifyCsrfToken(csrf, hashCsrfToken(csrf))).toBe(true);
    expect(
      verifyCsrfToken(deriveCsrfToken(secret, randomSessionToken()), hashCsrfToken(csrf)),
    ).toBe(false);
    expect(verifyCsrfToken(csrf, 'malformed-hash')).toBe(false);
  });

  it('rejects an undersized authentication secret', () => {
    expect(() => requireAuthSecret('short')).toThrow('at least 32 bytes');
  });
});
