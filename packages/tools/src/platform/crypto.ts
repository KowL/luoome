import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
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
export const hashLoginEmail = (secret: string, emailKey: string): string =>
  hmac(secret, `password-email-v1\0${emailKey}`);

const passwordKey = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });

export const hashLoginPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const key = await passwordKey(password, salt);
  return `scrypt-v1$${salt.toString('base64url')}$${key.toString('base64url')}`;
};

export const DUMMY_PASSWORD_HASH = `scrypt-v1$${Buffer.alloc(16).toString('base64url')}$${Buffer.alloc(32).toString('base64url')}`;
export const verifyLoginPassword = async (password: string, encoded: string): Promise<boolean> => {
  const [, salt, expected] = encoded.split('$');
  const key = await passwordKey(password, Buffer.from(salt as string, 'base64url'));
  return timingSafeEqual(key, Buffer.from(expected as string, 'base64url'));
};

export const verifyCsrfToken = (token: string, expectedHash: string): boolean => {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  return timingSafeEqual(
    Buffer.from(hashCsrfToken(token), 'hex'),
    Buffer.from(expectedHash, 'hex'),
  );
};
