import { afterEach, describe, expect, it } from 'bun:test';

import { ACCOUNT_KEY, callApi } from './api.js';

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage === undefined) delete globalThis.localStorage;
  else Object.defineProperty(globalThis, 'localStorage', originalStorage);
});

describe('Web API request context', () => {
  it('把当前 localStorage 账户作为 request-scoped header 发送', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key) => (key === ACCOUNT_KEY ? 'account-tab-a' : null),
        setItem: () => {},
        removeItem: () => {},
      },
    });
    let received;
    globalThis.fetch = async (_path, init) => {
      received = init;
      return new Response(JSON.stringify({ ok: true, data: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    };

    await callApi('/api/holdings');

    expect(received.headers.get('x-luoome-account-id')).toBe('account-tab-a');
  });
});
