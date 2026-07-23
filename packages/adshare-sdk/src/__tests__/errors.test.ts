import { describe, expect, it } from 'vitest';

import { AdshareError } from '../errors.js';

describe('AdshareError', () => {
  it('preserves code, status, and cause', () => {
    const cause = new Error('root cause');
    const error = new AdshareError('HTTP_ERROR', 'request failed', { status: 503, cause });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AdshareError');
    expect(error.code).toBe('HTTP_ERROR');
    expect(error.status).toBe(503);
    expect(error.cause).toBe(cause);
  });
});
