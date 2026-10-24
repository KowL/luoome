import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverModule = fileURLToPath(new URL('./server.ts', import.meta.url));

const run = async (args: string[], cwd: string, env: Record<string, string>) => {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill(), 15_000);
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

/**
 * 单机形态的 Web 启动契约。
 *
 * 入口不再经过认证外壳与租户运行时：本地 ctx + 本地设置 store，
 * 事实库建在 LUOOME_HOME 下，托管形态的 service 目录不应出现。
 */
describe('单机 Web 启动', () => {
  it('本地启动后提供业务 API，且不是托管运行时', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-web-local-'));
    try {
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
          const accounts = await fetch(origin + '/api/accounts');
          console.log(JSON.stringify({
            home: home.slice(0, 400),
            accounts: accounts.status,
          }));
        } finally { await server.stop(true); }
      `,
        ],
        root,
        { LUOOME_HOME: join(root, 'home'), LUOOME_MARKET_PROVIDER: 'real', PORT: '0' },
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
      expect(parsed.accounts).toBe(200);
      expect(existsSync(join(root, 'home', 'luoome.db'))).toBe(true);
      // 单机形态不创建服务目录
      expect(existsSync(join(root, 'service'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('默认不开放写能力', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-web-local-write-'));
    try {
      const result = await run(
        [
          '--no-env-file',
          '-e',
          `
        import { startWeb } from ${JSON.stringify(serverModule)};
        const server = await startWeb({ port: 0 });
        try {
          const origin = 'http://127.0.0.1:' + server.port;
          const response = await fetch(origin + '/api/watchlists', { method: 'POST' });
          console.log(JSON.stringify({ status: response.status }));
        } finally { await server.stop(true); }
      `,
        ],
        root,
        { LUOOME_HOME: join(root, 'home'), LUOOME_MARKET_PROVIDER: 'real', PORT: '0' },
      );
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '');
      expect(parsed.status).not.toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
