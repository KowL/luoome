// 项目 .env 加载（web 直跑入口在 import.meta.main 分支调用一次）。
// 与 packages/cli/src/env.ts 同构（web 经 `luoome web serve` 启动时 CLI 已加载，
// 本文件覆盖 `bun apps/web/src/index.ts` 直跑场景）；两边需同步修改。
//
// 加载顺序：$LUOOME_HOME/.env → <项目根>/.env（项目级优先，只填未设置 key）。
// 优先级：真实 env > 项目根 .env > LUOOME_HOME/.env。文件缺失/不可读静默跳过。

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyEnvEntries, parseEnvFile } from '@luoome/core';

/** 项目根：apps/web/src/env.ts → 上四级。 */
const PROJECT_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export const defaultEnvFiles = (): readonly string[] => [
  join(process.env.LUOOME_HOME ?? join(homedir(), '.luoome'), '.env'),
  join(PROJECT_ROOT, '.env'),
];

/** 读取给定 .env 文件并注入 target（缺省 process.env）；返回实际写入的 key。 */
export const loadProjectEnv = (
  files: readonly string[] = defaultEnvFiles(),
  target: Record<string, string | undefined> = process.env,
): readonly string[] => {
  const applied: string[] = [];
  for (const file of files) {
    try {
      if (!existsSync(file)) continue;
      applied.push(...applyEnvEntries(parseEnvFile(readFileSync(file, 'utf8')), target));
    } catch {
      // 静默跳过：配置容错不阻断启动
    }
  }
  return applied;
};
