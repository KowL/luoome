// 看盘自动刷新节奏单测：排期只由服务端给的交易时段与下次开盘时间决定，
// 客户端不自己判断交易日历、不把未知时段当成交易中。
import { describe, expect, it } from 'vitest';
import {
  IDLE_REFRESH_INTERVAL_MS,
  nextRefreshDelayMs,
  TRADING_REFRESH_INTERVAL_MS,
} from './auto-refresh.js';

describe('panel auto refresh schedule', () => {
  it('polls every minute while the market is trading', () => {
    expect(nextRefreshDelayMs({ marketSession: 'trading' })).toBe(TRADING_REFRESH_INTERVAL_MS);
    expect(
      nextRefreshDelayMs({
        marketSession: 'trading',
        nextSessionStart: '2026-10-26T05:30:00.000Z',
        now: new Date('2026-10-26T02:00:00.000Z'),
      }),
    ).toBe(TRADING_REFRESH_INTERVAL_MS);
  });

  it('waits for the next session start outside trading hours', () => {
    expect(
      nextRefreshDelayMs({
        marketSession: 'closed',
        nextSessionStart: '2026-10-26T05:30:00.000Z',
        now: new Date('2026-10-26T02:00:00.000Z'),
      }),
    ).toBe(3.5 * 60 * 60 * 1000);
  });

  it('falls back to the idle interval without a usable next session start', () => {
    const now = new Date('2026-10-26T02:00:00.000Z');
    expect(nextRefreshDelayMs({ marketSession: 'closed', now })).toBe(IDLE_REFRESH_INTERVAL_MS);
    expect(nextRefreshDelayMs({ marketSession: 'closed', nextSessionStart: null, now })).toBe(
      IDLE_REFRESH_INTERVAL_MS,
    );
    expect(
      nextRefreshDelayMs({ marketSession: 'closed', nextSessionStart: 'not-a-date', now }),
    ).toBe(IDLE_REFRESH_INTERVAL_MS);
  });

  it('falls back to the idle interval when the next session start already passed', () => {
    expect(
      nextRefreshDelayMs({
        marketSession: 'midday-break',
        nextSessionStart: '2026-10-26T01:00:00.000Z',
        now: new Date('2026-10-26T02:00:00.000Z'),
      }),
    ).toBe(IDLE_REFRESH_INTERVAL_MS);
  });

  it('treats an unknown session as idle instead of trading', () => {
    const now = new Date('2026-10-26T02:00:00.000Z');
    expect(nextRefreshDelayMs({ marketSession: undefined, now })).toBe(IDLE_REFRESH_INTERVAL_MS);
    expect(nextRefreshDelayMs({})).toBe(IDLE_REFRESH_INTERVAL_MS);
  });

  it('still counts down to the next session start when the session label is unknown', () => {
    expect(
      nextRefreshDelayMs({
        marketSession: 'unknown-session',
        nextSessionStart: '2026-10-26T05:30:00.000Z',
        now: new Date('2026-10-26T02:00:00.000Z'),
      }),
    ).toBe(3.5 * 60 * 60 * 1000);
  });
});
