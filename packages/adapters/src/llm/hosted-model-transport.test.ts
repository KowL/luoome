import { HostedLLMError, type HostedLLMPricing } from '@luoome/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildPlatformTestContext,
  loginPlatformTestUser,
  provisionPlatformTestTenant,
} from '../../../tools/src/platform/testing-context.js';
import {
  createHostedModelTransport,
  type HostedModelResponseReceipt,
  type HostedModelTransport,
  readHostedModelUsage,
} from './hosted-model-transport.js';

const now = new Date('2026-10-20T01:00:00Z');
const pricing: HostedLLMPricing = {
  version: 'fixture-v1',
  provider: 'fixture',
  model: 'fixture-model',
  currency: 'CNY',
  inputMicroPerMillion: 2_000_000,
  cachedInputMicroPerMillion: 40_000,
  outputMicroPerMillion: 8_000_000,
};
const provider = {
  endpoint: 'https://model.example.invalid/v1/chat/completions',
  model: pricing.model,
  pricing: () => pricing,
};
const tokens = { input: 100, cachedInput: 20, output: 5 };
const receipt = {
  id: 'fixture-receipt',
  usage: {
    prompt_tokens: tokens.input,
    prompt_cache_hit_tokens: tokens.cachedInput,
    prompt_cache_miss_tokens: tokens.input - tokens.cachedInput,
    completion_tokens: tokens.output,
    total_tokens: tokens.input + tokens.output,
  },
};
const delta = `data: ${JSON.stringify({ id: receipt.id, choices: [{ delta: { content: '首块' } }], usage: null })}\n\n`;
const tail = `data: ${JSON.stringify(receipt)}\n\ndata: [DONE]\n\n`;
const encoder = new TextEncoder();
const controlled = () => {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel,
  });
  return {
    response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
    fail: () => controller.error(new Error('fixture provider connection lost')),
    cancel,
  };
};
const transports: HostedModelTransport[] = [];
type Options = Parameters<typeof createHostedModelTransport>[0];
const setup = async (
  send: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response> = async () =>
    Response.json(receipt),
  overrides: Partial<Options> = {},
) => {
  const platform = buildPlatformTestContext({ clock: () => now });
  const user = await loginPlatformTestUser(platform);
  const tenant = await provisionPlatformTestTenant(user.ctx);
  await platform.ctx.repos.subscriptions.publishPlan({
    id: 'transport-plan',
    code: 'fixture',
    currency: 'CNY',
    priceMinor: 4900,
    durationMonths: 1,
    limits: {
      watchlistStocks: 20,
      enabledRules: 20,
      dailyJobs: 30,
      concurrentJobs: 1,
      queuedJobs: 10,
      researchUnits: 30,
    },
    productPolicyVersion: 'hosted-web-v2',
    publishedAt: now,
  });
  await platform.ctx.repos.subscriptions.grantTrial({
    period: {
      id: 'transport-period',
      tenantId: tenant.id,
      planVersionId: 'transport-plan',
      startsAt: now,
      endsAt: new Date(now.getTime() + 30 * 86400_000),
      anchorDay: 20,
      sourceOrderId: null,
      status: 'trial',
      createdAt: now,
    },
    now,
  });
  const ledger = platform.ctx.repos.llm;
  const scope = {
    operationId: 'fixture-operation',
    tenantId: tenant.id,
    generation: tenant.generation,
    inputHash: 'a'.repeat(64),
    owner: 'fixture-owner',
  };
  const fetchImpl = vi.fn(send);
  const create = (changes: Partial<Options> = {}) => {
    const transport = createHostedModelTransport({
      ledger,
      scope,
      provider,
      budgetMicro: 1_000_000,
      periodBudgetMicro: 20_000_000,
      timeoutMs: 1000,
      clock: () => now,
      renew: () =>
        ledger.execution({
          operationId: scope.operationId,
          owner: scope.owner,
          action: 'renew',
          now,
          leaseUntil: new Date(now.getTime() + 120_000),
        }),
      ...overrides,
      ...changes,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    transports.push(transport);
    return transport;
  };
  const transport = create();
  const request = (stream = false) => ({
    method: 'POST',
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 64,
      stream,
      messages: [{ role: 'user', content: 'fixture-only prompt' }],
    }),
  });
  const call = (stream = false) => transport.fetch(provider.endpoint, request(stream));
  const attempts = () => ledger.attempts(scope.operationId);
  const settle = () =>
    ledger.settle({ operationId: scope.operationId, owner: scope.owner, capture: true, now });
  return {
    ledger,
    tenant,
    scope,
    fetchImpl,
    transport,
    request,
    call,
    attempts,
    settle,
    create,
  };
};
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.cancel()));
  vi.restoreAllMocks();
});

