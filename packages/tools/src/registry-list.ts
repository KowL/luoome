// 工具库存对账单（T04 / REQ-M1-03）：`bun run tools:list` / `bun run tools:list --json`。
//
// 回答三个过去只能靠人肉数的问题：
//   1. registry 里到底有哪些工具，各自归五类中的哪一类（消费 `exposure/classify.ts`）；
//   2. 当前插件形态的暴露集是哪些、不可达集是哪些，**每个工具都带 exposed /
//      unreachable-by-design 标签**，并给出「为什么可达」（read allowlist / operation
//      policy / market allowlist）；
//   3. registry 之外还有哪些工具定义（`WORKFLOW_ONLY_TOOL_NAMES`），以及 policies 里
//      是否有名字在 registry 里找不到（shadow 声明）。
//
// **运行环境：Node 24。** 本脚本要读插件暴露面的唯一真源 —— `production.ts` 的
// `createProductionOperationPolicies()`，而它经 `@luoome/db/node` 依赖 `node:sqlite`
// （Node 22+ 内置）。Bun 运行时会直接报 `No such built-in module: node:sqlite`：
//
//   bun run tools:list          # = npm exec --yes --package=tsx@4 --package=node@24 -- tsx 本文件
//   bun run tools:list --json   # 机器可读；可直接 `| jq`
//
// 为什么是 `npm exec` 而不是 `npx`：`bun run` 会把脚本里字面的 `npx` 改写成 `bun x`，
// 而 `bun x` 只认一个 `--package`（试过 `-p tsx@4 -p node@24`，报
// `Package node does not provide a binary named tsx`）。`npm exec` 不被改写，等价于 npx。
//
// 为什么需要 tsx：Node 的类型剥离不把 `.js` 说明符映射到 `.ts`（本仓全用 `.js` 后缀
// 的 ESM import），所以要靠 tsx 做这层解析；`node@24` 由 npm exec 提供并在 PATH 里排在
// 前面，tsx 的 `#!/usr/bin/env node` 因此解析到 Node 24，`node:sqlite` 可用。
// 只加 `node --experimental-strip-types` 不够：它不做 `.js`→`.ts` 的说明符解析。
//
// 分层说明：本文件是 **ops 脚本**，不在任何运行时导入路径上（`packages/tools/src/index.ts`
// 不导出它，构建也不会打包它）。它故意跨到 surface 包取「插件暴露集」—— 对账的两侧本就
// 分属 tools 与 dsh-luoome，把这份口径复制到 tools 里才是真正的漂移源。

import { createProductionOperationPolicies } from '../../dsh-luoome/src/host/production.js';
import {
  DEFAULT_MARKET_TOOL_ALLOWLIST,
  DEFAULT_READ_TOOL_ALLOWLIST,
} from '../../dsh-luoome/src/host/production-config.js';
import {
  classifyTools,
  EXPOSURE_CLASS_LABELS,
  EXPOSURE_CLASSES,
  type ExposureClass,
  unknownExposureExceptions,
} from './exposure/classify.js';
import {
  BATCH_SCHEDULED_TOOL_NAMES,
  OPERATION_POLICY_ONLY_TOOL_NAMES,
  UNWIRED_TOOL_NAMES,
  WORKFLOW_INTERNAL_TOOL_NAMES,
  WORKFLOW_ONLY_TOOL_NAMES,
} from './internal/workflow-only-tools.js';
import { toolRegistry } from './registry.js';

/** 可达来源，按「谁点名了它」区分；一个工具可能同时被多处点名。 */
const SURFACE_SOURCES = ['read-allowlist', 'operation-policy', 'market-allowlist'] as const;
type SurfaceSource = (typeof SURFACE_SOURCES)[number];

const SURFACE_SOURCE_LABELS: Readonly<Record<SurfaceSource, string>> = {
  'read-allowlist': 'read allowlist',
  'operation-policy': 'operation policy',
  'market-allowlist': 'market allowlist',
};

/**
 * 终端列宽：CJK / 全角字符占两格。`padEnd` 按码元补空格，中文标签会错位，
 * 所以文本输出统一走这个函数（JSON 不受影响）。
 */
const padDisplay = (text: string, width: number): string => {
  let used = 0;
  for (const char of text)
    used +=
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(
        char,
      )
        ? 2
        : 1;
  return text + ' '.repeat(Math.max(0, width - used));
};

const TOOL_TAGS = ['exposed', 'unreachable-by-design'] as const;
type ToolTag = (typeof TOOL_TAGS)[number];

