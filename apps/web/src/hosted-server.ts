import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  EmailOtpPort,
  HostedJob,
  HostedNotificationPort,
  HostedPaymentPort,
  HostedUser,
  Logger,
  MarketDataAdapterLike,
  PlatformRepositoryRegistry,
  Tenant,
  ToolContext,
  ToolError,
  ToolResult,
} from '@luoome/core';
import type { HostedMaintenanceGate } from '@luoome/db';
import { buildContext } from '@luoome/tools';
import {
  authorizeHostedWebRequest,
  contextForHostedWebTools,
  type HostedInvocation,
  invokeHostedOperation,
  submitHostedJob,
} from '@luoome/tools/hosted';
import {
  applyHostedPaymentWebhookTool,
  buildPlatformContext,
  cancelHostedJobTool,
  createAuthSessionTool,
  createHostedSubscriptionOrderTool,
  getHostedExportTool,
  getHostedJobTool,
  getHostedNotificationPreferencesTool,
  getHostedSubscriptionTool,
  getHostedUsageTool,
  getPlatformMeTool,
  hashAuthIp,
  listHostedDeliveriesTool,
  listHostedSubscriptionOrdersTool,
  type PlatformContext,
  type PlatformPrincipal,
  queryHostedSubscriptionOrderTool,
  requestAuthChallengeTool,
  requestHostedDeletionTool,
  requestHostedExportTool,
  resolveAuthSessionTool,
  resolveHostedExportDownloadTool,
  revokeAuthSessionTool,
  saveHostedNotificationPreferencesTool,
  verifyCsrfToken,
  verifyHostedPaymentWebhookTool,
} from '@luoome/tools/platform';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { HostedConfig } from './hosted-config.js';
import { bindHostedDefaultAccount } from './hosted-context.js';
import type { TenantRuntimeLease, TenantRuntimeManager } from './hosted-runtime.js';
import { createWebApp } from './server.js';

const SESSION_COOKIE = '__Host-luoome_session';
const MAX_JSON_BYTES = 2 * 1_048_576;
const PUBLIC_DIR = fileURLToPath(new URL('../public/hosted/', import.meta.url));

interface AuthenticatedRequest {
  readonly principal: Extract<PlatformPrincipal, { kind: 'user' }>;
  readonly user: HostedUser;
  readonly tenant: Tenant;
  readonly csrfToken: string;
}

type Variables = {
  auth: AuthenticatedRequest;
  platform: PlatformContext;
  invocation: HostedInvocation;
  retainRuntime: () => () => void;
};

export interface CreateHostedWebAppOptions {
  readonly config: HostedConfig;
  readonly repos: PlatformRepositoryRegistry;
  readonly runtimes: TenantRuntimeManager;
  readonly emailOtp: EmailOtpPort;
  readonly market: MarketDataAdapterLike;
  readonly createTenantContext?: (base: ToolContext) => ToolContext;
  readonly maintenance: HostedMaintenanceGate;
  readonly notification?: HostedNotificationPort;
  readonly payment?: HostedPaymentPort;
  readonly jobPolicies: PlatformContext['jobPolicies'];
  readonly clock?: () => Date;
  readonly logger?: Logger;
  readonly clientIp?: (request: Request) => string;
}

const denied = (required: string): ToolResult<never> => ({
  ok: false,
  error: { kind: 'permission_denied', required },
});
const invalid = (): ToolResult<never> => ({
  ok: false,
  error: { kind: 'invalid_input', message: '请求需为有效且大小受限的 JSON', issues: [] },
});
const statusOf = (error: ToolError): number => {
  switch (error.kind) {
    case 'invalid_input':
      return 400;
    case 'not_found':
      return 404;
    case 'permission_denied':
      return error.required === 'auth:rate-limit' ? 429 : 403;
    case 'invariant_violation':
      return 409;
    case 'lease_lost_before_commit':
      return 409;
    case 'adapter_error':
      return 503;
    default:
      return 500;
  }
};

