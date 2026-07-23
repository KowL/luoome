import { describe, expect, it } from 'vitest';

import { fromEnv } from '../config.js';

describe('Adshare environment config', () => {
  it('reads URL, API key, timeout, and retries', () => {
    expect(
      fromEnv({
        ADSHARE_URL: 'https://adshare.test/',
        ADSHARE_API_KEY: 'secret',
        ADSHARE_TIMEOUT_MS: '2500',
        ADSHARE_MAX_RETRIES: '4',
      }),
    ).toEqual({
      url: 'https://adshare.test',
      apiKey: 'secret',
      timeoutMs: 2500,
      retries: 4,
    });
  });

  it('uses runtime defaults for optional values', () => {
    expect(fromEnv({ ADSHARE_URL: 'http://localhost:8888' })).toEqual({
      url: 'http://localhost:8888',
      apiKey: '',
      timeoutMs: 10_000,
      retries: 2,
    });
  });

  it('rejects malformed configuration', () => {
    expect(() => fromEnv({ ADSHARE_URL: 'not-a-url' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_MISSING' }),
    );
    expect(() => fromEnv({ ADSHARE_URL: 'https://adshare.test', ADSHARE_TIMEOUT_MS: '0' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_MISSING' }),
    );
  });
});