interface ToolReport {
  readonly name: string;
  readonly sideEffect: string;
  readonly requiredCapabilities: readonly string[];
  readonly exposure: ExposureClass;
  readonly exposureLabel: string;
  readonly derivedFrom: string;
  readonly tag: ToolTag;
  readonly reachableVia: readonly SurfaceSource[];
  readonly reason?: string;
}

const tools = toolRegistry.all();
const registryNames = new Set(tools.map((tool) => tool.name));
const classification = classifyTools(tools);

const policies = createProductionOperationPolicies();
const policyNames = policies.map((policy) => policy.tool.name);
const policyNamesOutsideRegistry = [
  ...new Set(policyNames.filter((name) => !registryNames.has(name))),
];

/** name → 点名它的表面；同一来源只记一次。 */
const reachableVia = new Map<string, SurfaceSource[]>();
const mark = (source: SurfaceSource, names: readonly string[]): void => {
  for (const name of names) {
    const list = reachableVia.get(name) ?? [];
    if (!list.includes(source)) list.push(source);
    reachableVia.set(name, list);
  }
};
mark('read-allowlist', DEFAULT_READ_TOOL_ALLOWLIST);
mark('operation-policy', policyNames);
mark('market-allowlist', DEFAULT_MARKET_TOOL_ALLOWLIST);

const report: readonly ToolReport[] = tools.map((tool) => {
  const classified = classification.byName.get(tool.name);
  // classifyTools 覆盖全部入参；缺失说明分类实现被改坏，按 fail-closed 直接报错而不是标成不可达。
  if (classified === undefined) throw new Error(`Tool is not classified: ${tool.name}`);
  const via = reachableVia.get(tool.name) ?? [];
  return {
    name: tool.name,
    sideEffect: tool.sideEffect,
    requiredCapabilities: [...tool.requiredCapabilities],
    exposure: classified.exposure,
    exposureLabel: EXPOSURE_CLASS_LABELS[classified.exposure],
    derivedFrom: classified.derivedFrom,
    tag: via.length > 0 ? 'exposed' : 'unreachable-by-design',
    reachableVia: via,
    ...(classified.reason === undefined ? {} : { reason: classified.reason }),
  };
});

const exposed = report.filter((item) => item.tag === 'exposed');
const unreachable = report.filter((item) => item.tag === 'unreachable-by-design');
const danglingExceptions = unknownExposureExceptions(tools);
const union = new Set(report.map((item) => item.name));
const classUnionEqualsRegistry =
  union.size === registryNames.size && [...registryNames].every((name) => union.has(name));
const classCountSum = EXPOSURE_CLASSES.reduce(
  (total, exposure) => total + classification.counts[exposure],
  0,
);
const everyToolTagged = report.every((item) => TOOL_TAGS.includes(item.tag));

const checks = {
  unclassified: report.filter((item) => !EXPOSURE_CLASSES.includes(item.exposure)).length,
  classUnionEqualsRegistry,
  classCountSumEqualsRegistry: classCountSum === registryNames.size,
  everyToolTagged,
  danglingExceptions,
};

const classRows = EXPOSURE_CLASSES.map((exposure) => ({
  exposure,
  label: EXPOSURE_CLASS_LABELS[exposure],
  count: classification.counts[exposure],
  exposed: report.filter((item) => item.exposure === exposure && item.tag === 'exposed').length,
  unreachableByDesign: report.filter(
    (item) => item.exposure === exposure && item.tag === 'unreachable-by-design',
  ).length,
}));

const jsonPayload = {
  runtime: { node: process.version, script: 'packages/tools/src/registry-list.ts' },
  totals: {
    registry: tools.length,
    exposed: exposed.length,
    unreachableByDesign: unreachable.length,
    unclassified: checks.unclassified,
  },
  classes: classRows,
  surface: {
    readAllowlist: [...DEFAULT_READ_TOOL_ALLOWLIST],
    marketAllowlist: [...DEFAULT_MARKET_TOOL_ALLOWLIST],
    operationPolicies: [...new Set(policyNames)],
    operationPoliciesOutsideRegistry: policyNamesOutsideRegistry,
  },
  workflowOnly: {
    all: [...WORKFLOW_ONLY_TOOL_NAMES],
    workflowInternal: [...WORKFLOW_INTERNAL_TOOL_NAMES],
    batchScheduled: [...BATCH_SCHEDULED_TOOL_NAMES],
    operationPolicyOnly: [...OPERATION_POLICY_ONLY_TOOL_NAMES],
    unwired: [...UNWIRED_TOOL_NAMES],
  },
  tools: report,
  checks,
};

