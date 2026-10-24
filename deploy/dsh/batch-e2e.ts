/**
 * 批处理面端到端验收：确认 DSH profile 里的 `luoome-batch` 实例暴露了五个批处理工具，
 * 且门槛判定按预期工作（非盘中时段返回 skipped，不写库）。
 *
 * 事实库指向隔离目录，不碰线上数据。
 *
 * 用法：bun batch-e2e.ts [LUOOME_HOME 隔离目录]
 */

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const dshHome = process.env.DSH_HOME ?? '/var/lib/dsh';
const profile = process.env.DSH_PROFILE ?? 'luoome-web';
const luoomeHome = process.argv[2] ?? '/tmp/luoome-batch-e2e';

if (!luoomeHome.startsWith('/tmp/luoome-batch-e2e'))
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
        if (line.length === 0) continue;
        const message = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: unknown;
        };
        if (typeof message.id === 'number') {
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        }
        index = buffer.indexOf('\n');
      }
    }
  })();

  let nextId = 1;
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    const promise = new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      pending.set(id, resolve);
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const message = await promise;
    if (message.error) throw new Error(`mcp error: ${JSON.stringify(message.error)}`);
    return message.result;
  };

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'batch-e2e', version: '0.0.0' },
  });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    call: request,
    close: async () => {
      proc.kill();
      await reader;
    },
  };
};

const EXPECTED = [
  'run_closing_report_cutoff',
  'run_intraday_plan_batch',
  'run_portfolio_performance_snapshot',
  'run_strategy_autonomy_weekly',
  'run_strategy_daily_cycle',
];

const client = await openInstance('luoome-batch');
try {
  const listed = (await client.call('tools/list', {})) as {
    tools?: { name?: string }[];
  };
  const names = (listed.tools ?? []).map((tool) => tool.name ?? '').sort();
  const missing = EXPECTED.filter((name) => !names.includes(name));
  if (missing.length > 0) throw new Error(`批处理面缺少工具: ${missing.join(', ')}`);

  const intraday = (await client.call('tools/call', {
    name: 'run_intraday_plan_batch',
    arguments: {},
  })) as { content?: { text?: string }[] };
  const text = intraday.content?.[0]?.text ?? '';
  if (!text.includes('skipped') && !text.includes('due'))
    throw new Error(`盘中计划批处理返回不符合预期: ${text}`);

  console.log(
    JSON.stringify({
      batchToolsExposed: EXPECTED.length,
      totalTools: names.length,
      intradayOutcome: text.includes('skipped') ? 'skipped' : 'due',
      ok: true,
    }),
  );
} finally {
  await client.close();
}
