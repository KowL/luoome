import { describe, expect, it } from 'vitest';

import { AdshareClient } from '../client.js';

import { StockBasicSchema } from '../schemas.js';
import { mockFetch } from './helpers.js';

describe('response schemas', () => {
  it('rejects an invalid Zod payload as PARSE_ERROR', async () => {
    expect(StockBasicSchema.safeParse({ ts_code: '', name: 123 }).success).toBe(false);

    const fetchMock = mockFetch([{ status: 200, body: { data: [{ ts_code: '', name: 123 }] } }]);
    const sdk = new AdshareClient({
      url: 'https://adshare.test',
      apiKey: 'secret',
      retries: 0,
      fetchImpl: fetchMock,
    });

    await expect(sdk.searchStocks({ name: 'invalid' })).rejects.toMatchObject({
      code: 'PARSE_ERROR',
    });
  });
});
