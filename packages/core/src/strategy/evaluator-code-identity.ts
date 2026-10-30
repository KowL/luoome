import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * evaluator code identity = 真实文件内容的 SHA-256（REQ-M3-12）。
 *
 * 参与 hash 的文件（顺序固定，路径与内容一起 hash，避免文件改名/挪位后碰撞）：
 * - evaluator.ts       规则求值、三值逻辑、评分与稳定排名
 * - expression.ts      表达式编译/求值
 * - emission.ts        信号发射（level/edge/冷却）
 * - prefilter.ts       行情预筛（会剔除股票，直接影响结果集）
 * - field-registry.ts  表达式可用字段定义
 * - ../trading-calendar.ts  交易日历（影响 emission 的冷却与交易日判断，会改变结果）
 *
 * 明确**不**参与：任何依赖包与 node_modules、以及 DTO/schema 文件。
 * 改这份清单会让所有历史 run 失去可比性，必须同时提升 `STRATEGY_EVALUATOR_VERSION`
 * 并在发布说明里标注。
 */
export const EVALUATOR_CODE_FILES = [
  'evaluator.ts',
  'expression.ts',
  'emission.ts',
  'prefilter.ts',
  'field-registry.ts',
  // 影响 emission 的冷却/交易日判断：改日历会改变结果，必须进 identity。
  '../trading-calendar.ts',
] as const;

/** identity 的计算依据：源码文件 or 构建产物；写进 run snapshot，避免把“环境不同”误报成“代码变了”。 */
export type EvaluatorCodeIdentitySource = 'src-files' | 'dist-artifact';

const sha256 = (parts: readonly (string | Buffer)[]): string => {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex');
};

const readIfPresent = (url: URL): Buffer | null => {
  try {
    return readFileSync(url);
  } catch {
    return null;
  }
};

/**
 * 计算 evaluator 源码 hash。
 *
 * `baseUrl` 是“identity 锚点”的 URL：默认是本模块自身。
 * - 源码运行（vitest / 直接从 src 加载）：锚点在 `strategy/` 目录，逐个读上表文件；
 * - 构建产物运行（dist bundle）：锚点是产物文件，上表文件不存在，退化为对**产物文件本身**
 *   取 hash——identity 的含义变成“这次运行实际加载的代码产物”，宁可保守地判定不同，
 *   也不假装是同一份源码。
 */
export const computeEvaluatorCodeHash = (baseUrl: URL = new URL(import.meta.url)): string => {
  const sources = EVALUATOR_CODE_FILES.map((file) => {
    const content = readIfPresent(new URL(`./${file}`, baseUrl));
    return content === null ? null : { file, content };
  });
  if (sources.every((entry) => entry !== null)) {
    return sha256(
      sources.flatMap((entry) => {
        if (entry === null) return [];
        return [entry.file, entry.content];
      }),
    );
  }
  const artifact = readIfPresent(baseUrl);
  if (artifact === null) throw new Error('evaluator code identity unavailable: 无法读取源码或产物');
  return sha256([artifact]);
};

/** 当前进程实际采用的 identity 依据（与 `computeEvaluatorCodeHash()` 的判定一致）。 */
export const evaluatorCodeIdentitySource = (
  baseUrl: URL = new URL(import.meta.url),
): EvaluatorCodeIdentitySource =>
  EVALUATOR_CODE_FILES.every((file) => readIfPresent(new URL(`./${file}`, baseUrl)) !== null)
    ? 'src-files'
    : 'dist-artifact';

export const EVALUATOR_CODE_IDENTITY_SOURCE: EvaluatorCodeIdentitySource =
  evaluatorCodeIdentitySource();
