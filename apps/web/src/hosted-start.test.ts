import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverModule = fileURLToPath(new URL('./server.ts', import.meta.url));
const entryModule = fileURLToPath(new URL('./index.ts', import.meta.url));
const authCryptoModule = fileURLToPath(
  new URL('../../../packages/tools/src/platform/crypto.ts', import.meta.url),
);
const configFor = (root: string): Record<string, string> => ({
  HOSTED_ENVIRONMENT: 'development',
  HOSTED_DATA_ROOT: join(root, 'service'),
  PUBLIC_ORIGIN: 'https://example.invalid',
  HOSTED_AUTH_SECRET: 'test-only-auth-secret-at-least-32-characters',
  HOSTED_PROVIDER_MODE: 'fixture',
});
const run = async (args: string[], cwd: string, env: Record<string, string>) => {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
};

describe('unified authenticated Web startup', () => {
  it.each([undefined, 'local', 'hosted'])(
    'always protects original business APIs with mode=%s',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'luoome-web-start-'));
      try {
        const env = configFor(root);
        if (mode !== undefined) env.LUOOME_MODE = mode;
        const result = await run(
          [
            '--no-env-file',
            '-e',
            `
        import { startWeb } from ${JSON.stringify(serverModule)};
        const server = await startWeb({ port: 0 });
        try {
          const origin = 'http://127.0.0.1:' + server.port;
          const home = await (await fetch(origin)).text();
          const responses = await Promise.all(['/api/accounts', '/api/watchlists', '/api/strategies'].map(async path => {
            const response = await fetch(origin + path);
            return { status: response.status, body: await response.json() };
          }));
          console.log(JSON.stringify({ originalUi: home.includes('data-runtime="hosted"'), responses }));
        } finally { await server.stop(true); }
      `,
          ],
          root,
          env,
        );
        expect(result.exitCode).toBe(0);
        const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
        expect(parsed.originalUi).toBe(true);
        expect(parsed.responses).toEqual(
          Array.from({ length: 3 }, () => ({
            status: 401,
            body: { ok: false, error: { kind: 'permission_denied', required: 'auth:session' } },
          })),
        );
        expect(existsSync(join(root, 'service', 'control.sqlite'))).toBe(true);
        expect(existsSync(join(root, 'luoome.db'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('does not load local dotenv or open a shared database when service configuration is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-web-config-required-'));
    try {
      writeFileSync(
        join(root, '.env'),
        Object.entries(configFor(root))
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
      );
      const result = await run(['--no-env-file', entryModule], root, {
        LUOOME_HOME: root,
        PORT: '0',
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('invalid hosted configuration');
      expect(existsSync(join(root, 'service'))).toBe(false);
      expect(existsSync(join(root, 'luoome.db'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses startup when Bun implicit dotenv loading is not disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-web-no-env-'));
    try {
      writeFileSync(
        join(root, '.env'),
        Object.entries(configFor(root))
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
      );
      const result = await run([entryModule], root, { PORT: '0' });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('requires bun --no-env-file');
      expect(existsSync(join(root, 'service'))).toBe(false);
      expect(existsSync(join(root, 'luoome.db'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not open a single-user CLI database inside a service environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-web-cli-isolation-'));
    try {
      const cliContext = fileURLToPath(
        new URL('../../../packages/cli/src/context.ts', import.meta.url),
      );
      const result = await run(
        [
          '--no-env-file',
          '-e',
          `
        import { createCliContext } from ${JSON.stringify(cliContext)};
        await createCliContext();
      `,
        ],
        root,
        { ...configFor(root), LUOOME_HOME: join(root, 'personal') },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('CLI business context is local-only');
      expect(existsSync(join(root, 'personal'))).toBe(false);
      expect(existsSync(join(root, 'service'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a single forwarded IP only from the configured socket peer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-web-proxy-'));
    try {
      const result = await run(
        [
          '--no-env-file',
          '-e',
          `
        import { Database } from 'bun:sqlite';
        import { startWeb } from ${JSON.stringify(serverModule)};
        import { hashAuthIp } from ${JSON.stringify(authCryptoModule)};
        const results = [];
        const cases = [
          [undefined, '203.0.113.7', '127.0.0.1'],
          ['192.0.2.1', '203.0.113.7', '127.0.0.1'],
          ['127.0.0.1', '203.0.113.7', '203.0.113.7'],
          ['127.0.0.1', '2001:db8::1', '2001:db8::1'],
          ['127.0.0.1', '203.0.113.7, 192.0.2.1', '127.0.0.1'],
          ['127.0.0.1', 'invalid-ip', '127.0.0.1'],
        ];
        for (const [trusted, forwarded, expected] of cases) {
          if (trusted === undefined) delete process.env.HOSTED_TRUSTED_PROXY_IP;
          else process.env.HOSTED_TRUSTED_PROXY_IP = trusted;
          const server = await startWeb({ port: 0 });
          try {
            const response = await fetch('http://127.0.0.1:' + server.port + '/api/auth/challenges', {
              method: 'POST',
              headers: { 'content-type': 'application/json', origin: process.env.PUBLIC_ORIGIN, 'x-forwarded-for': forwarded },
              body: JSON.stringify({ email: 'proxy-' + results.length + '@example.invalid' }),
            });
            const body = await response.json();
            const db = new Database(process.env.HOSTED_DATA_ROOT + '/control.sqlite', { readonly: true });
            try {
              const row = db.query('SELECT ip_hash FROM hosted_auth_challenges WHERE id = ?').get(body.data?.challengeId ?? 'missing');
              results.push({ status: response.status, matched: row?.ip_hash === hashAuthIp(process.env.HOSTED_AUTH_SECRET, expected) });
            } finally { db.close(); }
          } finally { await server.stop(true); }
        }
        console.log(JSON.stringify(results));
      `,
        ],
        root,
        { ...configFor(root), LUOOME_EXPOSE_WRITE: 'true', LUOOME_EXPOSE_EXTERNAL: 'true' },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')).toEqual(
        Array.from({ length: 6 }, () => ({ status: 200, matched: true })),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects incomplete TLS configuration before opening storage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-web-tls-config-'));
    try {
      for (const variable of ['HOSTED_TLS_CERT_FILE', 'HOSTED_TLS_KEY_FILE']) {
        const result = await run(['--no-env-file', entryModule], root, {
          ...configFor(root),
          [variable]: join(root, 'not-opened.pem'),
          PORT: '0',
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain('TLS needs both certificate and key');
        expect(existsSync(join(root, 'service'))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('closes storage after listener or TLS failure and allows a clean retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-web-start-cleanup-'));
    try {
      const invalidPem = join(root, 'invalid.pem');
      writeFileSync(invalidPem, 'invalid-test-only-pem');
      const result = await run(
        [
          '--no-env-file',
          '-e',
          `
        import { Database } from 'bun:sqlite';
        import { existsSync } from 'node:fs';
        import { startWeb } from ${JSON.stringify(serverModule)};
        const databases = new Set();
        const exec = Database.prototype.exec;
        Database.prototype.exec = function(...args) {
          databases.add(this);
          return exec.apply(this, args);
        };
        const occupied = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('occupied') });
        const results = [];
        try {
          for (const failure of ['port', 'tls']) {
            if (failure === 'tls') {
              process.env.HOSTED_TLS_CERT_FILE = ${JSON.stringify(invalidPem)};
              process.env.HOSTED_TLS_KEY_FILE = ${JSON.stringify(invalidPem)};
            }
            let rejected = false;
            let unexpected;
            try { unexpected = await startWeb({ port: failure === 'port' ? occupied.port : 0 }); }
            catch { rejected = true; }
            finally { await unexpected?.stop(true); }
            const path = process.env.HOSTED_DATA_ROOT + '/control.sqlite';
            const closed = [...databases].every(db => {
              try { db.query('SELECT 1').get(); return false; }
              catch { return true; }
            });
            results.push({ rejected, created: existsSync(path), opened: databases.size, closed });
          }
          delete process.env.HOSTED_TLS_CERT_FILE;
          delete process.env.HOSTED_TLS_KEY_FILE;
          const retry = await startWeb({ port: 0 });
          try {
            results.push({ retryStatus: (await fetch('http://127.0.0.1:' + retry.port + '/api/accounts')).status });
          } finally { await retry.stop(true); }
        } finally { await occupied.stop(true); }
        console.log(JSON.stringify(results));
      `,
        ],
        root,
        configFor(root),
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')).toEqual([
        { rejected: true, created: true, opened: 1, closed: true },
        { rejected: true, created: true, opened: 2, closed: true },
        { retryStatus: 401 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects the reduced legacy Web policy and production fixture providers before listening', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-web-start-reject-'));
    try {
      for (const [overrides, error] of [
        [{ HOSTED_PRODUCT_POLICY: 'hosted-facts-v1' }, 'complete Web product policy'],
        [{ HOSTED_ENVIRONMENT: 'production' }, 'fixture providers cannot serve production'],
      ] as const) {
        const result = await run(['--no-env-file', entryModule], root, {
          ...configFor(root),
          ...overrides,
          PORT: '0',
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain(error);
        expect(existsSync(join(root, 'service'))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
