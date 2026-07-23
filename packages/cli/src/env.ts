// 项目 .env 加载（CLI 入口在 main() 首行调用一次）。
//
// 背景：LLM / 行情 provider 配置走环境变量（见 entity/llm-provider.ts）。
// 为支持「配置写文件而非 export」，启动时按序读取以下 .env 并注入 process.env：
//   1. $LUOOME_HOME/.env（用户级，默认 ~/.luoome/.env）
//   2. <项目根>/.env（仓库级，优先于 1）
// applyEnvEntries 只填未设置的 key → 优先级：真实 env > 项目根 .env > LUOOME_HOME/.env。
// 文件不存在 / 不可读一律静默跳过（对齐 holidays.json 的容错口径；hot path 不因此 crash）。
//
// 注意：apps/web/src/env.ts 有一份同构实现（web 直跑时不经过 CLI），两边需同步修改。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyEnvEntries, parseEnvFile } from '@luoome/core';

import { luoomeHome } from './paths.js';

/** 项目根：packages/cli/src/env.ts → 上四级。 */
const PROJECT_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 默认加载顺序：先用户级后项目级（项目级优先，因为只填未设置 key）。 */
export const defaultEnvFiles = (): readonly string[] => [
  join(luoomeHome(), '.env'),
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
