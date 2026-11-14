import { z } from 'zod';
import { agentTools, catalogTools } from './catalog.js';
import type { Tool } from './define-tool.js';

/** MCP tools/list 的单个工具描述（inputSchema 为 JSON Schema draft 2020-12）。 */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** OpenAI function calling 的单个工具描述。 */
export interface OpenAIToolDescriptor {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface Registry {
  all(): readonly Tool[];
  get(name: string): Tool | undefined;
  toMCP(): McpToolDescriptor[];
  toOpenAI(): OpenAIToolDescriptor[];
  toTypeScript(): string;
}

/**
 * zod 4 → JSON Schema。取 input 侧（transform 的 pre-transform 类型）；
 * 无法表达的构造（如 z.coerce.date）降级为 {}（any），保证永不抛异常。
 */
const inputJsonSchema = (tool: Tool): Record<string, unknown> =>
  z.toJSONSchema(tool.inputSchema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;

const renderTypeScript = (tools: readonly Tool[]): string => {
  const names = tools.map((t) => `  | '${t.name}'`).join('\n');
  const metaEntries = tools
    .map(
      (t) =>
        `    '${t.name}': { description: ${JSON.stringify(t.description)}, ` +
        `sideEffect: '${t.sideEffect}', requiredCapabilities: ${JSON.stringify(t.requiredCapabilities)} },`,
    )
    .join('\n');

  return `// 由 @luoome/tools toolRegistry.toTypeScript() 生成，请勿手改。
// v0.1 共 ${tools.length} 个 tool；input 的 JSON Schema 见 toMCP()。

export type LuoomeToolName =
${names};

export type LuoomeSideEffect = 'read' | 'write' | 'external' | 'advice' | 'trade';

export interface LuoomeToolMeta {
  readonly description: string;
  readonly sideEffect: LuoomeSideEffect;
  readonly requiredCapabilities: readonly LuoomeSideEffect[];
}

export declare const luoomeToolMeta: {
${metaEntries}
};

export interface LuoomeToolCall<N extends LuoomeToolName = LuoomeToolName> {
  readonly name: N;
  readonly input: unknown;
}
`;
};

/** 创建 registry；重名直接抛错（装配期错误，不进 ToolResult 错误模型）。 */
export const createRegistry = (tools: readonly Tool[]): Registry => {
  const byName = new Map<string, Tool>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`createRegistry: duplicate tool name "${tool.name}"`);
    }
    byName.set(tool.name, tool);
  }

  return {
    all: () => tools,
    get: (name) => byName.get(name),
    toMCP: () =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: inputJsonSchema(tool),
      })),
    toOpenAI: () =>
      tools.map((tool) => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: inputJsonSchema(tool),
        },
      })),
    toTypeScript: () => renderTypeScript(tools),
  };
};

export const toolRegistry: Registry = createRegistry(agentTools);
export const applicationToolRegistry: Registry = createRegistry(Object.values(catalogTools));
