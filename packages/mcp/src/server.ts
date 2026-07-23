// @luoome/mcp —— MCP stdio server（ARCHITECTURE §9 / MVP-TASK §2.6）。
//
// 暴露策略（AGENTS.md「副作用与权限」，硬约束）：
//   - LUOOME_EXPOSE_TRADE==='true' → 启动立即抛错（trade 永不暴露，硬卡）
//   - 默认暴露 read + advice
//   - LUOOME_EXPOSE_WRITE==='true' 追加 write；LUOOME_EXPOSE_EXTERNAL==='true' 追加 external
//
// 实现说明（为何不用 SDK 的 McpServer 高级封装）：
//   @modelcontextprotocol/sdk@1.29 的 McpServer 在 tools/list 时用
//   z.toJSONSchema(schema, { io: 'input' }) 转换 zod schema，且不透传
//   unrepresentable: 'any'；toolRegistry 中 get_advice / get_advice_stats 的
//   input 含 z.coerce.date()，会抛 "Date cannot be represented in JSON Schema"
//   使整个 tools/list 失败（已用 InMemoryTransport 实验验证）。
//   因此改用 McpServer 底层依赖的同包 Server 类：tools/list 直接返回
//   toolRegistry 自身的 JSON Schema 转换结果（io:'input' + unrepresentable:'any'，
//   与 CLI/OpenAI 面共用同一转换），tools/call 统一走 tool.execute 的
//   校验与错误模型。传输层仍是 StdioServerTransport，协议行为不变。

import type { SideEffect } from '@luoome/core';
import { createRegistry, type Tool, toolRegistry } from '@luoome/tools';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { createServerContext, type ServerContextHandle } from './context.js';

/**
 * 从 env 解析暴露面。LUOOME_EXPOSE_TRADE==='true' 直接抛错：
 * trade 永不通过 MCP 暴露（AGENTS.md 硬约束，非配置项）。
 */
export const resolveAllowedSideEffects = (
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<SideEffect> => {
  if (env.LUOOME_EXPOSE_TRADE === 'true') {
    throw new Error(
      'LUOOME_EXPOSE_TRADE=true is not allowed: trade tools are never exposed over MCP ' +
        '(AGENTS.md「副作用与权限」硬约束)。',
    );
  }
  const allowed = new Set<SideEffect>(['read', 'advice']);
  if (env.LUOOME_EXPOSE_WRITE === 'true') allowed.add('write');
  if (env.LUOOME_EXPOSE_EXTERNAL === 'true') allowed.add('external');
  return allowed;
};

export interface StartMcpServerOptions {
  /** 默认 process.env；测试可注入。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 默认 createServerContext(env)；测试可注入预建 ctx（跳过 db 与种子）。 */
  readonly context?: ServerContextHandle;
  /** 默认 { name: 'luoome', version: '0.8.0' }。 */
  readonly serverInfo?: { readonly name: string; readonly version: string };
}

export interface McpServerHandle {
  readonly server: Server;
  /** 实际暴露的 tool 名（已按暴露面过滤，便于审计 / 测试断言）。 */
  readonly exposedToolNames: readonly string[];
  /** 关闭 transport 与 SQLite 句柄。 */
  readonly close: () => Promise<void>;
}

/**
 * 启动 MCP stdio server 并挂到当前进程的 stdin/stdout。
 * 暴露面校验（含 trade 硬卡）在任何 IO 之前完成。
 */
export const startMcpServer = async (
  opts: StartMcpServerOptions = {},
): Promise<McpServerHandle> => {
  const env = opts.env ?? process.env;
  const allowedSideEffects = resolveAllowedSideEffects(env);

  const { ctx, close: closeCtx } = opts.context ?? (await createServerContext(env));

  const allowedTools: readonly Tool[] = toolRegistry
    .all()
    .filter((tool) => allowedSideEffects.has(tool.sideEffect));
  // createRegistry(...).toMCP() 复用 tools 包的 JSON Schema 转换
  //（z.toJSONSchema(io:'input', unrepresentable:'any')），并顺带做重名检查。
  const descriptors = createRegistry(allowedTools).toMCP();
  const byName = new Map(allowedTools.map((tool) => [tool.name, tool]));

  const serverInfo = opts.serverInfo ?? { name: 'luoome', version: '0.8.0' };
  const server = new Server(serverInfo, { capabilities: { tools: { listChanged: false } } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: descriptors }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (tool === undefined) {
      // 未注册 / 未暴露的 tool 属协议层错误（与 SDK 对未知 tool 的处理一致）。
      throw new McpError(
        ErrorCode.InvalidParams,
        `Tool "${request.params.name}" not found or not exposed (check LUOOME_EXPOSE_* env)`,
      );
    }
    // tool.execute 永不抛异常，永远返回 ToolResult：
    // ok → text JSON(data)；err → isError:true + JSON(error)。
    const result = await tool.execute(request.params.arguments ?? {}, ctx);
    if (!result.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(result.error) }],
      };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  });

  await server.connect(new StdioServerTransport());

  ctx.logger.info('mcp server started', {
    transport: 'stdio',
    exposedTools: allowedTools.map((tool) => tool.name),
  });

  return {
    server,
    exposedToolNames: allowedTools.map((tool) => tool.name),
    close: async () => {
      await server.close();
      closeCtx();
    },
  };
};
