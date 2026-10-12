import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { AuthChallengePurpose } from '@luoome/core';

export const requireAuthSecret = (secret: string): void => {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('Hosted authentication secret must contain at least 32 bytes');
  }
};

export const randomAuthId = (): string => randomBytes(32).toString('base64url');
export const randomSessionToken = (): string => randomBytes(32).toString('base64url');
export const randomOtpCode = (): string => randomInt(1_000_000).toString().padStart(6, '0');

const hmac = (secret: string, value: string): string =>
  createHmac('sha256', secret).update(value).digest('hex');

export const createAuthChallengeDigest = (
  secret: string,
  input: {
    readonly challengeId: string;
    readonly emailKey: string;
    readonly purpose: AuthChallengePurpose;
    readonly code: string;
  },
): string =>
  hmac(
    secret,
    JSON.stringify(['auth-otp-v1', input.challengeId, input.emailKey, input.purpose, input.code]),
  );

export const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const hashCsrfToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const deriveCsrfToken = (secret: string, sessionToken: string): string =>
  hmac(secret, `csrf-v1\0${sessionToken}`);

export const hashAuthIp = (secret: string, ip: string): string => hmac(secret, `auth-ip-v1\0${ip}`);

export const verifyCsrfToken = (token: string, expectedHash: string): boolean => {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  return timingSafeEqual(
    Buffer.from(hashCsrfToken(token), 'hex'),
    Buffer.from(expectedHash, 'hex'),
  );
};
