// @luoome/mcp —— MCP stdio smoke 测试（纯 bun 脚本，非 vitest）。
//
// 运行：LUOOME_MARKET_PROVIDER=real LUOOME_MARKET_SOURCES=sina bun packages/mcp/src/smoke.ts
//
// 覆盖（spawn 真实 server 进程，MCP stdio JSON-RPC 握手）：
//   1. initialize → tools/list：默认暴露面与 registry 的 read/advice 选择策略一致
//   2. tools/call list_accounts / list_holdings：空库返回事实，不注入样例数据
//   3. tools/call analyze_stock：空库明确返回 Stock not_found，不伪造 Advice
//   4. 相同 LUOOME_HOME 二次 spawn：空库初始化幂等，重复启动安全
//   5. LUOOME_EXPOSE_TRADE=true spawn：进程退出码非零（trade 永不暴露）
//
// 说明：子进程用 process.execPath（即当前 bun 二进制）启动，等价于
// `bun packages/mcp/src/index.ts`；env 显式透传（含 PATH）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolRegistry } from '@luoome/tools';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { resolveAllowedSideEffects, selectMcpTools } from './exposure.js';

const indexPath = fileURLToPath(new URL('./index.ts', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const REQUEST_TIMEOUT_MS = 10_000;

// ---------- 最小断言 ----------

let checks = 0;
let failures = 0;
const check = (cond: boolean, label: string): void => {
  checks += 1;
  if (cond) {
    console.log(`ok ${checks} - ${label}`);
  } else {
    failures += 1;
    console.error(`not ok ${checks} - ${label}`);
  }
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
  }
  return value as Record<string, unknown>;
};

/** tools/call 的 result → 解析 content[0].text 的 JSON；isError 直接抛错。 */
const parseToolResultText = (result: unknown): Record<string, unknown> => {
  const r = asRecord(result);
  if (r.isError === true) {
    throw new Error(`tool returned isError: ${JSON.stringify(r.content)}`);
  }
  const content = r.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('tools/call result missing content');
  }
  const first = asRecord(content[0]);
  if (typeof first.text !== 'string') {
    throw new Error('tools/call content[0].text is not a string');
  }
  return asRecord(JSON.parse(first.text));
};

// ---------- 最小 MCP stdio 客户端（NDJSON 帧） ----------

type ServerProc = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

interface PendingEntry {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

class McpStdioClient {
  private nextId = 1;
  private buffer = '';
  private stderrBuf = '';
  private readonly pending = new Map<number, PendingEntry>();

  private constructor(private readonly proc: ServerProc) {
    void this.pumpStdout();
    void this.pumpStderr();
  }

  /** spawn server 进程；LUOOME_HOME 指向独立临时目录（hermetic）。 */
  static spawn(
    extraEnv: Record<string, string>,
    home?: string,
  ): { client: McpStdioClient; home: string } {
    const effectiveHome = home ?? mkdtempSync(join(tmpdir(), 'luoome-mcp-smoke-'));
    const proc = Bun.spawn([process.execPath, indexPath], {
      cwd: repoRoot,
      env: { ...process.env, LUOOME_HOME: effectiveHome, ...extraEnv },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { client: new McpStdioClient(proc), home: effectiveHome };
  }

  get stderrText(): string {
    return this.stderrBuf;
  }

  private async pumpStdout(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.proc.stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        this.drainLines();
      }
    } catch {
      // 流被 kill 打断，落入统一收尾。
    } finally {
      this.buffer += decoder.decode();
      this.drainLines();
      const stderr = this.stderrBuf.trim();
      this.failAllPending(
        new Error(stderr.length === 0 ? 'server stdout closed' : `server stdout closed: ${stderr}`),
      );
    }
  }

