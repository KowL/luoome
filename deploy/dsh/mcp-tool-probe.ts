/**
 * 数一个 MCP 实例真实暴露的工具清单（stdio JSON-RPC）。
 * 用法：bun mcp-tool-probe.ts <serverName> [KEY=VALUE ...]
 * 不给 KEY=VALUE 时，从 DSH profile 补丁里取该实例那一行的 env，
 * 这样探的就是部署里真实在跑的那套暴露面，而不是默认实例。
 * 输出：工具总数与队列工具命中数，供部署后核对暴露面。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [serverName, ...envPairs] = process.argv.slice(2);
if (!serverName) {
  console.error('usage: mcp-tool-probe.ts <serverName> [KEY=VALUE ...]');
  process.exit(2);
}

const env: Record<string, string> = { ...process.env };

const profileEnv = (name: string): Record<string, string> | undefined => {
  const dshHome = process.env.DSH_HOME ?? '/var/lib/dsh';
  const profile = process.env.DSH_PROFILE ?? 'luoome-web';
  const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  let text: string;
  try {
    text = readFileSync(patchPath, 'utf8');
  } catch {
    return undefined;
  }
  const doc = JSON.parse(text) as unknown;
  const ops = Array.isArray(doc) ? doc : [doc];
  const rows = ops.flatMap((op) =>
    op && typeof op === 'object' && 'insert' in op && Array.isArray(op.insert) ? op.insert : [],
  ) as { config?: { serverName?: string; env?: Record<string, string> } }[];
  const row = rows.find((candidate) => candidate.config?.serverName === name);
  return row?.config?.env;
};

if (envPairs.length === 0) {
  const fromProfile = profileEnv(serverName);
  if (fromProfile === undefined) {
    console.error(`profile 里找不到实例 ${serverName}，或补丁文件不可读`);
    process.exit(2);
  }
  Object.assign(env, fromProfile);
} else {
  for (const pair of envPairs) {
    const index = pair.indexOf('=');
    if (index > 0) env[pair.slice(0, index)] = pair.slice(index + 1);
  }
}

const proc = Bun.spawn(['bun', '--no-env-file', 'packages/cli/src/index.ts', 'mcp', 'serve'], {
  cwd: process.env.LUOOME_MCP_CWD ?? '/app',
  env,
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
});

const send = async (message: unknown) => {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
  await proc.stdin.flush();
};

const decoder = new TextDecoder();
let buffer = '';
interface JsonRpcResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}
const pending = new Map<number, (value: JsonRpcResponse) => void>();
const notifications: string[] = [];

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
        const message = JSON.parse(line);
        if (typeof message.id === 'number' && pending.has(message.id)) {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        } else if (message.method) {
          notifications.push(`${message.method}`);
        }
      } catch {
        notifications.push(`unparsed:${line.slice(0, 80)}`);
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
    void send({ jsonrpc: '2.0', id, method, params });
    setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
  });

await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'mcp-tool-probe', version: '1.0.0' },
});
void send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const listed = (await call('tools/list', {})) as { readonly tools?: readonly { name: string }[] };
const names: string[] = (listed.tools ?? []).map((tool) => tool.name);
const queueNames = names.filter((name) => /^((get|list)_analysis_)|queue/.test(name));

console.log(
  JSON.stringify({
    serverName,
    total: names.length,
    queueTools: queueNames.length,
    queueNames: queueNames.sort(),
    hasWriteBack: names.some((name) => name.startsWith('record_')),
  }),
);

proc.kill();
await reader.catch(() => undefined);
process.exit(0);