const invocationFailed =
  checks.unclassified > 0 ||
  !checks.classUnionEqualsRegistry ||
  !checks.classCountSumEqualsRegistry ||
  !checks.everyToolTagged ||
  checks.danglingExceptions.length > 0;

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(jsonPayload, null, 2)}\n`);
} else {
  const lines: string[] = [];
  const tick = (ok: boolean): string => (ok ? '✅' : '❌');
  lines.push(`luoome 工具库存（registry ${tools.length}）· node ${process.version}`);
  lines.push('');
  lines.push(`五类分类（${classRows.length} 类，全部工具各一类）`);
  for (const row of classRows)
    lines.push(
      `  ${padDisplay(row.exposure, 17)}${padDisplay(row.label, 26)}${String(row.count).padStart(3)}  ` +
        `exposed ${String(row.exposed).padStart(3)} / unreachable-by-design ${String(row.unreachableByDesign).padStart(3)}`,
    );
  lines.push('');
  lines.push('可达口径（exposed = 被以下任一表面点名）');
  lines.push(`  read allowlist        ${String(DEFAULT_READ_TOOL_ALLOWLIST.length).padStart(3)}`);
  lines.push(
    `  operation policy      ${String(new Set(policyNames).size).padStart(3)}` +
      `（其中不在 registry ${policyNamesOutsideRegistry.length}：${policyNamesOutsideRegistry.join(', ') || '—'}）`,
  );
  lines.push(`  market allowlist      ${String(DEFAULT_MARKET_TOOL_ALLOWLIST.length).padStart(3)}`);
  lines.push(`  exposed               ${String(exposed.length).padStart(3)}`);
  lines.push(`  unreachable-by-design ${String(unreachable.length).padStart(3)}`);
  lines.push('');
  for (const tag of TOOL_TAGS) {
    const group = report.filter((item) => item.tag === tag);
    lines.push(`[${tag}] ${group.length}`);
    for (const item of group) {
      const via =
        item.tag === 'exposed'
          ? `  ← ${item.reachableVia.map((source) => SURFACE_SOURCE_LABELS[source]).join(' + ')}`
          : '';
      lines.push(`  ${item.name.padEnd(44)}${item.sideEffect.padEnd(9)}${item.exposure}${via}`);
    }
    lines.push('');
  }
  lines.push(`registry 之外的工具定义（${WORKFLOW_ONLY_TOOL_NAMES.length}）`);
  lines.push(
    `  workflow internal     ${WORKFLOW_INTERNAL_TOOL_NAMES.length}：${WORKFLOW_INTERNAL_TOOL_NAMES.join(', ')}`,
  );
  lines.push(
    `  batch scheduled       ${BATCH_SCHEDULED_TOOL_NAMES.length}：${BATCH_SCHEDULED_TOOL_NAMES.join(', ')}`,
  );
  lines.push(
    `  operation-policy only ${OPERATION_POLICY_ONLY_TOOL_NAMES.length}：${OPERATION_POLICY_ONLY_TOOL_NAMES.join(', ')}`,
  );
  lines.push(
    `  unwired               ${UNWIRED_TOOL_NAMES.length}：${UNWIRED_TOOL_NAMES.join(', ')}`,
  );
  lines.push('');
  lines.push('校验');
  lines.push(`  ${tick(checks.unclassified === 0)} 未归类工具数 = ${checks.unclassified}`);
  lines.push(
    `  ${tick(checks.classUnionEqualsRegistry)} 五类并集 === registry 全部工具名（${union.size} / ${registryNames.size}）`,
  );
  lines.push(
    `  ${tick(checks.classCountSumEqualsRegistry)} 五类计数之和 === registry 工具数（${classCountSum} / ${registryNames.size}）`,
  );
  lines.push(`  ${tick(checks.everyToolTagged)} 每个工具都有 exposed / unreachable-by-design 标签`);
  lines.push(
    `  ${tick(checks.danglingExceptions.length === 0)} 例外名单无残留（未命中工具：${checks.danglingExceptions.join(', ') || '—'}）`,
  );
  lines.push('');
  lines.push('提示：`bun run tools:list --json` 输出同一份数据的机器可读版本（可直接 | jq）。');
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (invocationFailed) process.exitCode = 1;