export const hostedJsonResult = (result: ToolResult<unknown>, status?: number): Response => {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (
    !result.ok &&
    result.error.kind === 'permission_denied' &&
    result.error.required === 'auth:rate-limit'
  ) {
    headers.set('retry-after', '60');
  }
  return new Response(JSON.stringify(result), {
    status: status ?? (result.ok ? 200 : statusOf(result.error)),
    headers,
  });
};

type JsonRequest = {
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
};
const readText = async (request: JsonRequest, maximumBytes: number): Promise<string> => {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    throw new Error('invalid request');
  }
  if (request.body === null) throw new Error('empty body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error('request too large');
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
};
const readJson = async (request: JsonRequest): Promise<unknown> =>
  JSON.parse(await readText(request, MAX_JSON_BYTES));

const cookieToken = (request: Request): string | null => {
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((value) => value.trim())
    .filter((value) => value.startsWith(`${SESSION_COOKIE}=`));
  return values.length === 1 ? (values[0]?.slice(SESSION_COOKIE.length + 1) ?? null) : null;
};

export const createHostedWebApp = (
  options: CreateHostedWebAppOptions,
): Hono<{ Variables: Variables }> => {
  const { config } = options;
  const clock = options.clock ?? (() => new Date());
  const logger = options.logger ?? console;
  const capabilities = { write: config.exposeWrite, external: config.exposeExternal };
  const platform = (principal: PlatformPrincipal) =>
    buildPlatformContext({
      repos: options.repos,
      principal,
      authSecret: config.authSecret,
      environment: config.environment,
      emailOtp: options.emailOtp,
      ...(options.notification === undefined ? {} : { notification: options.notification }),
      ...(options.payment === undefined ? {} : { payment: options.payment }),
      publicOrigin: config.publicOrigin,
      registration: { enabled: config.registrationEnabled, maxUsers: config.registrationLimit },
      capabilities,
      clock,
      logger,
      jobPolicies: options.jobPolicies,
    });
  const anonymous = (request: Request): PlatformPrincipal => ({
    kind: 'anonymous',
    requestId: crypto.randomUUID(),
    ipKey: hashAuthIp(config.authSecret, options.clientIp?.(request) ?? 'untrusted-entry'),
  });
  const app = new Hono<{ Variables: Variables }>();
  app.onError(() =>
    hostedJsonResult({
      ok: false,
      error: { kind: 'internal', cause: 'hosted request failed' },
    }),
  );

  app.use('/api/*', async (_c, next) => {
    const activity = options.maintenance.enter('http-request');
    if (activity === null) return hostedJsonResult(denied('hosted:maintenance'), 503);
    try {
      return await next();
    } finally {
      activity.release();
    }
  });
  app.use('/api/*', async (c, next) => {
    c.header('cache-control', 'no-store');
    const request = c.req.raw;
    const mutation = !['GET', 'HEAD'].includes(request.method);
    if (c.req.path === '/api/webhooks/payment' && request.method === 'POST') return next();
    if (mutation && request.headers.get('origin') !== config.publicOrigin) {
      return hostedJsonResult(denied('security:fixed-origin'));
    }
    const authPath = c.req.path === '/api/auth/challenges' || c.req.path === '/api/auth/sessions';
    const token = cookieToken(request);
    if (authPath && token === null) {
      c.set('platform', platform(anonymous(request)));
      return next();
    }
    if (token === null) return hostedJsonResult(denied('auth:session'), 401);
    const resolved = await resolveAuthSessionTool.execute(
      { sessionToken: token },
      platform(anonymous(request)),
    );
    if (!resolved.ok || resolved.data.principal.kind !== 'user') {
      if (authPath) {
        c.set('platform', platform(anonymous(request)));
        return next();
      }
      return hostedJsonResult(denied('auth:session'), 401);
    }
    const { user, tenant, csrfToken, principal } = resolved.data;
    const expectedUser = request.headers.get('x-luoome-user-id');
    if (expectedUser !== null && expectedUser !== user.id)
      return hostedJsonResult(denied('auth:session-changed'), 401);
    const authenticated = { user, tenant, csrfToken, principal };
    c.set('auth', authenticated);
    c.set('platform', platform(principal));
    if (
      mutation &&
      !authPath &&
      !verifyCsrfToken(request.headers.get('x-csrf-token') ?? '', principal.csrfHash)
    ) {
      return hostedJsonResult(denied('security:csrf'));
    }
    if (authPath || c.req.path === '/api/me' || c.req.path === '/api/auth/session') return next();
    if (tenant.status !== 'active' && tenant.status !== 'suspended') {
      return hostedJsonResult(denied('hosted:tenant-initializing'), 503);
    }
    let lease: TenantRuntimeLease;
    try {
      lease = options.runtimes.acquire({
        tenantId: tenant.id,
        ownerUserId: user.id,
        generation: tenant.generation,
        schemaVersion: tenant.schemaVersion,
      });
    } catch {
      return hostedJsonResult({
        ok: false,
        error: {
          kind: 'adapter_error',
          adapter: 'tenant-runtime',
          cause: 'tenant_unavailable',
          recoverable: true,
        },
      });
    }
    try {
      let selected = request.headers.get('x-luoome-account-id')?.trim() ?? '';
      if (selected && (await lease.runtime.repos.account.findById(selected)) === null) {
        return hostedJsonResult({
          ok: false,
          error: { kind: 'not_found', entity: 'Account', id: selected },
        });
      }
      const identity = Object.freeze({
        mode: 'hosted' as const,
        userId: user.id,
        tenantId: tenant.id,
        tenantGeneration: tenant.generation,
        actor: 'user' as const,
        requestId: principal.requestId,
      });
      const base = buildContext({
        mode: 'hosted',
        identity,
        repos: lease.runtime.repos,
        adapters: {
          market: options.market,
          llm: {
            name: 'hosted-provider-unconfigured',
            generate: async () => {
              throw new Error('LLM provider unavailable');
            },
          },
        },
        user: { id: user.id, defaultAccountId: selected },
        clock,
        logger,
      });
      const context =
        config.productPolicyVersion === 'hosted-web-v2'
          ? await bindHostedDefaultAccount(base, options.createTenantContext)
          : base;
      if (config.productPolicyVersion === 'hosted-web-v2') {
        if (selected && selected !== context.user.defaultAccountId)
          return hostedJsonResult(denied('hosted:default-account'));
        selected = context.user.defaultAccountId;
      }
      const retain = () => {
        const activity = options.maintenance.enter('web-background');
        if (activity === null) throw new Error('hosted maintenance in progress');
        let retained: TenantRuntimeLease;
        try {
          retained = options.runtimes.acquire({
            tenantId: tenant.id,
            ownerUserId: user.id,
            generation: tenant.generation,
            schemaVersion: tenant.schemaVersion,
          });
        } catch (error) {
          activity.release();
          throw error;
        }
        return () => {
          retained.release();
          activity.release();
        };
      };
      c.set('retainRuntime', retain);
      c.set('invocation', {
        context,
        identity,
        entitlement: await options.repos.subscriptions.currentEntitlement({
          tenantId: tenant.id,
          now: clock(),
        }),
        capabilities,
        currentTenant: async () => {
          const session = await options.repos.auth.resolveSession({
            tokenHash: principal.tokenHash,
            now: clock(),
            touch: false,
          });
          if (
            session === null ||
            session.user.id !== user.id ||
            session.tenant.generation !== tenant.generation
          )
            return null;
          return options.repos.tenants.findById(tenant.id);
        },
        currentEntitlement: () =>
          options.repos.subscriptions.currentEntitlement({ tenantId: tenant.id, now: clock() }),
        currentReadWindow: async () =>
          (await options.repos.subscriptions.listPeriods(tenant.id)).some(
            (period) =>
              period.startsAt <= clock() &&
              period.endsAt.getTime() + 30 * 86_400_000 > clock().getTime(),
          ),
      });
      await next();
      if (c.res.headers.get('content-type')?.includes('text/event-stream') && c.res.body !== null) {
        const release = retain();
        const source = c.res.body.getReader();
        let released = false;
        const finish = () => {
          if (released) return;
          released = true;
          release();
        };
        c.res = new Response(
          new ReadableStream({
            async pull(controller) {
              try {
                const chunk = await source.read();
                if (chunk.done) {
                  finish();
                  controller.close();
                } else controller.enqueue(chunk.value);
              } catch (error) {
                finish();
                controller.error(error);
              }
            },
            async cancel(reason) {
              try {
                await source.cancel(reason);
              } finally {
                finish();
              }
            },
          }),
          { status: c.res.status, headers: c.res.headers },
        );
      }
    } finally {
      lease.release();
    }
  });

  const post =
    (handler: (input: unknown, c: Context<{ Variables: Variables }>) => Promise<Response>) =>
    async (c: Context<{ Variables: Variables }>): Promise<Response> => {
      let input: unknown;
      try {
        input = await readJson(c.req.raw);
      } catch {
        return hostedJsonResult(invalid());
      }
      return handler(input, c);
    };
  const operation = async (c: Context<{ Variables: Variables }>, name: string, input: unknown) =>
    hostedJsonResult(await invokeHostedOperation(name, input, c.get('invocation')));

  app.post(
    '/api/auth/challenges',
    post(async (input, c) =>
      hostedJsonResult(await requestAuthChallengeTool.execute(input, c.get('platform'))),
    ),
  );
  app.post(
    '/api/auth/sessions',
    post(async (input, c) => {
      const parsed = z
        .object({
          challengeId: z.string(),
          code: z.string(),
          acceptTerms: z.literal(true),
        })
        .strict()
        .safeParse(input);
      if (!parsed.success) return hostedJsonResult(invalid());
      const result = await createAuthSessionTool.execute(
        {
          challengeId: parsed.data.challengeId,
          code: parsed.data.code,
        },
        c.get('platform'),
      );
      if (!result.ok) return hostedJsonResult(result, 401);
      const response = hostedJsonResult({
        ok: true,
        data: {
          userId: result.data.user.id,
          tenantStatus: result.data.tenant.status,
        },
      });
      response.headers.set(
        'set-cookie',
        `${SESSION_COOKIE}=${result.data.sessionToken}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
      );
      return response;
    }),
  );
  app.get('/api/me', async (c) => {
    const result = await getPlatformMeTool.execute({}, c.get('platform'));
    return hostedJsonResult(
      result.ok
        ? {
            ok: true,
            data: {
              ...result.data,
              productPolicyVersion: config.productPolicyVersion,
              fixture: config.providerMode === 'fixture',
            },
          }
        : result,
    );
  });
  app.delete('/api/auth/session', async (c) => {
    const result = await revokeAuthSessionTool.execute({}, c.get('platform'));
    const response = hostedJsonResult(result);
    if (result.ok)
      response.headers.set(
        'set-cookie',
        `${SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
      );
    return response;
  });

  if (config.productPolicyVersion === 'hosted-facts-v1') {
    app.get('/api/watchlists', (c) => operation(c, 'watchlist.list', {}));
    app.get('/api/watchlists/:id', (c) =>
      operation(c, 'watchlist.get', { watchlistId: c.req.param('id') }),
    );
    app.post(
      '/api/watchlists',
      post(async (input, c) => operation(c, 'watchlist.create', input)),
    );
    app.patch(
      '/api/watchlists/:id',
      post(async (input, c) => {
        if (!z.record(z.string(), z.unknown()).safeParse(input).success)
          return hostedJsonResult(invalid());
        return operation(c, 'watchlist.update', {
          ...(input as Record<string, unknown>),
          watchlistId: c.req.param('id'),
        });
      }),
    );
    app.post(
      '/api/account/select',
      post(async (input, c) => operation(c, 'account.select', input)),
    );
    app.post(
      '/api/watchlists/:id/import/preview',
      post(async (input, c) => {
        if (!z.record(z.string(), z.unknown()).safeParse(input).success)
          return hostedJsonResult(invalid());
        return operation(c, 'watchlist.import.preview', {
          ...(input as Record<string, unknown>),
          watchlistId: c.req.param('id'),
        });
      }),
    );
    app.post(
      '/api/watchlists/import/commit',
      post(async (input, c) => operation(c, 'watchlist.import.commit', input)),
    );
    app.post(
      '/api/watchlists/:id/members/remove',
      post(async (input, c) => {
        if (!z.record(z.string(), z.unknown()).safeParse(input).success)
          return hostedJsonResult(invalid());
        return operation(c, 'watchlist.members.remove', {
          ...(input as Record<string, unknown>),
          watchlistId: c.req.param('id'),
        });
      }),
    );
    app.get('/api/reports', (c) =>
      operation(c, 'report.watchlist-facts.list', {
        ...(c.req.query('watchlistId') === undefined
          ? {}
          : { watchlistId: c.req.query('watchlistId') }),
      }),
    );
    app.get('/api/reports/:id', (c) =>
      operation(c, 'report.watchlist-facts.get', { id: c.req.param('id') }),
    );
    app.get('/api/triggers', (c) => operation(c, 'trigger.list', {}));
    app.get('/api/triggers/:id', (c) =>
      operation(c, 'trigger.get', { triggerId: c.req.param('id') }),
    );
    app.get('/api/watchlists/:id/alerts', (c) =>
      operation(c, 'alert.list', { watchlistId: c.req.param('id') }),
    );
    app.post(
      '/api/alerts',
      post(async (input, c) => operation(c, 'alert.save', input)),
    );
    app.post(
      '/api/alerts/preview',
      post(async (input, c) => operation(c, 'alert.preview', input)),
    );
    app.post(
      '/api/alerts/remove',
      post(async (input, c) => operation(c, 'alert.remove', input)),
    );
    app.post(
      '/api/alerts/pause',
      post(async (input, c) => operation(c, 'alert.pause', input)),
    );
    app.get('/api/triggers/:id/feedback', (c) =>
      operation(c, 'feedback.list', { triggerId: c.req.param('id') }),
    );
    app.post(
      '/api/triggers/:id/feedback',
      post(async (input, c) => {
        if (!z.record(z.string(), z.unknown()).safeParse(input).success)
          return hostedJsonResult(invalid());
        return operation(c, 'feedback.record', {
          ...(input as Record<string, unknown>),
          triggerId: c.req.param('id'),
        });
      }),
    );
  }
  app.post(
    '/api/jobs',
    post(async (input, c) => {
      const result = await submitHostedJob(input, c.get('invocation'), c.get('platform'));
      return hostedJsonResult(
        result.ok
          ? { ok: true, data: { job: jobDto(result.data.job), replayed: result.data.replayed } }
          : result,
        result.ok ? 202 : undefined,
      );
    }),
  );
  app.get('/api/jobs/:id', async (c) => {
    const result = await getHostedJobTool.execute({ jobId: c.req.param('id') }, c.get('platform'));
    return hostedJsonResult(result.ok ? { ok: true, data: jobDto(result.data) } : result);
  });
  app.post(
    '/api/jobs/:id/cancel',
    post(async (input, c) => {
      if (!z.object({}).strict().safeParse(input).success) return hostedJsonResult(invalid());
      const result = await cancelHostedJobTool.execute(
        { jobId: c.req.param('id') },
        c.get('platform'),
      );
      return hostedJsonResult(result.ok ? { ok: true, data: jobDto(result.data) } : result);
    }),
  );
  app.get('/api/subscription', async (c) =>
    hostedJsonResult(await getHostedSubscriptionTool.execute({}, c.get('platform'))),
  );
  app.post(
    '/api/subscription/orders',
    post(async (input, c) =>
      hostedJsonResult(await createHostedSubscriptionOrderTool.execute(input, c.get('platform'))),
    ),
  );
  app.get('/api/subscription/orders', async (c) =>
    hostedJsonResult(await listHostedSubscriptionOrdersTool.execute({}, c.get('platform'))),
  );
  app.post(
    '/api/subscription/orders/:id/query',
    post(async (input, c) => {
      if (!z.object({}).strict().safeParse(input).success) return hostedJsonResult(invalid());
      return hostedJsonResult(
        await queryHostedSubscriptionOrderTool.execute(
          { orderId: c.req.param('id') },
          c.get('platform'),
        ),
      );
    }),
  );
  app.post('/api/webhooks/payment', async (c) => {
    let rawBody: string;
    try {
      rawBody = await readText(c.req.raw, 65_536);
    } catch {
      return hostedJsonResult(invalid());
    }
    const envelope = {
      rawBody,
      timestamp: c.req.header('x-luoome-payment-timestamp') ?? '',
      signature: c.req.header('x-luoome-payment-signature') ?? '',
    };
    const verified = await verifyHostedPaymentWebhookTool.execute(
      envelope,
      platform(anonymous(c.req.raw)),
    );
    if (!verified.ok) return hostedJsonResult(verified);
    return hostedJsonResult(
      await applyHostedPaymentWebhookTool.execute(
        envelope,
        platform({
          kind: 'webhook',
          provider: verified.data.provider,
          eventId: verified.data.eventId,
          requestId: crypto.randomUUID(),
        }),
      ),
    );
  });
  app.get('/api/usage', async (c) =>
    hostedJsonResult(await getHostedUsageTool.execute({}, c.get('platform'))),
  );
  app.get('/api/notifications/preferences', async (c) =>
    hostedJsonResult(await getHostedNotificationPreferencesTool.execute({}, c.get('platform'))),
  );
  app.put(
    '/api/notifications/preferences',
    post(async (input, c) =>
      hostedJsonResult(
        await saveHostedNotificationPreferencesTool.execute(input, c.get('platform')),
      ),
    ),
  );
  app.get('/api/notifications', async (c) =>
    hostedJsonResult(await listHostedDeliveriesTool.execute({}, c.get('platform'))),
  );

  app.post(
    '/api/data/exports',
    post(async (input, c) => {
      const result = await requestHostedExportTool.execute(input, c.get('platform'));
      return hostedJsonResult(
        result.ok
          ? {
              ok: true,
              data: { export: exportDto(result.data.export), replayed: result.data.replayed },
            }
          : result,
        result.ok ? 202 : undefined,
      );
    }),
  );
  app.get('/api/data/exports/:id', async (c) => {
    const result = await getHostedExportTool.execute({ id: c.req.param('id') }, c.get('platform'));
    return hostedJsonResult(
      result.ok ? { ok: true, data: { export: exportDto(result.data.export) } } : result,
    );
  });
  app.get('/api/data/exports/:id/download', async (c) => {
    const input = { id: c.req.param('id') };
    const authorized = await resolveHostedExportDownloadTool.execute(input, c.get('platform'));
    if (!authorized.ok) return hostedJsonResult(authorized);
    const { tenant } = c.get('auth');
    let bytes: Uint8Array;
    try {
      bytes = options.runtimes.readExport(
        {
          tenantId: tenant.id,
          ownerUserId: tenant.ownerUserId,
          generation: tenant.generation,
          schemaVersion: tenant.schemaVersion,
        },
        authorized.data.artifactRef,
      );
      if (
        bytes.length !== authorized.data.byteLength ||
        createHash('sha256').update(bytes).digest('hex') !== authorized.data.resultHash
      )
        throw new Error('export artifact mismatch');
    } catch {
      return hostedJsonResult({
        ok: false,
        error: {
          kind: 'adapter_error',
          adapter: 'private-export',
          cause: 'artifact_unavailable',
          recoverable: true,
        },
      });
    }
    const revalidated = await resolveHostedExportDownloadTool.execute(input, c.get('platform'));
    if (!revalidated.ok) return hostedJsonResult(revalidated);
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-disposition': 'attachment; filename="luoome-personal-data.json"',
        'content-length': String(bytes.length),
        'x-content-type-options': 'nosniff',
      },
    });
  });
  app.post(
    '/api/me/deletion',
    post(async (input, c) => {
      const parsed = z
        .object({ requestId: z.string().min(1).max(160), confirmation: z.literal('删除我的数据') })
        .strict()
        .safeParse(input);
      if (!parsed.success) return hostedJsonResult(invalid());
      const result = await requestHostedDeletionTool.execute(
        { requestId: parsed.data.requestId, confirmationTenantId: c.get('auth').tenant.id },
        c.get('platform'),
      );
      const response = hostedJsonResult(
        result.ok
          ? {
              ok: true,
              data: {
                deletionId: result.data.deletion.id,
                state: result.data.deletion.state,
                acceptedAt: result.data.deletion.createdAt,
              },
            }
          : result,
        result.ok ? 202 : undefined,
      );
      if (result.ok)
        response.headers.set(
          'set-cookie',
          `${SESSION_COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        );
      return response;
    }),
  );

  if (config.productPolicyVersion === 'hosted-facts-v1')
    app.all('/api/*', () => hostedJsonResult(denied('hosted-facts-v1:operation')));
  app.get('/health/live', () =>
    hostedJsonResult({ ok: true, data: { status: 'live', mode: 'hosted' } }),
  );
  app.get('/health/ready', () =>
    !options.emailOtp.configured
      ? hostedJsonResult(denied('service:email-unconfigured'), 503)
      : options.maintenance.state().mode === 'open'
        ? hostedJsonResult({
            ok: true,
            data: { status: 'ready', mode: 'hosted', fixture: config.providerMode === 'fixture' },
          })
        : hostedJsonResult(denied('hosted:maintenance'), 503),
  );
  if (config.productPolicyVersion === 'hosted-web-v2') {
    app.use('/api/*', async (c, next) => {
      if (
        /^\/api\/(?:settings(?:\/|$)|data\/(?:categories|import|export)$|account\/select$)/.test(
          c.req.path,
        )
      )
        return hostedJsonResult(denied('hosted:operator-settings'));
      if (c.req.path === '/api/chat' && !config.exposeExternal)
        return hostedJsonResult(denied('capability:external'));
      if (!['GET', 'HEAD'].includes(c.req.method) && c.req.raw.body !== null) {
        try {
          await readJson(c.req.raw.clone());
        } catch {
          return hostedJsonResult(invalid());
        }
      }
      const authorization = await authorizeHostedWebRequest(
        c.get('invocation'),
        !['GET', 'HEAD'].includes(c.req.method),
      );
      if (authorization !== null) return hostedJsonResult(authorization);
      return next();
    });
    const businessApp = createWebApp(undefined, {
      exposeWrite: config.exposeWrite,
      exposeExternal: config.exposeExternal,
      hosted: {
        request: (c) => ({
          context: contextForHostedWebTools(c.get('invocation'), {
            allowDecisionTrade: c.req.method === 'POST' && c.req.path === '/api/decision-trades',
          }),
          retain: c.get('retainRuntime'),
        }),
      },
    });
    app.route('/', businessApp);
    app.all('/api/*', () => hostedJsonResult(denied('hosted:operation')));
  } else
    for (const [path, file, contentType] of [
      ['/', 'index.html', 'text/html; charset=utf-8'],
      ['/hosted.css', 'hosted.css', 'text/css; charset=utf-8'],
      ['/hosted.js', 'hosted.js', 'text/javascript; charset=utf-8'],
    ]) {
      app.get(
        path as string,
        () =>
          new Response(Bun.file(`${PUBLIC_DIR}${file}`), {
            headers: {
              'content-type': contentType as string,
              'cache-control': 'no-cache',
              'content-security-policy':
                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
              'x-content-type-options': 'nosniff',
              'referrer-policy': 'same-origin',
            },
          }),
      );
    }
  return app;
};

const jobDto = (job: HostedJob) => ({
  id: job.id,
  kind: job.kind,
  state: job.state,
  attempt: job.attempt,
  deadlineAt: job.deadlineAt,
  resultRef: job.resultRef,
  errorKind: job.errorKind,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
});
const exportDto = (metadata: import('@luoome/core').HostedExportMetadata) => ({
  id: metadata.id,
  state: metadata.state,
  byteLength: metadata.byteLength,
  createdAt: metadata.createdAt,
  completedAt: metadata.completedAt,
  expiresAt: metadata.expiresAt,
  errorKind: metadata.errorKind,
});
