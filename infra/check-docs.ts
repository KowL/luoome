import { readFile } from 'node:fs/promises';

import { toolRegistry } from '../packages/tools/src/registry.js';

/**
 * 文档事实守卫（REQ-M4-07）。
 *
 * ## 只检查「**会腐烂**的东西」
 *
 * 文档里绝大多数内容不会因为时间而变错——架构分层、约定、为什么这么设计，都是稳定的。
 * 真正会腐烂的只有两类：
 *
 * 1. **运行时数字**（工具数、文件数、清单长度）：代码一动就不同
 * 2. **`asOf` 时点**：它标的是「这些数字是哪天测的」
 *
 * 把所有文档规则都塞进来会让这个脚本变成第二个 lint（噪音源），
 * 而噪音源的结局是所有人都学会忽略它——**本会话已经栽过一次**
 * （M3-20「每天报历史观察」最终变成背景音）。
 *
 * ## 「过期」≠「错误」
 *
 * - **失败**（exit 1）：文档断言了一个**与当前事实不符**的数字。
 *   这是**错误**——读者会据此做出错误判断。
 * - **告警**（exit 0，只打印）：`asOf` 超过阈值。这是**该复核了**，不是文档错了。
 *   数字可能仍然对，只是没人确认过它还对。
 *
 * 两者混在一起，CI 就会在「什么都没坏、只是过了一个月」时变红——
 * 那正是噪音的来源。
 */

const PRD_PATH = 'docs/prd/dsh-plugin-consolidation.md';

/** `asOf` 超过这么多天就告警（不复核）。60 天是「一个季度内至少看一眼」。 */
const ASOF_STALE_DAYS = 60;

const failures: string[] = [];
const warnings: string[] = [];

const read = (path: string) => readFile(path, 'utf8');

/** 从 PRD 附录 A 取 `asOf` 日期。 */
const asOfOf = (text: string): Date | null => {
  const match = text.match(/附录 A：事实快照（asOf (\d{4}-\d{2}-\d{2})/);
  if (match?.[1] === undefined) return null;
  return new Date(`${match[1]}T00:00:00Z`);
};

/** 附录 A 里「注册表工具数」那一行的值和取证命令。 */
const registryCountOf = (text: string): { value: number | null; command: string } => {
  const row = text
    .split('\n')
    .find((line) => line.includes('registry 工具数') && line.startsWith('|'));
  if (row === undefined) return { value: null, command: '' };
  const cells = row.split('|').map((cell) => cell.trim());
  // | 项 | 实测值 | 取证方式 |
  const valueMatch = cells[2]?.match(/\*\*(\d+)\*\*/) ?? cells[2]?.match(/(\d+)/);
  return {
    value: valueMatch?.[1] === undefined ? null : Number(valueMatch[1]),
    command: cells[3] ?? '',
  };
};

const prd = await read(PRD_PATH);

// ── 检查 1：附录 A 的 asOf 是否该复核（告警，不是失败）──
const asOf = asOfOf(prd);
if (asOf === null) {
  failures.push(`${PRD_PATH}: 附录 A 缺少可解析的 \`asOf YYYY-MM-DD\``);
} else {
  const days = Math.floor((Date.now() - asOf.getTime()) / 86_400_000);
  if (days > ASOF_STALE_DAYS)
    warnings.push(
      `PRD 附录 A 的 asOf 是 ${asOf.toISOString().slice(0, 10)}（${String(days)} 天前）——该复核了，不一定是错的`,
    );
}

// ── 检查 2：附录 A 写死的工具数与 registry 实际值是否一致（失败）──
//
// 这是**错误**：附录 A 的定位就是「正文只引用本附录」，读者据此认为工具数是那个值。
const actual = toolRegistry.all().length;
const declared = registryCountOf(prd);
if (declared.value === null) {
  failures.push(`${PRD_PATH}: 附录 A 找不到「registry 工具数」的实测值`);
} else if (declared.value !== actual) {
  failures.push(
    `PRD 附录 A 写 registry 工具数是 ${String(declared.value)}，实际 ${String(actual)}` +
      `（取证：${declared.command || 'bun run tools:list --json'}）`,
  );
}

// ── 检查 3：文档里「现在仍然是 N 个 tool」式断言不得过时（失败）──
//
// 注意**不 grep 字面量**：历史文档里出现「当时为 178 个 tool」是正常的叙述，
// 它描述的是过去。真正有害的是**让读者以为是当前值**的表述。
// 所以只查「当前/现在/共 N 个 tool」这类现在时句式。
const staleAssertions = [
  { path: 'docs/ARCHITECTURE.md', pattern: /(?:当前|现在|目前)[^。\n]{0,12}(\d+)\s*个\s*tool/g },
  { path: 'README.md', pattern: /(?:当前|现在|目前)[^。\n]{0,12}(\d+)\s*个\s*tool/g },
];
for (const { path, pattern } of staleAssertions) {
  let text: string;
  try {
    text = await read(path);
  } catch {
    continue; // 文件不存在不算失败：不是每个仓库都有这些文件。
  }
  for (const match of text.matchAll(pattern)) {
    const claimed = Number(match[1]);
    if (claimed !== actual)
      failures.push(`${path}: 断言「${match[0]}」，实际 ${String(actual)} 个 tool`);
  }
}

// ── 输出 ──
for (const warning of warnings) console.warn(`[check-docs] 告警：${warning}`);
for (const failure of failures) console.error(`[check-docs] 失败：${failure}`);

if (failures.length > 0) {
  console.error(
    `[check-docs] ${String(failures.length)} 项失败（文档与当前事实不符，读者会据此误判）`,
  );
  process.exit(1);
}
console.log(
  `[check-docs] 通过（registry ${String(actual)} 个 tool；${String(warnings.length)} 条告警）`,
);
