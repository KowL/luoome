import { Readable } from 'node:stream';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { PluginPrincipal } from '@luoome/tools';
import { createDshOperationHost } from './dsh-authority.js';
import type { MarketSurface } from './market-surface.js';
import { createOperationHandler } from './operations.js';
import { createPanelStateHandler } from './panels.js';
import type { ReadSurface } from './read-surface.js';
import { createReadCallHandler } from './routes.js';
import { registerReadTools } from './tools.js';

export const mountDshWebProfile = (
  ctx: Context,
  options: Parameters<typeof createDshOperationHost>[1] & {
    readonly read: ReadSurface;
    /** 面板数据路由的市场 external 面；与 read 分开，按名调用未暴露工具仍被拒绝。 */
    readonly market: MarketSurface;
    readonly principalForOwner: () => PluginPrincipal | null;
  },
) => {
  if (
    !ctx.get('connection') ||
    !ctx.get('webServer') ||
    !ctx.get('sessionController') ||
    !ctx.get('approval')
  )
    throw new Error(
      'Luoome Web requires Connection, WebServer, SessionController and ApprovalService',
    );
  const host = createDshOperationHost(ctx, options);
  const readNames = new Set(options.read.descriptors().map((tool) => tool.name));
  const removers: (() => void)[] = [];
  const operations = createOperationHandler(host.service, () => options.principalForOwner());
  const routes = new Map<
    string,
    { methods: ('GET' | 'POST')[]; fetch: (r: Request) => Promise<Response> }
  >();
  const register = (
    path: string,
    methods: ('GET' | 'POST')[],
    fetch: (r: Request) => Promise<Response>,
  ) => {
    routes.set(path, { methods, fetch });
  };
  try {
    removers.push(
      ctx.tools.guard((execution) => {
        if (!readNames.has(execution.name)) return;
        const principal = host.identity.principal(execution.agent);
        const owner = options.principalForOwner();
        if (
          !principal ||
          !owner ||
          principal.userId !== owner.userId ||
          principal.accountId !== owner.accountId
        )
          return 'A live, top-level session for the current owner account is required';
      }),
    );
    removers.push(registerReadTools(ctx.tools, options.read));
    register(
      '/api/luoome/call',
      ['POST'],
      createReadCallHandler(options.read, () => null),
    );
    // M4：三面板宿主只读数据路由。panel→工具映射固定在服务端，URL 只接受 panel 名；
    // prefix 层已做 Connection.admit + owner 校验，这里与 /call 一样传空 admission。
    register(
      '/api/luoome/state',
      ['GET'],
      createPanelStateHandler({
        read: options.read,
        market: options.market,
        admit: () => null,
        now: () => new Date(options.now()),
      }),
    );
    register('/api/luoome/operations/prepare', ['POST'], operations);
    register('/api/luoome/profile', ['GET'], async () => {
      const principal = options.principalForOwner();
      if (!principal) return new Response(null, { status: 403 });
      return Response.json(
        {
          profile: options.profile,
          accountId: principal.accountId,
          automationsEnabled: options.automationsEnabled === true,
          readTools: [...readNames],
          policies: options.policies.map(({ tool, scheduled }) => ({
            name: tool.name,
            description: tool.description,
            scheduled,
          })),
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    });
  } catch (error) {
    for (const remove of removers.reverse()) remove();
    host.dispose();
    throw error;
  }
  // The SDK Fetch bridge rewrites the origin and cannot stream GET. Keep the
  // listener URL and the 64 KiB streaming cap while reusing its real admission.
  const remove = ctx.webServer.register({
    kind: 'prefix',
    path: '/api/luoome',
    async handler(incoming, outgoing) {
      const lifetime = new AbortController();
      outgoing.once('close', () => {
        if (!outgoing.writableEnded) lifetime.abort();
      });
      let response: Response;
      try {
        const admission = ctx.connection.admit(incoming);
        if ('rejection' in admission)
          response = new Response(null, { status: admission.rejection });
        else if (admission.peer.principal.kind !== 'owner')
          response = new Response(null, { status: 403 });
        else {
          const origin = new URL(`${ctx.webServer.protocol}//${incoming.headers.host}`).origin;
          const url = new URL(incoming.url ?? '/', origin);
          const route =
            routes.get(url.pathname) ??
            (url.pathname.startsWith('/api/luoome/operations/')
              ? { methods: ['GET', 'POST'] as ('GET' | 'POST')[], fetch: operations }
              : undefined);
          const method = incoming.method ?? 'GET';
          if (url.origin !== origin) response = new Response(null, { status: 403 });
          else if (!route) response = new Response(null, { status: 404 });
          else if (!route.methods.includes(method as 'GET' | 'POST'))
            response = new Response(null, {
              status: 405,
              headers: { allow: route.methods.join(', ') },
            });
          else {
            const headers = new Headers();
            for (const [key, value] of Object.entries(incoming.headers)) {
              if (typeof value === 'string') headers.set(key, value);
            }
            const init: RequestInit & { duplex?: 'half' } = {
              method,
              headers,
              signal: lifetime.signal,
              ...(method === 'POST'
                ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' }
                : {}),
            };
            response = await route.fetch(new Request(url.toString(), init));
          }
        }
      } catch {
        response = Response.json(
          { ok: false, error: { kind: 'unavailable', message: 'Web operation unavailable' } },
          { status: 503 },
        );
      }
      if (outgoing.destroyed) return;
      const headers = Object.fromEntries(response.headers);
      headers['cache-control'] = 'no-store';
      if (!incoming.readableEnded) headers.connection = 'close';
      outgoing.writeHead(response.status, headers);
      const body = Buffer.from(await response.arrayBuffer());
      await new Promise<void>((done) => {
        outgoing.once('close', done);
        outgoing.end(body, done);
      });
      if (!incoming.readableEnded) incoming.destroy();
    },
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    options.read.dispose();
    for (const remove of removers.reverse()) remove();
    host.dispose();
    remove();
    routes.clear();
  };
  ctx.effect(() => dispose);
  return { ...host, dispose };
};
