import { describe, expect, it } from 'vitest';

import {
  assertWatchlistInvariants,
  assertWatchlistMemberInvariants,
  assertWatchlistMemberSourceInvariants,
} from './watchlist.js';

const T = new Date('2026-07-29T00:00:00Z');

describe('Watchlist invariants', () => {
  it('enforces portfolio synced policy', () => {
    expect(() =>
      assertWatchlistInvariants({
        id: 'portfolio-main',
        name: '持仓',
        kind: 'portfolio',
        membershipPolicy: 'manual',
        enabled: true,
        createdAt: T,
        updatedAt: T,
      }),
    ).toThrow('portfolio');
  });

  it('keeps WatchlistMember focused on the active relationship', () => {
    expect(() =>
      assertWatchlistMemberInvariants({
        id: 'member-1',
        watchlistId: 'watchlist-1',
        stockId: '600519.SH',
        priority: 'normal',
        firstAddedAt: T,
        lastActivityAt: T,
      }),
    ).not.toThrow();
  });

  it('requires source key prefix and ended validity', () => {
    expect(() =>
      assertWatchlistMemberSourceInvariants({
        id: 'source-1',
        memberId: 'member-1',
        kind: 'strategy',
        sourceKey: 'ai:wrong',
        reason: 'test',
        status: 'active',
        evidence: [],
        validFrom: T,
      }),
    ).toThrow('前缀');
  });
});
