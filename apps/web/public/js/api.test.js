import { afterEach, describe, expect, it } from 'bun:test';

import { ACCOUNT_KEY, apiHeaders, callApi } from './api.js';

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage === undefined) delete globalThis.localStorage;
  else Object.defineProperty(globalThis, 'localStorage', originalStorage);
});

describe('Web API request context', () => {
  it('流式请求复用账户 header，草案确认锁定原账户而非切换后的账户', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => 'account-new' },
    });
    const headers = apiHeaders({ 'content-type': 'application/json' }, 'account-original');
    expect(headers.get('x-luoome-account-id')).toBe('account-original');
    let received;
    globalThis.fetch = async (_path, init) => {
      received = init.headers;
      return Response.json({ ok: true, data: {} });
    };
    await callApi('/api/chat/sessions/session/drafts/message/call', { headers });
    expect(received.get('x-luoome-account-id')).toBe('account-original');
    await callApi('/api/chat', { headers: apiHeaders(undefined, '') });
    expect(received.get('x-luoome-account-id')).toBe('');
  });

  it('同时设置超时和调用方 signal 时，调用方仍能取消请求', async () => {
    const controller = new AbortController();
    let received;
    globalThis.fetch = (_path, init) =>
      new Promise((_resolve, reject) => {
        received = init.signal;
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    const pending = callApi('/api/dashboard', { timeoutMs: 20000, signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(received.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('调用方没有取消时，超时仍然生效', async () => {
    const controller = new AbortController();
    globalThis.fetch = (_path, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    const result = await callApi('/api/dashboard', { timeoutMs: 5, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('timeout');
    expect(controller.signal.aborted).toBe(false);
  });

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
