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
 *
 * 明确**不**参与：`trading-calendar.ts`（共享交易日历数据，不是 evaluator 实现）、
 * 任何依赖包与 node_modules、以及 DTO/schema 文件。改这份清单会让所有历史 run 失去可比性，
 * 必须同时提升 `STRATEGY_EVALUATOR_VERSION` 并在发布说明里标注。
 */
export const EVALUATOR_CODE_FILES = [
  'evaluator.ts',
  'expression.ts',
  'emission.ts',
  'prefilter.ts',
  'field-registry.ts',
] as const;

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
