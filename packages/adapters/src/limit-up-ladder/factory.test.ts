import type { Logger } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { createLimitUpLadderManagerFromEnv } from './factory.js';

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('createLimitUpLadderManagerFromEnv', () => {
  it('不带 adshare env 时不抛错，返回软失败 manager（调用全部返回 adapter_error）', async () => {
    const m = createLimitUpLadderManagerFromEnv({}, { logger: noopLogger });
    expect(m.name).toBe('limit-up-ladder');
    const r = await m.fetchLadder({
      date: '2026-07-25',
      source: 'adshare',
      days: 15,
      includeUncategorized: false,
      includeStar: false,
      includeBse: false,
      includeST: false,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error?.message).toMatch(/upstream-unavailable/);
  });

  it('带 ADSHARE_URL 时返回可用 manager', () => {
    const m = createLimitUpLadderManagerFromEnv(
      { ADSHARE_URL: 'http://test:8888', ADSHARE_API_KEY: 'k' },
      { logger: noopLogger },
    );
    expect(m.name).toBe('limit-up-ladder');
    expect(typeof m.fetchLadder).toBe('function');
    expect(typeof m.compareLadder).toBe('function');
  });

  it('空 adshare env 时仍不抛错（Phase 2 软失败契约）', () => {
    expect(() => createLimitUpLadderManagerFromEnv({}, { logger: noopLogger })).not.toThrow();
  });
});
