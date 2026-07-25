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
  it('不带 adshare env 时抛错（启动期 fail-fast）', () => {
    expect(() => createLimitUpLadderManagerFromEnv({}, { logger: noopLogger })).toThrow();
  });

  it('带 ADSHARE_URL 时返回 manager', () => {
    const m = createLimitUpLadderManagerFromEnv(
      { ADSHARE_URL: 'http://test:8888', ADSHARE_API_KEY: 'k' },
      { logger: noopLogger },
    );
    expect(m.name).toBe('limit-up-ladder');
    expect(typeof m.fetchLadder).toBe('function');
    expect(typeof m.compareLadder).toBe('function');
  });

  it('空 adshare env 时启动期 fail-fast', () => {
    expect(() => createLimitUpLadderManagerFromEnv({}, { logger: noopLogger })).toThrow(
      /ADSHARE_URL/,
    );
  });
});
