import { expect, it } from 'bun:test';
import { fetch as nativeFetch } from 'bun';
import { createDshRunProxy } from './run-proxy.js';

it('authenticates each audience and forwards only trusted model headers through the supplied transport', async () => {
  const requests: RequestInit[] = [];
  let executed = 0;
  const proxy = createDshRunProxy({
    runId: 'run1',
    manifestHash: 'fixture',
    expiresAt: Date.now() + 10000,
    signal: new AbortController().signal,
    executeTool: async () => {
      executed++;
      return { kind: 'rejected', error: { code: 'permission_denied', message: 'fixture' } };
    },
    model: {
      endpoint: 'https://provider.invalid/chat/completions',
      model: 'fixture-model',
      headers: { authorization: 'Bearer server-only-key' },
      fetch: (async (_url, init) => {
        if (init !== undefined) requests.push(init);
        return new Response('data: fixture\n\n');
      }) as typeof fetch,
    },
  });
  const body = JSON.stringify({
    model: 'fixture-model',
    max_tokens: 10,
    stream: true,
    messages: [],
  });
  const send = (token: string, runId = 'run1') =>
    nativeFetch(proxy.model.endpoint, {
      method: 'POST',
      body,
      headers: {
        authorization: `Bearer ${token}`,
        'x-luoome-run-id': runId,
        'x-private-header': 'must-not-forward',
      },
    });
  try {
    expect((await send(proxy.gateway.token)).status).toBe(403);
    expect((await send(proxy.model.token, 'foreign')).status).toBe(403);
    const result = await send(proxy.model.token);
    expect(await result.text()).toBe('data: fixture\n\n');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers).toEqual({
      authorization: 'Bearer server-only-key',
      'content-type': 'application/json',
    });
    expect(requests[0]?.redirect).toBe('error');
    expect(executed).toBe(0);
    expect(proxy.model.token).not.toBe(proxy.native.token);
  } finally {
    await proxy.stop();
  }
});

it('keeps the private model stream open across a provider pause longer than Bun default idle timeout', async () => {
  const encoder = new TextEncoder();
  const proxy = createDshRunProxy({
    runId: 'slow',
    manifestHash: 'fixture',
    expiresAt: Date.now() + 20_000,
    signal: new AbortController().signal,
    executeTool: async () => ({
      kind: 'rejected',
      error: { code: 'permission_denied', message: 'unused' },
    }),
    model: {
      endpoint: 'https://provider.invalid/chat/completions',
      model: 'fixture-model',
      headers: {},
      fetch: (async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode('first\n'));
              await Bun.sleep(10_100);
              controller.enqueue(encoder.encode('tail\n'));
              controller.close();
            },
          }),
        )) as unknown as typeof fetch,
    },
  });
  try {
    const response = await nativeFetch(proxy.model.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.model.token}`, 'x-luoome-run-id': 'slow' },
      body: JSON.stringify({ model: 'fixture-model' }),
    });
    expect(await response.text()).toBe('first\ntail\n');
  } finally {
    await proxy.stop();
  }
}, 15_000);

it('retries a transient provider failure before any bytes reach the Host', async () => {
  let attempts = 0;
  const proxy = createDshRunProxy({
    runId: 'retry',
    manifestHash: 'fixture',
    expiresAt: Date.now() + 10_000,
    signal: new AbortController().signal,
    executeTool: async () => ({
      kind: 'rejected',
      error: { code: 'permission_denied', message: 'unused' },
    }),
    model: {
      endpoint: 'https://provider.invalid/chat/completions',
      model: 'fixture-model',
      headers: {},
      maxRetries: 2,
      fetch: (async () => {
        attempts += 1;
        return attempts < 3
          ? new Response('busy', { status: 503 })
          : new Response('data: fixture\n\n');
      }) as unknown as typeof fetch,
    },
  });
  try {
    const response = await nativeFetch(proxy.model.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.model.token}`, 'x-luoome-run-id': 'retry' },
      body: JSON.stringify({ model: 'fixture-model' }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: fixture\n\n');
    expect(attempts).toBe(3);
  } finally {
    await proxy.stop();
  }
}, 10_000);

it('does not retry a non-transient provider response or when retries are disabled', async () => {
  let attempts = 0;
  const proxyFor = (status: number, maxRetries: number) =>
    createDshRunProxy({
      runId: 'no-retry',
      manifestHash: 'fixture',
      expiresAt: Date.now() + 10_000,
      signal: new AbortController().signal,
      executeTool: async () => ({
        kind: 'rejected',
        error: { code: 'permission_denied', message: 'unused' },
      }),
      model: {
        endpoint: 'https://provider.invalid/chat/completions',
        model: 'fixture-model',
        headers: {},
        maxRetries,
        fetch: (async () => {
          attempts += 1;
          return new Response('unavailable', { status });
        }) as unknown as typeof fetch,
      },
    });
  const send = (proxy: ReturnType<typeof proxyFor>) =>
    nativeFetch(proxy.model.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.model.token}`, 'x-luoome-run-id': 'no-retry' },
      body: JSON.stringify({ model: 'fixture-model' }),
    });
  const rejected = proxyFor(400, 3);
  const disabled = proxyFor(503, 0);
  try {
    expect((await send(rejected)).status).toBe(400);
    expect(attempts).toBe(1);
    expect((await send(disabled)).status).toBe(503);
    expect(attempts).toBe(2);
  } finally {
    await rejected.stop();
    await disabled.stop();
  }
}, 10_000);

it('stops retrying when the run aborts during backoff', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const proxy = createDshRunProxy({
    runId: 'abort-retry',
    manifestHash: 'fixture',
    expiresAt: Date.now() + 10_000,
    signal: controller.signal,
    executeTool: async () => ({
      kind: 'rejected',
      error: { code: 'permission_denied', message: 'unused' },
    }),
    model: {
      endpoint: 'https://provider.invalid/chat/completions',
      model: 'fixture-model',
      headers: {},
      maxRetries: 5,
      fetch: (async () => {
        attempts += 1;
        return new Response('busy', { status: 503 });
      }) as unknown as typeof fetch,
    },
  });
  try {
    const pending = nativeFetch(proxy.model.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${proxy.model.token}`,
        'x-luoome-run-id': 'abort-retry',
      },
      body: JSON.stringify({ model: 'fixture-model' }),
    });
    await Bun.sleep(50);
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(502);
    expect(attempts).toBe(1);
  } finally {
    await proxy.stop();
  }
}, 10_000);
