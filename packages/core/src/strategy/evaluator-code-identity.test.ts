import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  STRATEGY_EVALUATOR_CODE_HASH,
  STRATEGY_EVALUATOR_VERSION,
} from '../entity/strategy-backtest.js';
import { computeEvaluatorCodeHash, EVALUATOR_CODE_FILES } from './evaluator-code-identity.js';
import { compareStrategyRunEvaluator, strategyRunUsesEvaluator } from './run-snapshot.js';

const sourceDir = new URL('./', import.meta.url);

const copyEvaluatorSources = (): { dir: string; anchor: URL } => {
  const dir = mkdtempSync(join(tmpdir(), 'luoome-evaluator-identity-'));
  mkdirSync(join(dir, 'strategy'), { recursive: true });
  for (const file of EVALUATOR_CODE_FILES) {
    copyFileSync(new URL(file, sourceDir), resolve(dir, 'strategy', file));
  }
  return { dir, anchor: new URL('./evaluator-code-identity.ts', `file://${dir}/strategy/`) };
};

const snapshotWithIdentity = (
  identity: string,
  source: 'src-files' | 'dist-artifact' = 'src-files',
) => ({
  schemaVersion: 3,
  strategyVersionId: 't25-strategy-v1',
  definitionHash: 'a'.repeat(64),
  evaluatorVersion: STRATEGY_EVALUATOR_VERSION,
  evaluatorCodeIdentity: identity,
  codeIdentitySource: source,
  scope: 'evaluation',
  universeKind: 'full',
  coverage: 'CN_A_SHARES_SH_SZ',
  stockIds: ['600519.SH'],
  stockIdChecksum: 'b'.repeat(64),
  requestedBy: 'replay',
  acceptancePolicyVersion: 'strategy-run-acceptance-v1',
});

describe('T25 evaluator code identity = 真实文件 SHA-256', () => {
  it('同一份文件两次计算相同，且等于运行时 identity', () => {
    const first = computeEvaluatorCodeHash();
    const second = computeEvaluatorCodeHash();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect(STRATEGY_EVALUATOR_CODE_HASH).toBe(first);
  });

  it('跨进程（重新启动 Node）得到相同 SHA-256', () => {
    const moduleUrl = new URL('./evaluator-code-identity.ts', sourceDir).href;
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(moduleUrl)}).then((m) => process.stdout.write(m.computeEvaluatorCodeHash()))`,
      ],
      { encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(STRATEGY_EVALUATOR_CODE_HASH);
  });

  it('改 evaluator 源文件（加一行注释）后 identity 变化，已存 run 判定为不同代码', () => {
    const { dir, anchor } = copyEvaluatorSources();
    try {
      const original = computeEvaluatorCodeHash(anchor);
      const snapshot = snapshotWithIdentity(original);
      expect(
        strategyRunUsesEvaluator(snapshot, {
          version: STRATEGY_EVALUATOR_VERSION,
          codeIdentity: original,
          codeIdentitySource: 'src-files',
        }),
      ).toBe(true);

      appendFileSync(
        join(dir, 'strategy', 'evaluator.ts'),
        '\n// T25 mutation: 改一行注释也应改变 identity\n',
      );
      const modified = computeEvaluatorCodeHash(anchor);
      expect(modified).not.toBe(original);
      expect(
        strategyRunUsesEvaluator(snapshot, {
          version: STRATEGY_EVALUATOR_VERSION,
          codeIdentity: modified,
          codeIdentitySource: 'src-files',
        }),
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('身份来源不同（src-files vs dist-artifact）给出 basis 原因，不笼统说“代码变了”', () => {
    const snapshot = snapshotWithIdentity('a'.repeat(64), 'dist-artifact');
    expect(
      compareStrategyRunEvaluator(snapshot, {
        version: STRATEGY_EVALUATOR_VERSION,
        codeIdentity: 'a'.repeat(64),
        codeIdentitySource: 'src-files',
      }),
    ).toBe('identity-basis-mismatch');
  });

  it('旧 run 没有 codeIdentitySource 时标记 legacy，而不是“代码不一致”', () => {
    const snapshot = {
      ...snapshotWithIdentity('b'.repeat(64), 'src-files'),
      codeIdentitySource: undefined,
    };
    expect(
      compareStrategyRunEvaluator(snapshot, {
        version: STRATEGY_EVALUATOR_VERSION,
        codeIdentity: 'b'.repeat(64),
        codeIdentitySource: 'src-files',
      }),
    ).toBe('legacy-identity');
  });

  it('只改不参与 hash 的文件不影响 identity（范围固定）', () => {
    const { dir, anchor } = copyEvaluatorSources();
    try {
      const original = computeEvaluatorCodeHash(anchor);
      appendFileSync(join(dir, 'strategy', 'unrelated.ts'), 'export const unrelated = 1;\n');
      expect(computeEvaluatorCodeHash(anchor)).toBe(original);
      expect(EVALUATOR_CODE_FILES).toContain('../trading-calendar.ts');
      // 影响结果的交易日历必须在范围内：改它会改变 identity。
      appendFileSync(join(dir, 'trading-calendar.ts'), '\n// T25 mutation: calendar\n');
      expect(computeEvaluatorCodeHash(anchor)).not.toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('构建产物模式（没有源码文件）退化为对产物文件本身取 hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-evaluator-artifact-'));
    try {
      const artifact = join(dir, 'host.js');
      appendFileSync(artifact, '// bundled evaluator\n');
      const artifactHash = computeEvaluatorCodeHash(new URL(`file://${artifact}`));
      expect(artifactHash).toMatch(/^[a-f0-9]{64}$/);
      expect(artifactHash).not.toBe(STRATEGY_EVALUATOR_CODE_HASH);
      appendFileSync(artifact, '// rebuild\n');
      expect(computeEvaluatorCodeHash(new URL(`file://${artifact}`))).not.toBe(artifactHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
