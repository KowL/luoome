import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_FETCH_MANIFEST_ENTRY } from '@luoome/dsh-bridge/protocol';
import { z } from 'zod';
import type { DshChatRuntimeOptions } from './chat-runtime.js';
import type { ModelBudgetPolicy } from './model-budget.js';
import type { DshRolloutPolicy } from './rollout.js';
import type { DshSessionRetentionPolicy } from './session-store.js';

export interface DshDevelopmentConfig {
  readonly development: true;
  readonly nodePath: string;
  readonly hostEntry: string;
  readonly cwd: string;
  readonly native?: NonNullable<DshChatRuntimeOptions['native']>;
}

export const loadDshDevelopmentConfig = (
  env: Readonly<Record<string, string | undefined>>,
  environment: 'development' | 'production',
): DshDevelopmentConfig | undefined => {
  const runtime = z.enum(['ai-sdk', 'dsh']).parse(env.LUOOME_CHAT_RUNTIME ?? 'ai-sdk');
  if (runtime === 'ai-sdk') return undefined;
  if (environment !== 'development' || env.LUOOME_DSH_DEVELOPMENT !== 'true')
    throw new Error('DSH Chat requires development environment and LUOOME_DSH_DEVELOPMENT=true');
  const nodePath = env.LUOOME_DSH_NODE_PATH;
  if (nodePath === undefined || !isAbsolute(nodePath))
    throw new Error('DSH requires explicit absolute LUOOME_DSH_NODE_PATH');
  const hostEntry =
    env.LUOOME_DSH_HOST_ENTRY ??
    fileURLToPath(new URL('../../../agent-runtime/dist/index.js', import.meta.url));
  if (!isAbsolute(hostEntry)) throw new Error('DSH Host entry must be absolute');
  const fixtureFile = env.LUOOME_DSH_WEB_FIXTURES_FILE;
  const allowNative = env.LUOOME_DSH_ALLOW_WEB_FIXTURES === 'true';
  if ((fixtureFile !== undefined) !== allowNative)
    throw new Error('DSH webpage fixtures require separate authorization and an explicit file');
  let native: DshChatRuntimeOptions['native'];
  if (fixtureFile !== undefined) {
    if (!isAbsolute(fixtureFile)) throw new Error('DSH webpage fixture path must be absolute');
    const stat = statSync(fixtureFile);
    if (!stat.isFile() || stat.size > 65_536) throw new Error('Invalid DSH webpage fixture file');
    const fixtures = z
      .record(z.url(), z.string().max(100_000))
      .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 16)
      .parse(JSON.parse(readFileSync(fixtureFile, 'utf8')));
    native = { authorized: true, entry: WEB_FETCH_MANIFEST_ENTRY, fixtures };
  }
  return {
    development: true,
    nodePath,
    hostEntry,
    cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
    ...(native === undefined ? {} : { native }),
  };
};

const integerEnv = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`DSH numeric setting must be an integer in [${min}, ${max}]`);
  return parsed;
};

/**
 * 会话目录保留策略。默认 `off`：不配置就完全不触碰已有会话目录。
 * `dry-run` 只记录将要清理的目录，`enforce` 才真正删除。
 */
export const loadDshSessionRetentionPolicy = (
  env: Readonly<Record<string, string | undefined>>,
): DshSessionRetentionPolicy => ({
  mode: z.enum(['off', 'dry-run', 'enforce']).parse(env.LUOOME_DSH_SESSION_GC ?? 'off'),
  retentionDays: integerEnv(env.LUOOME_DSH_SESSION_RETENTION_DAYS, 30, 1, 3650),
});

/**
 * 模型预算账本。不配置总 token 上限时保持现状（不计量）；一旦配置，所有 DSH
 * 供应商 attempt 都按同一账户账本准入与结算。
 */
export const loadDshModelBudgetPolicy = (
  env: Readonly<Record<string, string | undefined>>,
): ModelBudgetPolicy | undefined => {
  const tokens = env.LUOOME_DSH_MODEL_BUDGET_TOKENS;
  if (tokens === undefined || tokens.trim() === '') return undefined;
  return {
    maxTokens: integerEnv(tokens, 0, 1, 1_000_000_000),
    maxRequests: integerEnv(env.LUOOME_DSH_MODEL_BUDGET_REQUESTS, 200, 1, 100_000),
    windowMs: integerEnv(env.LUOOME_DSH_MODEL_BUDGET_WINDOW_HOURS, 24, 1, 24 * 365) * 3_600_000,
  };
};

/**
 * 灰度门控。DSH 运行时本身仍由 `LUOOME_CHAT_RUNTIME` 显式启用；启用后默认对本机账户
 * 全量放行（保持既有开发入口），`LUOOME_DSH_ROLLOUT=off` 或百分比/allowlist 用于收窄与回退。
 */
export const loadDshRolloutPolicy = (
  env: Readonly<Record<string, string | undefined>>,
): DshRolloutPolicy => {
  const enabled = env.LUOOME_DSH_ROLLOUT !== 'off';
  const percent = integerEnv(env.LUOOME_DSH_ROLLOUT_PERCENT, 100, 0, 100);
  const allowlist = (env.LUOOME_DSH_ROLLOUT_ACCOUNTS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return { enabled, percent, accountAllowlist: allowlist };
};