describe('hosted SDK-independent model transport with actual memory ledger and controlled HTTP', () => {
  it('returns the first provider bytes before provider completion and retains admission until consumption', async () => {
    const upstream = controlled();
    const h = await setup(async (_url, init) => {
      expect(init?.redirect).toBe('error');
      expect(JSON.parse(String(init?.body)).stream_options).toEqual({ include_usage: true });
      expect((await h.attempts())[0]?.usageState).toBe('unknown');
      return upstream.response;
    });
    const response = await h.call(true);
    const complete = vi.spyOn(h.ledger, 'complete');
    upstream.write(delta);
    if (!response.body) throw new Error('fixture response missing body');
    const reader = response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(delta);
    expect((await h.attempts())[0]?.usageState).toBe('unknown');
    await expect(h.settle()).rejects.toThrow('usage_unknown');
    let drained = false;
    const finish = h.transport.finish().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect((await h.ledger.find(h.scope.operationId))?.state).toBe('held');
    await expect(h.call()).rejects.toThrow('operation_closed');
    upstream.write(tail);
    upstream.end();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(tail);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    await finish;
    expect((await h.attempts())[0]).toMatchObject({
      tokens,
      receiptId: receipt.id,
      usageState: 'confirmed',
      confirmedCostMicro: 201,
    });
    await h.transport.finish();
    expect((await h.settle()).state).toBe('captured');
    expect((await h.settle()).state).toBe('captured');
    expect((await h.ledger.costs())[0]?.confirmedAttempts).toBe(1);
    expect(complete).toHaveBeenCalledOnce();
  });

  it.each(['eof', 'cancel-after-done', 'timeout-after-done'])(
    'streams actual local HTTP before provider completion and settles after %s',
    async (termination) => {
      const timeout = new AbortController();
      let finishProvider = () => {};
      let ended = false;
      let endpoint: string;
      let stop: () => Promise<void>;
      if (typeof Bun !== 'undefined') {
        const upstream = controlled();
        const server = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch() {
            upstream.write(delta);
            finishProvider = () => {
              ended = true;
              upstream.write(tail);
              if (termination === 'eof') upstream.end();
            };
            return upstream.response;
          },
        });
        endpoint = `http://127.0.0.1:${server.port}/chat/completions`;
        stop = async () => {
          await server.stop(true);
        };
      } else {
        const server = createServer((_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
          response.write(delta);
          finishProvider = () => {
            ended = true;
            if (termination === 'eof') response.end(tail);
            else response.write(tail);
          };
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('fixture server missing');
        endpoint = `http://127.0.0.1:${address.port}/chat/completions`;
        stop = () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      }
      const h = await setup((url, init) => fetch(url, init), {
        provider: { ...provider, endpoint },
        timeoutSignal: () => timeout.signal,
      });
      try {
        const response = await h.transport.fetch(endpoint, h.request(true));
        if (!response.body) throw new Error('fixture response missing body');
        const reader = response.body.getReader();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(delta);
        expect(ended).toBe(false);
        expect((await h.attempts())[0]?.usageState).toBe('unknown');
        finishProvider();
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(tail);
        if (termination === 'eof') expect((await reader.read()).done).toBe(true);
        else if (termination === 'cancel-after-done') await reader.cancel();
        else {
          const pending = reader.read();
          timeout.abort();
          await expect(pending).rejects.toThrow('usage_unknown');
        }
        await h.transport.finish();
        expect((await h.attempts())[0]?.tokens).toEqual(tokens);
      } finally {
        await h.transport.cancel();
        await stop();
      }
    },
  );

  it('replays only a matching persisted receipt and does not create or pay a second attempt', async () => {
    const records = new Map<number, HostedModelResponseReceipt>();
    const receipts: NonNullable<Options['receipts']> = {
      read: async (request) => records.get(request.ordinal) ?? null,
      save: async (record) => {
        records.set(record.ordinal, record);
      },
    };
    const h = await setup(undefined, { receipts });
    await (await h.call()).json();
    await h.transport.finish();
    const replay = h.create({ receipts });
    expect(await (await replay.fetch(provider.endpoint, h.request())).json()).toEqual(receipt);
    await replay.finish();
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    expect(await h.attempts()).toHaveLength(1);
    const changed = h.create({ receipts });
    const body = JSON.parse(h.request().body);
    await expect(
      changed.fetch(provider.endpoint, {
        method: 'POST',
        body: JSON.stringify({ ...body, max_tokens: 32 }),
      }),
    ).rejects.toThrow('operation_closed');
    expect(h.fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([302, 500])(
    'keeps HTTP %s unknown without following the location or leaking the body',
    async (status) => {
      const h = await setup(
        async () =>
          new Response('private provider error', {
            status,
            headers: { location: 'https://other.invalid/' },
          }),
      );
      await expect(h.call()).rejects.toThrow('usage_unknown');
      await expect(h.transport.finish()).rejects.toThrow('usage_unknown');
      expect(h.fetchImpl).toHaveBeenCalledOnce();
      expect((await h.attempts())[0]?.usageState).toBe('unknown');
    },
  );

  it('blocks the next explicit retry when the remaining operation budget cannot cover its maximum', async () => {
    const h = await setup(undefined, { budgetMicro: 2900 });
    await (await h.call()).json();
    await expect(h.call()).rejects.toThrow('budget_exhausted');
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    await h.transport.finish();
    expect(await h.attempts()).toHaveLength(1);
  });

  it('does not send when cancellation occurs during admission, even after the attempt was reserved', async () => {
    const signal = new AbortController();
    const h = await setup(undefined, { signal: signal.signal });
    const begin = h.ledger.begin.bind(h.ledger);
    vi.spyOn(h.ledger, 'begin').mockImplementation(async (input) => {
      const row = await begin(input);
      signal.abort();
      return row;
    });
    await expect(h.call()).rejects.toThrow('operation_closed');
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect((await h.attempts())[0]).toMatchObject({
      usageState: 'confirmed',
      confirmedCostMicro: 0,
    });
    expect((await h.attempts())[0]?.receiptId).toMatch(/^not-sent:/);
  });

  it.each(['usage-only', 'terminal-content'])(
    'parses byte-split UTF-8 / CRLF / multiline SSE (%s)',
    async (kind) => {
      const usageFrame = {
        ...receipt,
        choices: kind === 'usage-only' ? [] : [{ delta: {}, finish_reason: 'stop' }],
      };
      const text = `${delta.replaceAll('\n', '\r\n')}data:${JSON.stringify(usageFrame).replace(',"usage":', ',\r\ndata: "usage":')}\r\n\r\ndata:[DONE]\r\n\r\n`;
      const bytes = encoder.encode(text);
      let index = 0;
      const h = await setup(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (index === bytes.length) controller.close();
                else controller.enqueue(bytes.slice(index, ++index));
              },
            }),
          ),
      );
      expect(await (await h.call(true)).text()).toBe(text);
      await h.transport.finish();
      expect((await h.attempts())[0]?.tokens).toEqual(tokens);
    },
  );

  it.each(['operation', 'period'])(
    'refuses exhausted %s budget before sending anything',
    async (budget) => {
      const h = await setup(undefined, {
        budgetMicro: budget === 'operation' ? 1 : 1_000_000,
        periodBudgetMicro: 1,
      });
      await expect(h.call()).rejects.toThrow('budget_exhausted');
      expect(h.fetchImpl).not.toHaveBeenCalled();
      expect(await h.attempts()).toEqual([]);
      await h.transport.finish();
    },
  );

  it('records every provider retry and does not retry within the transport', async () => {
    let calls = 0;
    const h = await setup(async () =>
      ++calls === 1
        ? Response.json({ error: 'provider-private-error' }, { status: 429 })
        : Response.json(receipt),
    );
    const rejected = await h.call();
    expect(rejected.status).toBe(429);
    expect(await rejected.text()).not.toContain('provider-private-error');
    expect(await (await h.call()).json()).toEqual(receipt);
    await h.transport.finish();
    const attempts = await h.attempts();
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((row) => row.id)).size).toBe(2);
    expect(attempts.map((row) => row.confirmedCostMicro)).toEqual([0, 201]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each(['disconnect', 'missing-usage', 'missing-done', 'partial-usage'])(
    'retains unknown on %s and blocks another send',
    async (failure) => {
      const upstream = controlled();
      const h = await setup(async () => upstream.response);
      const response = await h.call(true);
      upstream.write(delta);
      const pending = response.text();
      if (failure === 'disconnect') upstream.fail();
      else {
        if (failure === 'missing-done') upstream.write(`data: ${JSON.stringify(receipt)}\n\n`);
        else if (failure === 'partial-usage') {
          upstream.write(`data: ${JSON.stringify(receipt)}\n\n`);
          upstream.write(
            `data: ${JSON.stringify({ id: receipt.id, usage: { prompt_tokens: 100 } })}\n\n`,
          );
          upstream.write('data: [DONE]\n\n');
        } else upstream.write('data: [DONE]\n\n');
        upstream.end();
      }
      await expect(pending).rejects.toThrow('usage_unknown');
      await expect(h.transport.finish()).rejects.toThrow('usage_unknown');
      await expect(h.settle()).rejects.toThrow('usage_unknown');
      expect((await h.ledger.costs())[0]).toMatchObject({
        unknownAttempts: 1,
        confirmedAttempts: 0,
        confirmedMicro: 0,
      });
      expect((await h.ledger.find(h.scope.operationId))?.state).toBe('held');
      const retry = h.create();
      await expect(retry.fetch(provider.endpoint, h.request())).rejects.toThrow('usage_unknown');
      expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['consumer', 'run', 'timeout'])(
    'cancels %s while waiting for the next provider chunk without zeroing costs',
    async (source) => {
      const upstream = controlled();
      const run = new AbortController();
      const timeout = new AbortController();
      const h = await setup(async () => upstream.response, {
        signal: run.signal,
        timeoutSignal: () => timeout.signal,
      });
      const response = await h.call(true);
      upstream.write(delta);
      if (!response.body) throw new Error('fixture response missing body');
      const reader = response.body.getReader();
      await reader.read();
      if (source === 'consumer') await reader.cancel();
      else {
        const next = reader.read();
        if (source === 'run') run.abort();
        else timeout.abort();
        await expect(next).rejects.toThrow('usage_unknown');
      }
      await h.transport.cancel();
      expect(upstream.cancel).toHaveBeenCalledOnce();
      expect((await h.attempts())[0]?.usageState).toBe('unknown');
      await expect(h.transport.finish()).rejects.toThrow('usage_unknown');
      await expect(h.call()).rejects.toThrow('operation_closed');
      await expect(h.settle()).rejects.toThrow('usage_unknown');
    },
  );

  it.each(['cancel', 'timeout'])(
    'drains an unread consumer on %s without confirming unseen usage',
    async (source) => {
      const upstream = controlled();
      const timeout = new AbortController();
      const h = await setup(async () => upstream.response, { timeoutSignal: () => timeout.signal });
      const response = await h.call(true);
      upstream.write(tail);
      if (source === 'cancel') await h.transport.cancel();
      else timeout.abort();
      await expect(h.transport.finish()).rejects.toThrow('usage_unknown');
      await expect(response.text()).rejects.toThrow('usage_unknown');
      expect(upstream.cancel).toHaveBeenCalledOnce();
      expect((await h.attempts())[0]?.usageState).toBe('unknown');
      await expect(h.settle()).rejects.toThrow('usage_unknown');
    },
  );

  it('does not treat early usage as final when later content has no final usage receipt', async () => {
    const text = `data: ${JSON.stringify(receipt)}\n\n${delta}data: [DONE]\n\n`;
    const h = await setup(async () => new Response(text));
    await expect((await h.call(true)).text()).rejects.toThrow('usage_unknown');
    await expect(h.transport.finish()).rejects.toThrow('usage_unknown');
    expect((await h.attempts())[0]?.usageState).toBe('unknown');
    await expect(h.settle()).rejects.toThrow('usage_unknown');
  });

  it('retains a complete final receipt when cancellation follows the terminal usage frame', async () => {
    const upstream = controlled();
    const h = await setup(async () => upstream.response);
    const response = await h.call(true);
    upstream.write(tail);
    if (!response.body) throw new Error('fixture response missing body');
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await h.transport.cancel();
    expect((await h.attempts())[0]).toMatchObject({ usageState: 'confirmed', tokens });
    await h.transport.finish();
    expect((await h.ledger.costs())[0]?.confirmedMicro).toBe(201);
  });

  it('drains once when the consumer cancels during final usage persistence', async () => {
    const h = await setup();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = () => {};
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const complete = h.ledger.complete.bind(h.ledger);
    const save = vi.spyOn(h.ledger, 'complete').mockImplementation(async (input) => {
      ready();
      await gate;
      return complete(input);
    });
    const response = await h.call();
    if (!response.body) throw new Error('fixture response missing body');
    const reader = response.body.getReader();
    await reader.read();
    const end = reader.read();
    await started;
    const cancelled = reader.cancel();
    release();
    await cancelled;
    await end;
    await h.transport.finish();
    expect(save).toHaveBeenCalledOnce();
    expect((await h.attempts())[0]?.usageState).toBe('confirmed');
  });

  it('keeps a sent request with lost response unknown and never resends it automatically', async () => {
    const h = await setup(async () => {
      throw new TypeError('fixture uncertain network send');
    });
    await expect(h.call()).rejects.toThrow('usage_unknown');
    await h.transport.cancel();
    const retry = h.create();
    await expect(retry.fetch(provider.endpoint, h.request())).rejects.toThrow('usage_unknown');
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    expect((await h.attempts())[0]?.usageState).toBe('unknown');
  });

  it('uses atomic ledger admission for concurrent calls rather than reusing an attempt ID', async () => {
    const upstream = controlled();
    const h = await setup(async () => upstream.response);
    const both = await Promise.allSettled([h.call(true), h.call(true)]);
    expect(both.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(both.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(h.fetchImpl).toHaveBeenCalledOnce();
    const success = both.find((result) => result.status === 'fulfilled');
    if (success?.status !== 'fulfilled') throw new Error('fixture admission failed');
    const consume = success.value.text();
    upstream.write(tail);
    upstream.end();
    await consume;
    await h.transport.finish();
    expect(await h.attempts()).toHaveLength(1);
  });

  it('rechecks revoked tenant generation and lost ownership before admission', async () => {
    const h = await setup();
    const denied = h.create({ scope: { ...h.scope, generation: h.scope.generation + 1 } });
    await expect(denied.fetch(provider.endpoint, h.request())).rejects.toThrow('operation_closed');
    const lost = h.create({ renew: async () => false });
    await expect(lost.fetch(provider.endpoint, h.request())).rejects.toThrow('lease_lost');
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it('pins endpoint / model and rejects unsupported media, built-in paid tools and candidate amplification', async () => {
    const h = await setup();
    await expect(h.transport.fetch(`${provider.endpoint}?redirect=1`, h.request())).rejects.toThrow(
      'provider_failed',
    );
    const body = JSON.parse(h.request().body);
    for (const change of [
      { model: 'other-model' },
      { max_tokens: 0 },
      { n: 2 },
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'https://media.invalid/image' } }],
          },
        ],
      },
      { tools: [{ type: 'web_search' }] },
    ]) {
      await expect(
        h.transport.fetch(provider.endpoint, {
          method: 'POST',
          body: JSON.stringify({ ...body, ...change }),
        }),
      ).rejects.toThrow('provider_failed');
    }
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(await h.attempts()).toEqual([]);
  });

  it('does not trust SDK input-token aliases or fabricate cache-read/write breakdowns', () => {
    expect(readHostedModelUsage(JSON.stringify(receipt), false)).toEqual({
      receiptId: receipt.id,
      tokens,
    });
    for (const usage of [
      { prompt_tokens: 100, completion_tokens: 5 },
      { input_tokens: 100, output_tokens: 5 },
      { ...receipt.usage, prompt_cache_miss_tokens: 100 },
      { ...receipt.usage, prompt_tokens_details: { cached_tokens: 21 } },
      { ...receipt.usage, cache_creation_input_tokens: 20 },
      { ...receipt.usage, completion_tokens: -1 },
    ])
      expect(() => readHostedModelUsage(JSON.stringify({ id: receipt.id, usage }), false)).toThrow(
        HostedLLMError,
      );
    expect(
      readHostedModelUsage(
        JSON.stringify({
          id: receipt.id,
          usage: { prompt_tokens: 100, completion_tokens: 5 },
        }),
        false,
        false,
      ).tokens,
    ).toEqual({ input: 100, cachedInput: 0, output: 5 });
  });
});

import { createServer } from 'node:http';
