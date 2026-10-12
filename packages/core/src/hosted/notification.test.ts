import { describe, expect, it } from 'vitest';
import {
  defaultNotificationPreferences,
  HostedQuietHoursSchema,
  hostedQuietUntil,
} from './notification.js';

describe('hosted notification preferences', () => {
  it('defaults to minimal content, no email and the Shanghai quiet window', () => {
    const preferences = defaultNotificationPreferences(
      't1',
      'u1',
      new Date('2026-10-10T10:00:00.000Z'),
    );
    expect(preferences.emailEnabled).toBe(false);
    expect(preferences.detail).toBe('minimal');
    expect(preferences.quietHours).toEqual({
      enabled: true,
      startMinutes: 1320,
      endMinutes: 480,
      timeZone: 'Asia/Shanghai',
    });
    expect(preferences.revision).toBe(0);
  });

  it('defers both sides of midnight to the same next 08:00 Shanghai', () => {
    const quiet = defaultNotificationPreferences('t', 'u', new Date()).quietHours;
    expect(hostedQuietUntil(quiet, new Date('2026-10-10T14:00:00.000Z'))).toEqual(
      new Date('2026-10-11T00:00:00.000Z'),
    );
    expect(hostedQuietUntil(quiet, new Date('2026-10-10T23:59:59.000Z'))).toEqual(
      new Date('2026-10-11T00:00:00.000Z'),
    );
    expect(hostedQuietUntil(quiet, new Date('2026-10-11T00:00:00.000Z'))).toBeNull();
  });

  it('supports an optional daytime or disabled quiet window without equating equal endpoints to 24 hours', () => {
    const quiet = {
      enabled: true,
      startMinutes: 600,
      endMinutes: 720,
      timeZone: 'Asia/Shanghai' as const,
    };
    expect(hostedQuietUntil(quiet, new Date('2026-10-10T02:15:00.000Z'))).toEqual(
      new Date('2026-10-10T04:00:00.000Z'),
    );
    expect(
      hostedQuietUntil({ ...quiet, enabled: false }, new Date('2026-10-10T02:15:00.000Z')),
    ).toBeNull();
    expect(
      HostedQuietHoursSchema.safeParse({ ...quiet, endMinutes: quiet.startMinutes }).success,
    ).toBe(false);
  });
});
