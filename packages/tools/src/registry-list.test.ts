// T14 / REQ-M2-04 第 3 项：`tools:list` 的验收断言。
//
// 直接跑真实脚本（Node 24 + tsx），不做替身：这个脚本的价值就是「同一份运行时口径」，
// 用替身断言等于什么都没证明。未归类 > 0 时脚本自身也会以非 0 退出。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../..', import.meta.url));

const runToolsList = () => {
  const result = spawnSync(
    'npm',
    [
      'exec',
      '--yes',
      '--offline',
      '--package=tsx@4',
      '--package=node@24',
      '--',
      'tsx',
      'packages/tools/src/registry-list.ts',
      '--json',
    ],
    { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  );
  if (result.status !== 0) throw new Error(`tools:list failed: ${result.stderr || result.stdout}`);
  return JSON.parse(result.stdout) as {
    totals: { registry: number; exposed: number; unclassified: number };
    checks: Record<string, unknown>;
  };
};

describe('T14 tools:list', () => {
  it('输出非空且未归类 = 0', () => {
    const report = runToolsList();
    expect(report.totals.registry).toBeGreaterThan(0);
    expect(report.totals.exposed).toBeGreaterThan(0);
    expect(report.totals.unclassified).toBe(0);
    expect(report.checks.unclassified).toBe(0);
    expect(report.checks.classUnionEqualsRegistry).toBe(true);
    expect(report.checks.classCountSumEqualsRegistry).toBe(true);
    expect(report.checks.everyToolTagged).toBe(true);
    expect(report.checks.danglingExceptions).toEqual([]);
  }, 120_000);
});
