import type { SideEffect } from '@luoome/core';

// 内部 tool（record_watch_run / save_report / sync_watchlist_source / migration_* 等）
// 不进 toolRegistry（见 packages/tools/src/registry.ts），MCP 只需按 sideEffect 过滤，
// 不再有按名字的排除清单。
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
  tools.filter((tool) =>
    (tool.requiredCapabilities ?? [tool.sideEffect]).every((capability) =>
      allowedSideEffects.has(capability),
    ),
  );

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