  private async pumpStderr(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.proc.stderr.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.stderrBuf += decoder.decode(value, { stream: true });
      }
    } catch {
      // 同上。
    }
  }

  private drainLines(): void {
    for (;;) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) return;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line === '') continue;
      let msg: { id?: unknown; result?: unknown; error?: unknown };
      try {
        msg = asRecord(JSON.parse(line));
      } catch {
        continue; // 非协议行忽略（不应发生：server 日志全走 stderr）
      }
      if (msg.id === undefined || (msg.result === undefined && msg.error === undefined)) continue;
      const id = Number(msg.id);
      const entry = this.pending.get(id);
      if (entry === undefined) continue;
      this.pending.delete(id);
      if (msg.error !== undefined) {
        entry.reject(new Error(`JSON-RPC error: ${JSON.stringify(msg.error)}`));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  private failAllPending(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private async send(message: Record<string, unknown>): Promise<void> {
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    await this.proc.stdin.flush();
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`request "${method}" timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }
      }, REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    await this.send({ jsonrpc: '2.0', id, method, params });
    return resultPromise;
  }

  async notify(method: string): Promise<void> {
    await this.send({ jsonrpc: '2.0', method });
  }

  async handshake(): Promise<void> {
    const init = asRecord(
      await this.request('initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'luoome-mcp-smoke', version: '0.1.0' },
      }),
    );
    check(typeof init.protocolVersion === 'string', 'initialize 返回 protocolVersion');
    await this.notify('notifications/initialized');
  }

  async kill(): Promise<void> {
    try {
      this.proc.kill();
    } catch {
      // 已退出。
    }
    await this.proc.exited.catch(() => 0);
  }
}

// ---------- 场景 ----------

const toolsListAndCall = async (client: McpStdioClient, full: boolean): Promise<void> => {
  await client.handshake();

  const listResult = asRecord(await client.request('tools/list', {}));
  const tools = listResult.tools;
  // 以运行时 registry + exposure policy 计算期望集合，避免新增 read/advice tool 后
  // smoke 因历史固定数量失效；research tool 仍由 LUOOME_EXPOSE_RESEARCH 显式开启。
  const expectedNames = selectMcpTools(toolRegistry.all(), resolveAllowedSideEffects({}))
    .filter((tool) => !tool.name.includes('research'))
    .map((tool) => tool.name);
  const actualNames = Array.isArray(tools) ? tools.map((tool) => asRecord(tool).name) : [];
  check(
    actualNames.length === expectedNames.length &&
      expectedNames.every((name) => actualNames.includes(name)),
    `tools/list 默认暴露面符合 selection policy（实际 ${actualNames.length}，预期 ${expectedNames.length}）`,
  );
  check(
    actualNames.includes('list_holdings') && actualNames.includes('analyze_stock'),
    'tools/list 含 list_holdings 与 analyze_stock',
  );

  if (!full) return;

  const accountsOut = parseToolResultText(
    await client.request('tools/call', { name: 'list_accounts', arguments: {} }),
  );
  const accounts = Array.isArray(accountsOut.accounts) ? accountsOut.accounts : [];
  check(accounts.length === 0, 'tools/call list_accounts 在独立空库返回空事实（不注入样例账户）');
  const holdingsResult = asRecord(
    await client.request('tools/call', { name: 'list_holdings', arguments: {} }),
  );
  check(
    holdingsResult.isError === true && JSON.stringify(holdingsResult.content).includes('not_found'),
    '空库 list_holdings 明确返回 Account not_found',
  );

  const analyzeResult = asRecord(
    await client.request('tools/call', {
      name: 'analyze_stock',
      arguments: { stockId: '002594.SZ' },
    }),
  );
  check(
    analyzeResult.isError === true &&
      JSON.stringify(analyzeResult.content).includes('Stock') &&
      JSON.stringify(analyzeResult.content).includes('not_found'),
    '空库 analyze_stock 明确返回 Stock not_found（不注入样例股票）',
  );
};

const main = async (): Promise<void> => {
  // 场景 1-3：默认暴露面的完整握手与调用。
  const { client, home } = McpStdioClient.spawn({});
  try {
    await toolsListAndCall(client, true);
  } finally {
    await client.kill();
  }

  // 场景 4：相同 LUOOME_HOME 二次启动（种子幂等 upsert，重复启动安全）。
  const second = McpStdioClient.spawn({}, home);
  try {
    await toolsListAndCall(second.client, false);
    check(true, '相同 LUOOME_HOME 二次启动握手 + tools/list 成功（空库初始化幂等）');
  } finally {
    await second.client.kill();
    rmSync(home, { recursive: true, force: true });
  }

  // 场景 5：LUOOME_EXPOSE_TRADE=true → 启动失败，退出码非零。
  const tradeHome = mkdtempSync(join(tmpdir(), 'luoome-mcp-trade-'));
  const tradeProc = Bun.spawn([process.execPath, indexPath], {
    cwd: repoRoot,
    env: { ...process.env, LUOOME_HOME: tradeHome, LUOOME_EXPOSE_TRADE: 'true' },
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const tradeStderr = await new Response(tradeProc.stderr).text();
  const tradeExit = await tradeProc.exited;
  check(tradeExit !== 0, `LUOOME_EXPOSE_TRADE=true 启动失败（退出码 ${tradeExit}，预期非零）`);
  check(
    tradeStderr.includes('LUOOME_EXPOSE_TRADE'),
    'trade 硬卡的 stderr 输出含 LUOOME_EXPOSE_TRADE 说明',
  );
  rmSync(tradeHome, { recursive: true, force: true });

  console.log(`\nsmoke: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    process.exit(1);
  }
};

try {
  await main();
} catch (error) {
  console.error(
    `smoke: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
}
