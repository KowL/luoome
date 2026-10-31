import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * **可用性枚举的粒度守卫**（task-25 / U6 裁定：不统一，改为留痕 + 判据 + 守卫）。
 *
 * ## 为什么是「守卫」而不是「统一」
 *
 * 仓里可用性类 `z.enum` 有一百多处。把它们统一成「一个枚举」会让**没被统一的那部分**
 * 被误认为已统一——**「做一个看起来像收了口的事，比不做更坏」，因为它会让人停止检查**。
 * 所以这里不做统一，只做两件可执行的事：给粒度判定一个**唯一判据**，并把它变成红测试。
 *
 * ## 「可用性类」的判定规则（**不是**「名字里带 status」）
 *
 * 判据只看**取值集合**：
 *   一个 `z.enum([...])` 只要**全部取值都落在 {@link RESULT_LEVEL_VOCABULARY}** 里，
 *   它就是「结果级可用性枚举」，必须在其声明处 ±3 行内出现 {@link GRANULARITY_TAG} 注释。
 *
 * 之所以用「全部落在」而不是「有交集」：`['running','complete','partial','failed']`
 * 这类运行状态枚举与可用性词有交集，但它回答的是「跑没跑完」，不是「结果能不能用」。
 * 用交集判据会把几十个状态机枚举拖进来，守卫成本立刻失控，且判据本身变得可疑。
 *
 * ## 白名单
 *
 * 确实属于结果级但暂不加注释的，进 {@link GRANULARITY_EXEMPT}，**每条必须写理由**
 * （照 `REPORT_FACTUAL_FIELD_KEYS` / `assertFactualFieldReasons` 的做法）。
 */

/** 结果级可用性词表：只收「这份结果能不能用」的取值。 */
const RESULT_LEVEL_VOCABULARY: ReadonlySet<string> = new Set([
  'available',
  'unavailable',
  'partial',
  'insufficient',
]);

/** 声明处必须出现的粒度标注。 */
export const GRANULARITY_TAG = '可用性粒度:';

/**
 * 白名单：键是 `相对路径:行号`，值是**为什么这条不需要标注**。
 *
 * 空理由 = 红（豁免必须被解释）。
 */
const GRANULARITY_EXEMPT: Readonly<Record<string, string>> = {};

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const SCAN_ROOTS = ['packages/core/src/entity', 'packages/tools/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);
/**
 * 注释窗口：只说**本行与向上 3 行**，不收下方。
 *
 * 收下方会出真盲区：在一条已标注的枚举**紧上方**插入未标注的新枚举时，
 * 新枚举能「借到」下面那条的标注而漏检（本守卫的第一版就这么漏过一次）。
 * 规范因此写死：**标注必须写在自己上方或同一行**。
 */
const COMMENT_WINDOW = 3;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

interface AvailabilityEnum {
  /** 相对仓库根的路径。 */
  readonly file: string;
  readonly line: number;
  readonly values: readonly string[];
  /** 声明行 ±COMMENT_WINDOW 内的注释文本。 */
  readonly nearbyComment: string;
}

const scanAvailabilityEnums = (): AvailabilityEnum[] => {
  const found: AvailabilityEnum[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walk(resolve(REPO_ROOT, root))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const match = /z\.enum\(\[([^\]]*)\]\)/.exec(line);
        if (match === null) return;
        const values = [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((item) => item[1] ?? '');
        if (values.length === 0) return;
        // 判据：**全部**取值都落在结果级词表里（不是「有交集」）。
        if (!values.every((value) => RESULT_LEVEL_VOCABULARY.has(value))) return;
        const from = Math.max(0, index - COMMENT_WINDOW);
        const to = index + 1;
        found.push({
          file: file.slice(REPO_ROOT.length + 1),
          line: index + 1,
          values,
          nearbyComment: lines.slice(from, to).join('\n'),
        });
      });
    }
  }
  return found;
};

describe('U6 可用性枚举的粒度守卫', () => {
  it('判定规则本身：只看取值集合，不看变量名', () => {
    // 反例：与可用性词**有交集**但不是结果级（运行状态机），不该被收进来。
    const runningStates = ['running', 'complete', 'partial', 'failed'];
    expect(runningStates.every((value) => RESULT_LEVEL_VOCABULARY.has(value))).toBe(false);
    // 正例：全是结果级取值。
    expect(
      ['available', 'insufficient', 'unavailable'].every((v) => RESULT_LEVEL_VOCABULARY.has(v)),
    ).toBe(true);
    // `missing` 不是结果级词（值级存在性），不该被收进来。
    expect(RESULT_LEVEL_VOCABULARY.has('missing')).toBe(false);
    // 样本级 `sufficient` 也不是（它是正向表述，映射会丢语义）。
    expect(RESULT_LEVEL_VOCABULARY.has('sufficient')).toBe(false);
  });

  it('每个结果级可用性枚举都在声明处标注粒度（或进白名单）', () => {
    const offenders = scanAvailabilityEnums()
      .filter((item) => !item.nearbyComment.includes(GRANULARITY_TAG))
      .filter((item) => GRANULARITY_EXEMPT[`${item.file}:${item.line}`] === undefined)
      .map((item) => `${item.file}:${item.line} → z.enum([${item.values.join(', ')}])`);
    expect(offenders).toEqual([]);
  });

  it('白名单每条都写清理由，且不许通配', () => {
    for (const [key, reason] of Object.entries(GRANULARITY_EXEMPT)) {
      expect(key.trim().length).toBeGreaterThan(0);
      expect(key).not.toContain('*');
      // 空理由 = 红：豁免必须被解释。
      expect(reason.trim().length).toBeGreaterThan(0);
    }
  });

  it('守卫真的在扫（扫到 > 0 处），不是空跑通过', () => {
    expect(scanAvailabilityEnums().length).toBeGreaterThan(0);
  });
});
