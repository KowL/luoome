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
