import type { SideEffect } from '@luoome/core';

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
