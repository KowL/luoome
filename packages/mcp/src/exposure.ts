import { resolveExposure, type SideEffect } from '@luoome/core';
import { agentToolDependencies, type ToolDependency } from '@luoome/tools';

// 内部 tool（save_report / sync_watchlist_source / migration_* 等）
// 不进 toolRegistry（见 packages/tools/src/registry.ts），MCP 按 sideEffect 过滤。
// add_trade 虽以 write 声明（Web/CLI 走统一写入门），但按 AGENTS.md 硬约束
// 永不通过 MCP 暴露，因此保留最小名字 denylist。
const MCP_HIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set(['add_trade']);
export const selectMcpTools = <
  T extends {
    readonly name: string;
    readonly sideEffect: SideEffect;
    readonly requiredCapabilities?: readonly SideEffect[];
  },
>(
  tools: readonly T[],
  allowedSideEffects: ReadonlySet<SideEffect>,
): readonly T[] =>
  tools.filter(
    (tool) =>
      !MCP_HIDDEN_TOOL_NAMES.has(tool.name) &&
      (tool.requiredCapabilities ?? [tool.sideEffect]).every((capability) =>
        allowedSideEffects.has(capability),
      ),
  );

/**
 * 暴露面统一由 core 解析：LUOOME_EXPOSE_TRADE==='true' 直接抛错，
 * trade 永不通过 MCP 暴露（AGENTS.md 硬约束，非配置项）。
 */
export const resolveAllowedSideEffects = (
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<SideEffect> => resolveExposure(env).sideEffects;

export type McpDependency = ToolDependency;
export const MCP_TOOL_DEPENDENCIES: Readonly<Record<string, readonly McpDependency[]>> =
  agentToolDependencies;

export const isMcpToolReady = (
  name: string,
  readyDependencies: ReadonlySet<McpDependency>,
): boolean =>
  MCP_TOOL_DEPENDENCIES[name]?.every((dependency) => readyDependencies.has(dependency)) ?? false;
