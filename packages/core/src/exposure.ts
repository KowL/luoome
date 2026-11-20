import type { SideEffect } from './types/side-effect.js';

/**
 * 暴露面的唯一来源：MCP、Web、CLI 都从这里读环境变量与判定 tool 是否可见，
 * 不再各自维护一份 allowlist 计算逻辑。
 */
export const EXPOSURE_ENV = {
  read: 'LUOOME_EXPOSE_READ',
  advice: 'LUOOME_EXPOSE_ADVICE',
  write: 'LUOOME_EXPOSE_WRITE',
  external: 'LUOOME_EXPOSE_EXTERNAL',
  trade: 'LUOOME_EXPOSE_TRADE',
} as const;

export type ExposureFlag = keyof typeof EXPOSURE_ENV;

export interface Exposure {
  readonly sideEffects: ReadonlySet<SideEffect>;
  readonly write: boolean;
  readonly external: boolean;
}

const readFlag = (env: NodeJS.ProcessEnv, flag: ExposureFlag): boolean =>
  env[EXPOSURE_ENV[flag]] === 'true';

/**
 * trade 永不暴露。任何 surface 读到 LUOOME_EXPOSE_TRADE=true 都应拒绝启动，
 * 而不是静默忽略。
 */
export const assertTradeNeverExposed = (env: NodeJS.ProcessEnv = process.env): void => {
  if (readFlag(env, 'trade')) {
    throw new Error(
      'LUOOME_EXPOSE_TRADE=true is not allowed: trade 永不暴露给 MCP/Web/CLI 调用方（AGENTS.md「安全与副作用」硬约束）。',
    );
  }
};

export const resolveExposure = (
  env: NodeJS.ProcessEnv = process.env,
  overrides: { readonly write?: boolean | undefined; readonly external?: boolean | undefined } = {},
): Exposure => {
  assertTradeNeverExposed(env);
  const write = overrides.write ?? readFlag(env, 'write');
  const external = overrides.external ?? readFlag(env, 'external');
  const sideEffects = new Set<SideEffect>();
  if (env[EXPOSURE_ENV.read] !== 'false') sideEffects.add('read');
  if (env[EXPOSURE_ENV.advice] !== 'false') sideEffects.add('advice');
  if (write) sideEffects.add('write');
  if (external) sideEffects.add('external');
  return { sideEffects, write, external };
};

/** tool 的每一项能力（未声明时取 sideEffect）都必须在暴露面内。 */
export const isToolExposed = (
  tool: {
    readonly sideEffect: SideEffect;
    readonly requiredCapabilities?: readonly SideEffect[];
  },
  exposure: Exposure,
): boolean =>
  (tool.requiredCapabilities ?? [tool.sideEffect]).every((capability) =>
    exposure.sideEffects.has(capability),
  );
