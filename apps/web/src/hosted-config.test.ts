import { describe, expect, it } from 'vitest';
import {
  assertHostedEnvironmentIsolation,
  loadHostedConfig,
  resolveRuntimeMode,
} from './hosted-config.js';

const configuration = {
  LUOOME_MODE: 'hosted',
  HOSTED_ENVIRONMENT: 'development',
  HOSTED_DATA_ROOT: '/tmp/hosted-config-test',
  PUBLIC_ORIGIN: 'https://localhost:5443',
  HOSTED_AUTH_SECRET: 'test-only-secret-with-at-least-32-characters',
  HOSTED_PRODUCT_POLICY: 'hosted-facts-v1',
  HOSTED_PROVIDER_MODE: 'fixture',
};

describe('authenticated Web configuration', () => {
  it('requires disabled dotenv loading and a separate production deletion journal', () => {
    expect(() => assertHostedEnvironmentIsolation([])).toThrow('no-env-file');
    expect(() => assertHostedEnvironmentIsolation(['--no-env-file'])).not.toThrow();
    const production = {
      ...configuration,
      HOSTED_ENVIRONMENT: 'production',
      HOSTED_PROVIDER_MODE: 'configured',
    };
    expect(() => loadHostedConfig(production)).toThrow('independent deletion ledger');
    expect(() =>
      loadHostedConfig({
        ...production,
        HOSTED_DELETION_LEDGER_ROOT: `${configuration.HOSTED_DATA_ROOT}/ledger`,
      }),
    ).toThrow('independent deletion ledger');
    expect(
      loadHostedConfig({
        ...production,
        HOSTED_DELETION_LEDGER_ROOT: '/tmp/independent-hosted-deletions',
      }).environment,
    ).toBe('production');
    expect(() =>
      loadHostedConfig({ ...configuration, HOSTED_TRUSTED_PROXY_IP: 'proxy.example.invalid' }),
    ).toThrow('explicit IP');
    expect(
      loadHostedConfig({ ...configuration, HOSTED_TRUSTED_PROXY_IP: '127.0.0.1' }).trustedProxyIp,
    ).toBe('127.0.0.1');
  });
  it('retains the internal single-user mode parser without using it to select a Web server', () => {
    expect(resolveRuntimeMode({})).toBe('local');
    expect(() => resolveRuntimeMode({ LUOOME_MODE: 'cloud' })).toThrow();
    expect(() => loadHostedConfig({})).toThrow();
    for (const mode of [undefined, 'local', 'hosted', 'obsolete']) {
      expect(loadHostedConfig({ ...configuration, LUOOME_MODE: mode }).mode).toBe('hosted');
    }
    expect(
      loadHostedConfig({
        ...configuration,
        LUOOME_MODE: undefined,
        HOSTED_PRODUCT_POLICY: undefined,
        HOSTED_PROVIDER_MODE: undefined,
      }),
    ).toMatchObject({
      mode: 'hosted',
      productPolicyVersion: 'hosted-web-v2',
      providerMode: 'configured',
    });
  });

  it('requires every identity, storage and policy setting without leaking the secret', () => {
    for (const key of Object.keys(configuration)) {
      if (['LUOOME_MODE', 'HOSTED_PRODUCT_POLICY', 'HOSTED_PROVIDER_MODE'].includes(key)) continue;
      const env: Record<string, string | undefined> = { ...configuration, [key]: undefined };
      expect(() => loadHostedConfig(env)).toThrow();
    }
    expect(() => loadHostedConfig({ ...configuration, HOSTED_AUTH_SECRET: 'private' })).toThrow(
      'authSecret',
    );
  });

  it('uses a fixed HTTPS origin and forbids fixture production and trade', () => {
    for (const origin of [
      'http://localhost',
      'https://example.test/path',
      'https://user@example.test',
    ]) {
      expect(() => loadHostedConfig({ ...configuration, PUBLIC_ORIGIN: origin })).toThrow();
    }
    expect(() => loadHostedConfig({ ...configuration, HOSTED_ENVIRONMENT: 'production' })).toThrow(
      'fixture',
    );
    expect(() => loadHostedConfig({ ...configuration, LUOOME_EXPOSE_TRADE: 'true' })).toThrow(
      'trade',
    );
  });

  it('requires explicit capabilities and registration, with bounded runtime capacity', () => {
    const config = loadHostedConfig(configuration);
    expect(config.exposeWrite).toBe(false);
    expect(config.exposeExternal).toBe(false);
    expect(config.registrationEnabled).toBe(false);
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => loadHostedConfig({ ...configuration, HOSTED_RUNTIME_LIMIT: '0' })).toThrow();
  });

  it('allows a fixed HTTP origin only with the explicit temporary transport opt-in', () => {
    const http = { ...configuration, PUBLIC_ORIGIN: 'http://example.test:5173' };
    expect(() => loadHostedConfig(http)).toThrow('HTTPS');
    expect(() => loadHostedConfig({ ...http, HOSTED_ALLOW_INSECURE_HTTP: 'false' })).toThrow();
    expect(loadHostedConfig({ ...http, HOSTED_ALLOW_INSECURE_HTTP: 'true' }).publicOrigin).toBe(
      http.PUBLIC_ORIGIN,
    );
    for (const value of ['yes', '1', 'TRUE'])
      expect(() => loadHostedConfig({ ...http, HOSTED_ALLOW_INSECURE_HTTP: value })).toThrow();
    for (const origin of [
      'http://example.test/path',
      'http://user@example.test',
      'ftp://example.test',
    ])
      expect(() =>
        loadHostedConfig({ ...http, PUBLIC_ORIGIN: origin, HOSTED_ALLOW_INSECURE_HTTP: 'true' }),
      ).toThrow();
  });
});
