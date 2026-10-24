import type { SideEffect } from '@luoome/core';
import { privateResearchTools, selectExposedTools } from '@luoome/tools';

export const selectMcpTools = selectExposedTools;

export interface McpToolNames {
  readonly allowlist?: ReadonlySet<string> | undefined;
  readonly denylist?: ReadonlySet<string>;
}

const parseNames = (value: string): ReadonlySet<string> =>
  new Set(
    value
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  );

export const resolveMcpToolNames = (env: NodeJS.ProcessEnv = process.env): McpToolNames => ({
  // An explicitly empty allowlist fails closed; only an absent variable means all names.
  allowlist:
    env.LUOOME_EXPOSE_TOOLS === undefined ? undefined : parseNames(env.LUOOME_EXPOSE_TOOLS),
  denylist: new Set([
    ...(env.LUOOME_EXPOSE_RESEARCH === 'true' ? [] : privateResearchTools),
    ...parseNames(env.LUOOME_EXPOSE_DENY ?? ''),
  ]),
});

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
  const allowed = new Set<SideEffect>(['read']);
  if (env.LUOOME_EXPOSE_WRITE === 'true') allowed.add('write');
  if (env.LUOOME_EXPOSE_EXTERNAL === 'true') allowed.add('external');
  if (env.LUOOME_EXPOSE_QUEUE === 'true') allowed.add('queue');
  return allowed;
};
