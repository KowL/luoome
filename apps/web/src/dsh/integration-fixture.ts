import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FixtureEmailOtpAdapter,
  FixtureHostedNotificationAdapter,
  FixtureHostedPaymentAdapter,
} from '@luoome/adapters/hosted';
import { FakeMarketAdapter, TEST_STOCKS } from '@luoome/adapters/testing';
import { Hono } from 'hono';
import { openHostedService } from '../hosted-composition.js';
import { loadHostedConfig } from '../hosted-config.js';
import { createHostedProviders } from '../hosted-providers.js';
import { createHostedWebApp } from '../hosted-server.js';
import { runHostedWorkerOnce } from '../hosted-worker.js';

const encoder = new TextEncoder();
export const FIXTURE_WEB_URL = 'https://research.example.test/facts';
export const FIXTURE_ORIGIN = 'http://127.0.0.1:5187';
const plan = {
  id: 'dsh-fixture-plan',
  code: 'fixture',
  currency: 'CNY' as const,
  priceMinor: 0,
  durationMonths: 1,
  productPolicyVersion: 'hosted-web-v2' as const,
  publishedAt: new Date('2026-10-20T01:00:00Z'),
  limits: {
    watchlistStocks: 20,
    enabledRules: 20,
    dailyJobs: 30,
    concurrentJobs: 1,
    queuedJobs: 10,
    researchUnits: 30,
  },
};

/** Test-only hosted tenants in temporary SQLite; model, webpage and market inputs stay controlled. */
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
  const planFile = join(root, 'plan.json');
  const webFile = join(root, 'web.json');
  writeFileSync(planFile, JSON.stringify(plan));
  writeFileSync(
    webFile,
    JSON.stringify({
      [FIXTURE_WEB_URL]:
        '<h1>受控研究来源</h1><p>2026-10-20：这是模拟网页证据，不代表真实供应商验证。</p><script>hidden-injection</script>',
    }),
  );
  const config = loadHostedConfig({
    HOSTED_ENVIRONMENT: 'development',
    HOSTED_DATA_ROOT: join(root, 'data'),
    HOSTED_AUTH_SECRET: 'dsh-fixture-auth-secret-with-at-least-32-characters',
    PUBLIC_ORIGIN: FIXTURE_ORIGIN,
    HOSTED_ALLOW_INSECURE_HTTP: 'true',
    HOSTED_PROVIDER_MODE: 'fixture',
    HOSTED_REGISTRATION_ENABLED: 'true',
    LUOOME_EXPOSE_WRITE: 'true',
    LUOOME_EXPOSE_EXTERNAL: 'true',
  });
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
  const providers = createHostedProviders(
    { ...config, registrationEnabled: false },
    {
      HOSTED_PLAN_FILE: planFile,
      HOSTED_JOB_BUDGET_MICRO: '100000',
      LUOOME_MARKET_PROVIDER: 'real',
      LUOOME_CHAT_RUNTIME: 'dsh',
      LUOOME_DSH_DEVELOPMENT: 'true',
      LUOOME_DSH_NODE_PATH: nodePath,
      LUOOME_DSH_ALLOW_WEB_FIXTURES: 'true',
      LUOOME_DSH_WEB_FIXTURES_FILE: webFile,
    },
    { fetchImpl: providerFetch },
  );
  if (providers.aiSettings === undefined || providers.createTenantContext === undefined)
    throw new Error('Missing hosted fixture assembly');
  providers.aiSettings.save({
    settings: { ...providers.aiSettings.read().settings, enabled: true },
    apiKey: 'fixture-only-provider-key',
  });
  const createTenantContext = providers.createTenantContext;
  const emailOtp = new FixtureEmailOtpAdapter();
  const service = openHostedService(
    config,
    {
      ...providers,
      emailOtp,
      notification: new FixtureHostedNotificationAdapter(),
      payment: new FixtureHostedPaymentAdapter({ clock }),
      market: new FakeMarketAdapter({ clock }),
      stockSeed: TEST_STOCKS,
      createTenantContext: (base) => {
        const scoped = createTenantContext(base);
        return {
          ...base,
          ...(scoped.agent === undefined ? {} : { agent: scoped.agent }),
          ...(scoped.llmExecution === undefined ? {} : { llmExecution: scoped.llmExecution }),
        };
      },
    },
    clock,
  );
  const app = createHostedWebApp({
    config,
    repos: service.repos,
    runtimes: service.runtimes,
    maintenance: service.maintenance,
    emailOtp,
    market: service.providers.market,
    jobPolicies: service.providers.jobPolicies,
    ...(service.providers.createTenantContext === undefined
      ? {}
      : { createTenantContext: service.providers.createTenantContext }),
    clock,
    notification: service.providers.notification,
    payment: service.providers.payment,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  let cookie = '';
  let csrf = '';
  const request = (path: string, init: RequestInit = {}) =>
    app.fetch(
      new Request(`${FIXTURE_ORIGIN}${path}`, {
        ...init,
        headers: {
          origin: FIXTURE_ORIGIN,
          'content-type': 'application/json',
          cookie,
          'x-csrf-token': csrf,
          ...Object.fromEntries(new Headers(init.headers)),
        },
      }),
    );
  const challengeResponse = await request('/api/auth/challenges', {
    method: 'POST',
    body: JSON.stringify({ email: 'dsh-fixture@example.test' }),
  });
  const challenge = (await challengeResponse.json()) as { data: { challengeId: string } };
  const code = emailOtp.getMessage(challenge.data.challengeId)?.code;
  const loginResponse = await request('/api/auth/sessions', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: challenge.data.challengeId,
      code,
      password: 'fixture-login-password',
      acceptTerms: true,
    }),
  });
  const setCookie = loginResponse.headers.get('set-cookie');
  if (setCookie === null)
    throw new Error(`Fixture HTTP login failed: ${await loginResponse.text()}`);
  cookie = setCookie.split(';')[0] ?? '';
  const meResponse = await request('/api/me');
  const me = (await meResponse.json()) as { data: { csrfToken: string; tenant: { id: string } } };
  csrf = me.data.csrfToken;
  await runHostedWorkerOnce(service);
  const accounts = await request('/api/accounts');
  if (!accounts.ok) throw new Error(`Fixture default account failed: ${await accounts.text()}`);
  const tenant = await service.repos.tenants.findById(me.data.tenant.id);
  if (tenant === null) throw new Error('Fixture tenant missing');
  const auditLease = service.runtimes.acquire({
    tenantId: tenant.id,
    ownerUserId: tenant.ownerUserId,
    generation: tenant.generation,
    schemaVersion: tenant.schemaVersion,
  });
  const context = { repos: auditLease.runtime.repos };
  const platform = { ctx: { repos: service.repos } };
  const browserApp = new Hono();
  browserApp.get(
    '/fixture-login',
    () =>
      new Response(null, { status: 302, headers: { location: '/#chat', 'set-cookie': setCookie } }),
  );
  browserApp.route('/', app);
  return {
    app: browserApp,
    request,
    context,
    platform,
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
      auditLease.release();
      service.close();
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
  console.log(`DSH controlled browser fixture: http://127.0.0.1:${server.port}/fixture-login`);
  const stop = () => {
    void server.stop(true).then(() => {
      fixture.dispose();
      process.exit(0);
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
