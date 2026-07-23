import { describe, expect, it, vi } from 'vitest';

import { AdshareClient } from '../client.js';

import { mockFetch } from './helpers.js';

function client(options: Partial<ConstructorParameters<typeof AdshareClient>[0]> = {}) {
  return new AdshareClient({
    url: 'https://adshare.test',
    apiKey: 'secret',
    retries: 0,
    ...options,
  });
}

describe('AdshareClient request behavior', () => {
  it('sends both authentication headers on every endpoint request', async () => {
    const fetchMock = mockFetch([
      { status: 200, body: { data: [{ ts_code: '600519.SH', name: '贵州茅台' }] } },
      {
        status: 200,
        body: {
          data: [
            { ts_code: '600519.SH', trade_date: '20260723', open: 1, high: 2, low: 1, close: 2 },
          ],
        },
      },
      { status: 200, body: { data: { ts_code: '600519.SH', price: 2 } } },
    ]);
    const sdk = client({ fetchImpl: fetchMock });

    await sdk.searchStocks({ name: '茅台' });
    await sdk.getKLine({ ts_code: '600519.SH', period: 'D' });
    await sdk.getQuote('600519.SH');

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('X-API-Key')).toBe('secret');
      expect(headers.get('Authorization')).toBe('Bearer secret');
    }
  });

  it('retries a timed-out request N+1 times and throws TIMEOUT', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as ReturnType<typeof vi.fn<typeof fetch>>;
    const sdk = client({ timeoutMs: 10, retries: 2, fetchImpl: fetchMock });

    await expect(sdk.searchStocks({ name: '茅台' })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws HTTP_ERROR with status for a non-2xx response', async () => {
    const fetchMock = mockFetch([{ status: 404, body: { message: 'not found' } }]);
    await expect(
      client({ fetchImpl: fetchMock, retries: 2 }).searchStocks({ name: 'missing' }),
    ).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid timeout and retry options', () => {
    expect(() => client({ timeoutMs: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(() => client({ retries: -1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });
});
