/**
 * 设置面端到端验收：在「设置面」实例写一个自选清单，再在「读面」实例读回来。
 *
 * 两个实例都是 DSH profile 里真实在跑的那两行（环境从 profile 补丁读），
 * 但事实库指向隔离目录，不碰线上数据。
 *
 * 用法：bun settings-e2e.ts [LUOOME_HOME 隔离目录]
 */

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const dshHome = process.env.DSH_HOME ?? '/var/lib/dsh';
const profile = process.env.DSH_PROFILE ?? 'luoome-web';
const luoomeHome = process.argv[2] ?? '/tmp/luoome-settings-e2e';

if (!luoomeHome.startsWith('/tmp/luoome-settings-e2e'))
  throw new Error('E2E requires an isolated /tmp directory');
await mkdir(luoomeHome, { recursive: true });

const profileEnv = (name: string): Record<string, string> => {
  const text = readFileSync(join(dshHome, 'profiles', profile, 'cordis.patch.yml'), 'utf8');
  const doc = JSON.parse(text) as unknown;
  const ops = Array.isArray(doc) ? doc : [doc];
  const rows = ops.flatMap((op) =>
    op && typeof op === 'object' && 'insert' in op && Array.isArray(op.insert) ? op.insert : [],
  ) as { config?: { serverName?: string; env?: Record<string, string> } }[];
  const row = rows.find((candidate) => candidate.config?.serverName === name);
  if (!row?.config?.env) throw new Error(`profile 里找不到实例 ${name}`);
  return row.config.env;
};

interface McpClient {
  readonly call: (method: string, params: unknown) => Promise<unknown>;
  close(): Promise<void>;
}

const openInstance = async (serverName: string): Promise<McpClient> => {
  const env: Record<string, string> = {
    ...process.env,
    ...profileEnv(serverName),
    LUOOME_HOME: luoomeHome,
  } as Record<string, string>;
  const proc = Bun.spawn(['bun', '--no-env-file', 'packages/cli/src/index.ts', 'mcp', 'serve'], {
    cwd: process.env.LUOOME_MCP_CWD ?? '/app',
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const decoder = new TextDecoder();
  let buffer = '';
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  const reader = (async () => {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const message = JSON.parse(line) as { id?: number };
          if (typeof message.id === 'number' && pending.has(message.id)) {
            pending.get(message.id)?.(message);
            pending.delete(message.id);
          }
        } catch {
          // 非 JSON 行忽略
        }
      }
    }
  })();
  let nextId = 1;
  const call = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (message) =>
        message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result),
      );
      void proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      void proc.stdin.flush();
      setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
    });
  await call('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'settings-e2e', version: '1.0.0' },
  });
  void proc.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  );
  void proc.stdin.flush();
  return {
    call,
    close: async () => {
      proc.kill();
      await reader.catch(() => undefined);
    },
  };
};

const settings = await openInstance('luoome-settings');
let created: unknown;
try {
  created = await settings.call('tools/call', {
    name: 'create_watchlist',
    arguments: { name: '验收清单', kind: 'personal', membershipPolicy: 'manual' },
  });
} finally {
  await settings.close();
}

const read = await openInstance('luoome');
let listed: unknown;
try {
  listed = await read.call('tools/call', { name: 'list_watchlists', arguments: {} });
} finally {
  await read.close();
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value ?? null);
console.log(
  JSON.stringify({
    luoomeHome,
    created: text(created).slice(0, 200),
    listed: text(listed).slice(0, 400),
    settingsWriteVisibleToRead: text(listed).includes('验收清单'),
  }),
);
