// @luoome/mcp —— 测试用最小 MCP stdio 客户端（真实子进程 + NDJSON JSON-RPC）。
//
// 只服务 e2e 验收：spawn `bun --no-env-file packages/cli/src/index.ts mcp serve`，
// 走 initialize / tools/list / tools/call，覆盖「协议层拒绝」与「协议层成功」两种结果。
// 帧解析与 packages/mcp/src/smoke.ts 同构；抽到 testing/ 是因为分析面验收要同时拉起
// read / analysis / settings / batch 多个实例，并复用同一套错误断言。
//
// 文件名不匹配 *.test.ts，不会被 vitest 或 bun test 主动拾取。

import { fileURLToPath } from 'node:url';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

/** 仓库根目录（本文件位于 packages/mcp/src/testing/）。 */
export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const CLI_ENTRY = 'packages/cli/src/index.ts';
const REQUEST_TIMEOUT_MS = 10_000;

type ServerProc = Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

interface PendingEntry {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
  }
  return value as Record<string, unknown>;
};

export interface McpToolCall {
  /** MCP 协议层 isError 标记（ToolResult 失败时为 true）。 */
  readonly isError: boolean;
  /** content[0].text 解析后的 JSON（成功 data 或 ToolError 对象）。 */
  readonly data: unknown;
}

export class McpStdioClient {
  private nextId = 1;
  private buffer = '';
  private stderrBuf = '';
  private readonly pending = new Map<number, PendingEntry>();

  private constructor(private readonly proc: ServerProc) {
    void this.pumpStdout();
    void this.pumpStderr();
  }

  /** spawn 一个 MCP stdio server 子进程；env 由调用方完全决定（已隔离）。 */
  static spawn(env: Record<string, string>): McpStdioClient {
    const proc = Bun.spawn([process.execPath, '--no-env-file', CLI_ENTRY, 'mcp', 'serve'], {
      cwd: REPO_ROOT,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return new McpStdioClient(proc);
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
        continue; // 非协议行忽略（server 日志全部走 stderr）。
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

  private async notify(method: string): Promise<void> {
    await this.send({ jsonrpc: '2.0', method });
  }

  /** initialize + notifications/initialized；返回 initialize result（含 serverInfo）。 */
  async initialize(): Promise<Record<string, unknown>> {
    const result = asRecord(
      await this.request('initialize', {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'luoome-analysis-surface-e2e', version: '0.1.0' },
      }),
    );
    await this.notify('notifications/initialized');
    return result;
  }

  /** tools/list 后的工具名列表。 */
  async listTools(): Promise<string[]> {
    const result = asRecord(await this.request('tools/list', {}));
    const tools = result.tools;
    if (!Array.isArray(tools)) throw new Error('tools/list result missing tools');
    return tools.map((tool) => {
      const name = asRecord(tool).name;
      if (typeof name !== 'string') throw new Error('tool entry missing name');
      return name;
    });
  }

  /** tools/call，保留 isError 标记，交由调用方判断是 ToolResult 失败还是成功。 */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCall> {
    const result = asRecord(await this.request('tools/call', { name, arguments: args }));
    const content = result.content;
    if (!Array.isArray(content) || content.length === 0) {
      throw new Error(`tools/call "${name}" result missing content`);
    }
    const first = asRecord(content[0]);
    if (typeof first.text !== 'string') {
      throw new Error(`tools/call "${name}" content[0].text is not a string`);
    }
    return { isError: result.isError === true, data: JSON.parse(first.text) as unknown };
  }

  /** tools/call 成功并返回解析后的 data；ToolResult 失败时抛错。 */
  async callToolOk(name: string, args: Record<string, unknown>): Promise<unknown> {
    const call = await this.callTool(name, args);
    if (call.isError) {
      throw new Error(`tools/call "${name}" returned isError: ${JSON.stringify(call.data)}`);
    }
    return call.data;
  }

  /**
   * 断言调用在协议层被拒绝（未暴露 / 未注册的 tool），返回 JSON-RPC error 文本。
   * 若调用成功或返回 ToolResult isError（协议层通过），直接抛错。
   */
  async callToolRejected(name: string, args: Record<string, unknown>): Promise<string> {
    let call: McpToolCall;
    try {
      call = await this.callTool(name, args);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error(
      `expected JSON-RPC error for "${name}" but call was not rejected (isError=${call.isError}): ${JSON.stringify(call.data)}`,
    );
  }

  async close(): Promise<void> {
    try {
      this.proc.kill();
    } catch {
      // 已退出。
    }
    await this.proc.exited.catch(() => 0);
  }
}
