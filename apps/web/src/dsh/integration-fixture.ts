import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeLLMAdapter, FakeMarketAdapter, TEST_STOCKS } from '@luoome/adapters/testing';
import { money } from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import { buildContext } from '@luoome/tools';
import { createWebApp } from '../server.js';
import { DshChatRuntime } from './chat-runtime.js';
import { loadDshDevelopmentConfig } from './config.js';

const encoder = new TextEncoder();
export const FIXTURE_WEB_URL = 'https://research.example.test/facts';
export const FIXTURE_ORIGIN = 'http://127.0.0.1:5187';

/** Test-only local DSH fixture in temporary SQLite; model, webpage and market inputs stay controlled. */
export const createDshIntegrationFixture = async (
  options: {
    readonly firstChunkGate?: Promise<void>;
    readonly failProvider?: boolean;
    readonly slowProvider?: boolean;
    readonly reuseProviderCallId?: boolean;
  } = {},
) => {
  const nodePath = Bun.which('node');
  if (nodePath === null) throw new Error('Node is required for DSH integration');
  const root = mkdtempSync(join(tmpdir(), 'luoome-dsh-chat-fixture-'));
  const clock = () => new Date('2026-10-20T01:00:00Z');
  const webFile = join(root, 'web.json');
  writeFileSync(
    webFile,
    JSON.stringify({
      [FIXTURE_WEB_URL]:
        '<h1>受控研究来源</h1><p>2026-10-20：这是模拟网页证据，不代表真实供应商验证。</p><script>hidden-injection</script>',
    }),
  );
  const bodies: Record<string, unknown>[] = [];
  let completedProviders = 0;
  const providerFetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const ordinal = bodies.length;
    if (options.failProvider)
      return Response.json({ error: { message: 'fixture-rejected' } }, { status: 401 });
    const messages = body.messages as { role: string; content: string }[];
    const history = JSON.parse(messages.find((item) => item.role === 'user')?.content ?? '{}') as {
      trustedHistory?: { role: string; parts: { type: string; text?: string }[] }[];
    };
    const userText =
      history.trustedHistory
        ?.filter((message) => message.role === 'user')
        .at(-1)
        ?.parts.filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('') ?? '';
    const continuation =
      userText.includes('解释确认') || userText.startsWith('请根据刚才草案的实际处理结果');
    const draft = !continuation && userText.includes('草案');
    const slow = options.slowProvider || userText.includes('慢速');
    const failed = userText.includes('失败');
    if (failed) return Response.json({ error: { message: 'fixture-rejected' } }, { status: 401 });
    const toolCount = messages.filter((message) => message.role === 'tool').length;
    const sse = (delta: object, finish: string | null = null) =>
      encoder.encode(
        `data: ${JSON.stringify({ id: `fixture-${ordinal}`, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            controller.enqueue(sse({ content: toolCount === 0 ? '正在核对事实。' : '' }));
            if (slow) {
              await new Promise<void>((_resolve, reject) => {
                if (init?.signal?.aborted) reject(new Error('aborted'));
                init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                  once: true,
                });
              });
            }
            if (ordinal === 1 && options.firstChunkGate !== undefined) await options.firstChunkGate;
            else await Bun.sleep(120);
            if (toolCount === 0 && !continuation) {
              const name = draft ? 'create_watchlist' : 'fetch_quote';
              const input = draft
                ? { name: 'DSH 待确认观察清单', kind: 'personal', membershipPolicy: 'manual' }
                : { stockId: '002594.SZ' };
              controller.enqueue(
                sse(
                  {
                    tool_calls: [
                      {
                        index: 0,
                        id: draft ? 'draft-1' : 'quote-1',
                        type: 'function',
                        function: { name, arguments: JSON.stringify(input) },
                      },
                    ],
                  },
                  'tool_calls',
                ),
              );
            } else if (toolCount === 1 && !draft) {
              controller.enqueue(
                sse(
                  {
                    tool_calls: [
                      {
                        index: 0,
                        id: options.reuseProviderCallId ? 'quote-1' : 'web-1',
                        type: 'function',
                        function: {
                          name: 'web_fetch',
                          arguments: JSON.stringify({ url: FIXTURE_WEB_URL }),
                        },
                      },
                    ],
                  },
                  'tool_calls',
                ),
              );
            } else {
              controller.enqueue(
                sse({
                  content: draft
                    ? '草案已生成，确认前不会创建观察清单。'
                    : continuation
                      ? '已依据服务端真实确认回执继续解释，未再次执行写入。'
                      : `行情已通过业务工具读取；网页证据来源 ${FIXTURE_WEB_URL}。这是受控模拟研究，不构成投资建议。`,
                }),
              );
              controller.enqueue(sse({}, 'stop'));
            }
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ id: `fixture-${ordinal}`, choices: [], usage: { prompt_tokens: 20, prompt_cache_hit_tokens: 4, completion_tokens: 10, total_tokens: 30 } })}\n\ndata: [DONE]\n\n`,
              ),
            );
            completedProviders++;
            controller.close();
          } catch {
            controller.error(new Error('Controlled provider stopped'));
          }
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }) as typeof fetch;

  const dsh = loadDshDevelopmentConfig(
    {
      LUOOME_CHAT_RUNTIME: 'dsh',
      LUOOME_DSH_DEVELOPMENT: 'true',
      LUOOME_DSH_NODE_PATH: nodePath,
      LUOOME_DSH_ALLOW_WEB_FIXTURES: 'true',
      LUOOME_DSH_WEB_FIXTURES_FILE: webFile,
    },
    'development',
  );
  if (dsh === undefined) throw new Error('Missing DSH development configuration');

  const handle = createDrizzleRepos(join(root, 'luoome.db'));
  for (const stock of TEST_STOCKS) await handle.repos.stock.save(stock);
  const defaultAccountId = 'account-default';
  await handle.repos.account.save({
    id: defaultAccountId,
    name: '默认账户',
    kind: 'real',
    currency: 'CNY',
    initialCapital: money(100_000),
    cashBalance: money(100_000),
    createdAt: clock(),
  });

  const chatStreamRuntime = new DshChatRuntime({
    ...dsh,
    model: {
      endpoint: 'https://provider.example.test/v1/chat/completions',
      model: 'deepseek-chat',
      maxTokens: 1024,
      headers: { authorization: 'Bearer fixture-only-provider-key' },
      fetch: providerFetch,
    },
  });

  const ctx = buildContext({
    repos: handle.repos,
    adapters: {
      market: new FakeMarketAdapter({ clock }),
      llm: new FakeLLMAdapter(),
    },
    clock,
    user: { id: 'local-web-user', defaultAccountId },
  });

  const app = createWebApp(ctx, {
    exposeWrite: true,
    exposeExternal: true,
    chatStreamRuntime,
  });

  const request = (path: string, init: RequestInit = {}) =>
    Promise.resolve(
      app.fetch(
        new Request(`${FIXTURE_ORIGIN}${path}`, {
          ...init,
          headers: {
            origin: FIXTURE_ORIGIN,
            'content-type': 'application/json',
            ...Object.fromEntries(new Headers(init.headers)),
          },
        }),
      ),
    );

  return {
    app,
    request,
    context: { repos: handle.repos },
    bodies,
    completedProviders: () => completedProviders,
    async createSession() {
      const response = await request('/api/chat/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'DSH 模拟研究' }),
      });
      const result = (await response.json()) as { data: { session: { id: string } } };
      return result.data.session.id;
    },
    async chat(sessionId: string, text: string, signal?: AbortSignal) {
      return request('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          messages: [{ id: randomRequestId(), role: 'user', parts: [{ type: 'text', text }] }],
        }),
        ...(signal === undefined ? {} : { signal }),
      });
    },
    dispose() {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
};
const randomRequestId = () => crypto.randomUUID();

if (import.meta.main) {
  const fixture = await createDshIntegrationFixture();
  const server = Bun.serve({
    port: 5187,
    hostname: '127.0.0.1',
    fetch: fixture.app.fetch,
    idleTimeout: 255,
  });
  console.log(`DSH controlled browser fixture: http://127.0.0.1:${server.port}/#chat`);
  const stop = () => {
    void server.stop(true).then(() => {
      fixture.dispose();
      process.exit(0);
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
