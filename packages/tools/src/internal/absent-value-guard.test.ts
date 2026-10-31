import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * U4（task-25）：**缺席 > null > 0** 的工具层静态守卫。
 *
 * `client` 侧已有同款守卫（`client/projection.test.js`）；工具层此前没有，
 * 于是「缺价被兜底成 0%」这类错误只在 review 时靠人眼发现。
 *
 * 规则：禁止对**可缺席的金额/比例字段**写 `?? 0` / `|| 0` 兜底——
 * 缺席表示「这个值不存在」，`0` 表示「真值就是 0」，两者混淆会把缺失伪装成结论。
 */

/**
 * 需要 0 默认值的字段：**逐条列出并写理由**，不许通配。
 *
 * 当前为空——工具层已经没有对可缺席字段的 0 兜底（S3 把 `holding-pnl` 的兜底全删了）。
 * 保持这张表存在，是为了下一次「确实需要 0」时有地方写理由，而不是顺手写 `?? 0`。
 */
const ZERO_DEFAULT_ALLOWED: Readonly<Record<string, string>> = {};

/** 可缺席字段名的判据：金额 / 比例 / 价格 / 市值 / 盈亏。 */
const ABSENTABLE_FIELD =
  /(pnlPct|PnLPct|todayPnl|todayPnlPct|currentPrice|marketValue|totalValue|totalPnL|totalPnLPct|price|amount|value)\b/;

const TOOLS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : walk(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });

describe('U4 工具层 `?? 0` / `|| 0` 守卫', () => {
  it('可缺席的金额/比例字段不得用 0 兜底（白名单逐条带理由）', () => {
    for (const reason of Object.values(ZERO_DEFAULT_ALLOWED))
      expect(reason.trim().length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of walk(TOOLS_ROOT)) {
      const text = readFileSync(file, 'utf8');
      for (const [index, line] of text.split('\n').entries()) {
        const match = /([A-Za-z_][A-Za-z0-9_.]*)\s*(\?\?|\|\|)\s*0\b/.exec(line);
        if (match === null) continue;
        if (!ABSENTABLE_FIELD.test(match[1] as string)) continue;
        const fileName = file.slice(file.lastIndexOf('/') + 1);
        if (Object.hasOwn(ZERO_DEFAULT_ALLOWED, `${fileName}:${match[1]}`)) continue;
        offenders.push(`${fileName}:${String(index + 1)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('守卫本身有牙：把一条 0 兜底放进工具源码必须被抓到', () => {
    // 直接测判据（同一个 ABSENTABLE_FIELD + 白名单逻辑），不依赖当前源码里恰好有没有违规。
    const synthetic = 'const pnlPct = item.pnlPct ?? 0;';
    const match = /([A-Za-z_][A-Za-z0-9_.]*)\s*(\?\?|\|\|)\s*0\b/.exec(synthetic);
    expect(match).not.toBeNull();
    expect(ABSENTABLE_FIELD.test((match as RegExpExecArray)[1] as string)).toBe(true);
    // 非金额/比例字段不受该守卫约束（如计数、状态），避免誤伤。
    const counter = 'const count = summary.count ?? 0;';
    const counterMatch = /([A-Za-z_][A-Za-z0-9_.]*)\s*(\?\?|\|\|)\s*0\b/.exec(counter);
    expect(ABSENTABLE_FIELD.test((counterMatch as RegExpExecArray)[1] as string)).toBe(false);
  });
});
