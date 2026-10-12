import { isIP } from 'node:net';
import {
  type HostedProviders,
  loadConfiguredHostedProviders,
  openHostedService,
} from './hosted-composition.js';
import { assertHostedEnvironmentIsolation, loadHostedConfig } from './hosted-config.js';
import { createHostedWebApp } from './hosted-server.js';

export const startHostedWeb = async (options: {
  readonly port: number;
  readonly host?: string;
  readonly providers?: HostedProviders;
}) => {
  assertHostedEnvironmentIsolation();
  const config = loadHostedConfig();
  const service = openHostedService(
    config,
    options.providers ?? (await loadConfiguredHostedProviders(config)),
  );
  try {
    const addresses = new WeakMap<Request, string>();
    const app = createHostedWebApp({
      config,
      repos: service.repos,
      runtimes: service.runtimes,
      maintenance: service.maintenance,
      emailOtp: service.providers.emailOtp,
      notification: service.providers.notification,
      payment: service.providers.payment,
      market: service.providers.market,
      ...(service.providers.createTenantContext === undefined
        ? {}
        : { createTenantContext: service.providers.createTenantContext }),
      jobPolicies: service.providers.jobPolicies,
      clientIp: (request) => {
        const address = addresses.get(request) ?? 'untrusted-entry';
        const forwarded = request.headers.get('x-forwarded-for');
        return address === config.trustedProxyIp && forwarded !== null && isIP(forwarded) !== 0
          ? forwarded
          : address;
      },
    });
    const cert = process.env.HOSTED_TLS_CERT_FILE;
    const key = process.env.HOSTED_TLS_KEY_FILE;
    if ((cert === undefined) !== (key === undefined))
      throw new Error('hosted TLS needs both certificate and key');
    const server = Bun.serve({
      port: options.port,
      hostname: options.host ?? process.env.LUOOME_HOST ?? '127.0.0.1',
      fetch: (request, listener) => {
        const address = listener.requestIP(request)?.address;
        if (address !== undefined) addresses.set(request, address);
        return app.fetch(request);
      },
      idleTimeout: 60,
      ...(cert === undefined || key === undefined
        ? {}
        : { tls: { cert: Bun.file(cert), key: Bun.file(key) } }),
    });
    console.info(
      `luoome hosted listening on port ${server.port}; providers=${config.providerMode}`,
    );
    return {
      port: server.port as number,
      stop: async (closeActiveConnections = false) => {
        await server.stop(closeActiveConnections);
        service.close();
      },
    };
  } catch (error) {
    service.close();
    throw error;
  }
};
