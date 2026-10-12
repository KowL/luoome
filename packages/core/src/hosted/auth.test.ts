import { describe, expect, it } from 'vitest';
import {
  HostedExecutionIdentitySchema,
  normalizeLoginEmail,
  sessionHasRecentAuthentication,
} from './auth.js';

describe('hosted authentication contracts', () => {
  it('preserves delivery spelling, dot and plus tag while normalizing the unique key', () => {
    expect(normalizeLoginEmail('  A.B+Research@Example.com  ')).toEqual({
      email: 'A.B+Research@Example.com',
      emailKey: 'a.b+research@example.com',
    });
    expect(normalizeLoginEmail('ab@example.com').emailKey).not.toBe(
      normalizeLoginEmail('a.b+research@example.com').emailKey,
    );
  });

  it('requires a complete hosted identity and a positive tenant generation', () => {
    expect(HostedExecutionIdentitySchema.safeParse({ mode: 'hosted', userId: 'u' }).success).toBe(
      false,
    );
    expect(
      HostedExecutionIdentitySchema.safeParse({
        mode: 'hosted',
        userId: 'u',
        tenantId: 't',
        tenantGeneration: 0,
        actor: 'user',
        requestId: 'r',
      }).success,
    ).toBe(false);
  });

  it('limits sensitive-operation authentication to the previous ten minutes', () => {
    const now = new Date('2026-10-10T00:10:00.000Z');
    expect(sessionHasRecentAuthentication(new Date('2026-10-10T00:00:00.000Z'), now)).toBe(true);
    expect(sessionHasRecentAuthentication(new Date('2026-10-09T23:59:59.999Z'), now)).toBe(false);
    expect(sessionHasRecentAuthentication(new Date('2026-10-10T00:10:00.001Z'), now)).toBe(false);
  });
});
