// T17 / REQ-M2-07：测试基线产物。
//
// 目的：把「测试数量」从人写常量变成**跑出来的事实**。任何人改了测试，跑
// `bun run test:baseline` 重新生成 infra/test-baseline.json，而不是手改数字。
//
// 口径：
//   - 逐段跑 `package.json` 的 test:all 组成脚本（不复制命令，直接调脚本名）；
//   - 文件数/用例数从 runner 自己的汇总行解析，**脚本里没有任何测试数量常量**；
//   - 覆盖率只覆盖 vitest 段（`bun test` 的两段不产出覆盖率），如实标注 scope；
//   - 任一段失败 → 不写基线文件，退出码非 0（避免把红跑成基线）。
//
// 运行：bun run test:baseline
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const output = join(repo, 'infra/test-baseline.json');

/** test:all 的组成段（与 package.json 的 test:all 定义一一对应）。 */
const SEGMENTS = ['test', 'test:db', 'test:db:node', 'test:web', 'test:dsh-luoome:e2e'] as const;

interface SegmentResult {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly files: number | null;
  readonly tests: number | null;
  readonly skipped: number | null;
}

const runSegment = (name: string): { result: SegmentResult; output: string } => {
  const started = Date.now();
  const child = spawnSync('bun', ['run', name], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const text = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  return {
    result: {
      name,
      command: `bun run ${name}`,
      exitCode: child.status ?? -1,
      durationMs,
      ...parseCounts(text),
    },
    output: text,
  };
};

/** 只解析 runner 自己的汇总行：vitest 与 bun test 两种格式。 */
const parseCounts = (
  text: string,
): { files: number | null; tests: number | null; skipped: number | null } => {
  // vitest: "Test Files  314 passed (314)" / "Tests  3286 passed (3286)"
  const vitestFiles =
    /Test Files\s+(?:(\d+)\s+passed)?(?:\s*\|\s*(\d+)\s+skipped)?\s+\((\d+)\)/.exec(text);
  const vitestTests =
    /^\s*Tests\s+(?:(\d+)\s+passed)?(?:\s*\|\s*(\d+)\s+skipped)?\s+\((\d+)\)/m.exec(text);
  // bun test: "Ran 665 tests across 15 files."
  const bun = /Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?/.exec(text);
  if (vitestTests !== null) {
    return {
      files: vitestFiles === null ? null : Number(vitestFiles[3]),
      tests: Number(vitestTests[3]),
      skipped: Number(vitestTests[2] ?? 0),
    };
  }
  if (bun !== null) return { files: Number(bun[2]), tests: Number(bun[1]), skipped: null };
  return { files: null, tests: null, skipped: null };
};

/** 覆盖率（只覆盖 vitest 段）。解析 "All files | 85.19 | 73.84 | 88.64 | 87.69 |"。 */
const runCoverage = (): {
  scope: string;
  statements: number;
  branches: number;
  functions: number;
  lines: number;
} | null => {
  const child = spawnSync(
    'bun',
    [
      'run',
      '--silent',
      'vitest',
      'run',
      '--coverage',
      '--reporter=dot',
      '--coverage.reporter=text-summary',
    ],
    {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const text = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  const row =
    /Statements\s*:\s*([\d.]+)%[\s\S]*?Branches\s*:\s*([\d.]+)%[\s\S]*?Functions\s*:\s*([\d.]+)%[\s\S]*?Lines\s*:\s*([\d.]+)%/.exec(
      text,
    );
  if (child.status !== 0 || row === null) {
    process.stderr.write(
      `[test-baseline] 覆盖率段未产出可用数字（exit=${String(child.status)}）\n`,
    );
    return null;
  }
  return {
    scope: 'vitest 段（bun test 段不产出覆盖率）',
    statements: Number(row[1]),
    branches: Number(row[2]),
    functions: Number(row[3]),
    lines: Number(row[4]),
  };
};

/** lint 的 error/warning 数：error 必须为 0，warning 不 fail 但要有基线（防静默增长）。 */
const runLint = (): { errors: number; warnings: number; exitCode: number } => {
  const child = spawnSync('npx', ['biome', 'check', '.', '--reporter=json'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = (() => {
    try {
      return JSON.parse(child.stdout ?? '') as {
        diagnostics?: { severity?: string }[];
      };
    } catch {
      return { diagnostics: [] };
    }
  })();
  const diagnostics = parsed.diagnostics ?? [];
  return {
    errors: diagnostics.filter((item) => item.severity === 'error').length,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    exitCode: child.status ?? -1,
  };
};

const segments: SegmentResult[] = [];
const failures: string[] = [];
for (const name of SEGMENTS) {
  process.stderr.write(`[test-baseline] 运行 ${name} …\n`);
  const { result, output } = runSegment(name);
  segments.push(result);
  process.stderr.write(
    `[test-baseline]   exit=${String(result.exitCode)} files=${String(result.files)} tests=${String(result.tests)}\n`,
  );
  if (result.exitCode !== 0) {
    failures.push(`${name}: exit ${String(result.exitCode)}\n${output.slice(-4000)}`);
    break;
  }
}
if (failures.length > 0) {
  process.stderr.write(`[test-baseline] 有测试段失败，不写基线：\n${failures.join('\n')}\n`);
  process.exit(1);
}

process.stderr.write('[test-baseline] 运行 lint …\n');
const lint = runLint();
process.stderr.write(
  `[test-baseline]   exit=${String(lint.exitCode)} errors=${String(lint.errors)} warnings=${String(lint.warnings)}\n`,
);
if (lint.exitCode !== 0) {
  process.stderr.write('[test-baseline] lint 未通过，不写基线\n');
  process.exit(1);
}

const coverage = runCoverage();
const totals = segments.reduce(
  (acc, segment) => ({
    files: acc.files + (segment.files ?? 0),
    tests: acc.tests + (segment.tests ?? 0),
  }),
  { files: 0, tests: 0 },
);

const baseline = {
  generatedAt: new Date().toISOString(),
  runner: { node: process.version, bun: process.env.BUN_VERSION ?? null },
  note: '由 `bun run test:baseline` 生成；不要手改。改了测试就重跑。',
  segments,
  totals,
  lint: { errors: lint.errors, warnings: lint.warnings },
  coverage,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(baseline, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, output, totals, coverage }, null, 2)}\n`);
