import { afterEach, describe, expect, it } from 'bun:test';

import {
  ACCOUNT_KEY,
  apiHeaders,
  callApi,
  clearHostedSession,
  configureHostedSession,
  getAccountId,
  getHostedSession,
  onHostedSessionExpired,
  randomRequestId,
  setAccountId,
} from './api.js';

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage === undefined) delete globalThis.localStorage;
  else Object.defineProperty(globalThis, 'localStorage', originalStorage);
  clearHostedSession();
  onHostedSessionExpired(() => {});
  if (originalDocument === undefined) delete globalThis.document;
  else Object.defineProperty(globalThis, 'document', originalDocument);
  Object.defineProperty(globalThis, 'crypto', originalCrypto);
});

describe('Web API request context', () => {
  it('generates distinct UUID request IDs when an HTTP browser does not expose randomUUID', () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues },
    });
    const first = randomRequestId();
    const second = randomRequestId();
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe(second);
  });
  const hosted = () =>
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { body: { dataset: { runtime: 'hosted' } } },
    });

  it('hosted bootstrap sends no stale identity, then binds CSRF and the single account in memory', async () => {
    hosted();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => 'previous-user-account',
        setItem: () => {
          throw new Error('must not persist');
        },
      },
    });
    expect(getAccountId()).toBe('');
    expect(apiHeaders().has('x-luoome-user-id')).toBe(false);
    configureHostedSession({ user: { id: 'user-a' }, csrfToken: 'csrf-a' });
    setAccountId('default-account');
    const headers = apiHeaders({
      'x-luoome-user-id': 'user-b',
      'x-csrf-token': 'csrf-b',
      'x-luoome-account-id': 'forged',
    });
    expect(headers.get('x-luoome-user-id')).toBe('user-a');
    expect(headers.get('x-csrf-token')).toBe('csrf-a');
    expect(headers.get('x-luoome-account-id')).toBe('default-account');
    clearHostedSession();
    expect(getAccountId()).toBe('');
  });

  it('hosted discards an old response after switching identity and clears rejected sessions', async () => {
    hosted();
    configureHostedSession({ user: { id: 'user-a' }, csrfToken: 'csrf-a' });
    let finish;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = callApi('/api/watchlists');
    configureHostedSession({ user: { id: 'user-b' }, csrfToken: 'csrf-b' });
    finish(Response.json({ ok: true, data: { private: 'A' } }));
    expect((await pending).ok).toBe(false);
    let expired = false;
    onHostedSessionExpired(() => {
      expired = true;
    });
    globalThis.fetch = async () => Response.json({ ok: false }, { status: 401 });
    expect((await callApi('/api/review')).ok).toBe(false);
    expect(expired).toBe(true);
    expect(getHostedSession()).toBeNull();
  });
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
