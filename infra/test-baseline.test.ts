// T17 / REQ-M2-07：被删测试文件的**残留守卫**。
//
// 断言的不是"测试总数下降了多少"（那个指标会诱导少写新测试），而是两个可验证事实：
//   1. M2 期间删掉的 17 个测试文件，路径确实不存在；
//   2. 它们也不在任何 `test:all` 段的收集结果里——所以一旦有人重建同名文件，立刻红。
//
// 第 2 条用真实收集结果（`vitest list --filesOnly`）判定，不靠 glob 字符串模拟：
// 收集口径变化时这条守卫跟着变，不会自己漂移。
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('..', import.meta.url));

/**
 * M2 期间删除的测试文件**事实清单**（不是统计量）：
 * cli 6 / tui 1 / dsh-bridge 3 / mcp 3 / deploy 4 = 17。
 */
const DELETED_TEST_FILES = [
  // packages/cli（T15）
  'packages/cli/src/daemon.test.ts',
  'packages/cli/src/env.test.ts',
  'packages/cli/src/holidays.test.ts',
  'packages/cli/src/index.test.ts',
  'packages/cli/src/restart.test.ts',
  'packages/cli/src/watch.test.ts',
  // packages/tui（T15）
  'packages/tui/src/views/limit-up-ladder.test.ts',
  // packages/dsh-bridge（990ce43）
  'packages/dsh-bridge/src/protocol.test.ts',
  'packages/dsh-bridge/src/standalone-panels.test.ts',
  'packages/dsh-bridge/src/standalone-profile.test.ts',
  // packages/mcp（990ce43）
  'packages/mcp/src/analysis-surface.e2e.test.ts',
  'packages/mcp/src/batch-tools.test.ts',
  'packages/mcp/src/server.test.ts',
  // deploy/dsh 的旧工具（990ce43）
  'deploy/dsh/batch-tools.test.ts',
  'deploy/dsh/queue-probe.test.ts',
  'deploy/dsh/settings-tools.test.ts',
  'deploy/dsh/skills.test.ts',
] as const;

/** 真实收集结果：vitest 段的文件清单（`test:all` 里唯一会扫到这些路径的段）。 */
const collectedByVitest = (): string[] => {
  const child = spawnSync('bun', ['run', '--silent', 'vitest', 'list', '--filesOnly'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  });
  if (child.status !== 0)
    throw new Error(`vitest list 失败（exit=${String(child.status)}）：${child.stderr ?? ''}`);
  return (child.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.test.ts') || line.endsWith('.test.js'));
};

describe('T17 被删测试文件零残留', () => {
  it('17 个路径逐个不存在', () => {
    for (const path of DELETED_TEST_FILES)
      expect(existsSync(join(repo, path)), `${path} 必须保持删除`).toBe(false);
  });

  it('17 个路径逐个不在 test:all 的收集结果里', () => {
    const collected = new Set(collectedByVitest());
    // 收集本身必须非空，否则这条断言会空转。
    expect(collected.size).toBeGreaterThan(0);
    for (const path of DELETED_TEST_FILES)
      expect(collected.has(path), `${path} 不应被任何 test:all 段收集`).toBe(false);
  }, 120_000);
});
