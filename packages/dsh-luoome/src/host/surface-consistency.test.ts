// 插件暴露面 ↔ 领域 registry 的一致性守卫（T04 / REQ-M1-03）。
//
// 要守的问题：插件里「这个工具存不存在」过去取决于问谁 —— policy 名单与 registry 各自
// 维护，谁都不对账。本文件把两侧接上：`createProductionOperationPolicies()` 声明的每个
// 工具名，都必须在 registry 里真实存在，且 sideEffect / requiredCapabilities 与 registry
// 的声明逐字段一致；registry 之外的 tool 定义必须有登记出处（`workflow-only-tools.ts`）。
//
// **运行环境：Node 24。** 生产 composition root `production.js` 依赖 `node:sqlite`
// （Node 22+ 内置，Node 24 默认可用；Bun 运行时下会直接报
// `No such built-in module: node:sqlite`），因此本文件不属于 `bun test` 的包。
// 三种跑法，前两种是日常入口，第三种是显式 Node 24：
//
//   bun run test                       # 全量 vitest（Node 下执行，本文件在其中）
//   bun run test:dsh-luoome            # vitest run packages/dsh-luoome
//   npm exec --yes --package=node@24 -- \
//     node ./node_modules/vitest/vitest.mjs run \
//     packages/dsh-luoome/src/host/surface-consistency.test.ts
//
// 反例（确认环境边界）：`bun test packages/dsh-luoome/src/host/surface-consistency.test.ts`
// 会在 `node:sqlite` 上失败 —— 这不是用例问题，是运行时选错。
//
// 断言里不写任何工具总数（registry / policies / 分类计数都会漂），只断言集合关系与
// 逐项字段一致；唯一写死的名单是 KNOWN_DRIFT，且它被两侧夹住（见该常量注释）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { privateResearchTools, toolRegistry } from '@luoome/tools';
import { describe, expect, it } from 'vitest';
import {
  classifyTools,
  EXPOSURE_CLASSES,
  type ExposureClass,
  namesInExposure,
  unknownExposureExceptions,
} from '../../../tools/src/exposure/classify.js';
import {
  unaccountedToolDefinitions,
  WORKFLOW_ONLY_TOOL_NAMES,
  workflowOnlyNamesInRegistry,
} from '../../../tools/src/internal/workflow-only-tools.js';

import { createProductionOperationPolicies } from './production.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/tools/src`：定义名扫描的根（只扫 tools/** 与 queue/**）。 */
const TOOLS_SRC = resolve(HERE, '../../../tools/src');

/**
 * 已知漂移：policies 里有、registry 里还没有的工具名（→ 追踪单）。
 *
 * **当前为空**：T06 / REQ-M1-05 已把 `execute_strict_strategy_backtest` 的域内实现收编进
 * registry，并删掉插件侧的同名 policy 副本 —— registry 外的 policy 从此为 0。
 *
 * 空名单不等于放宽：下面的断言仍是「实测漂移 === 名单」的精确相等，
 * - 「没新增」：实测漂移里出现任何名字 → 失败（新债不会静默进来）；
 * - 「只缩小」：名单里的名字已经进 registry → 也失败（修好了必须删条目，残留在名单里就红）。
 *
 * 不选 `it.todo` / `skip`：跳过会让漂移变成不可见的背景，而这正是本单要消灭的形态。
 */
const KNOWN_DRIFT: ReadonlyMap<string, string> = new Map();

/**
 * 已知能力漂移：policy 与 registry 对同一工具的能力声明不一致。
 *
 * **当前为空**：T06 按「读工具实现体的真实 I/O」逐条判定了原 3 条漂移，两侧已收敛到同一份声明：
 *
 * | 工具 | 真实 I/O | 改的是哪一侧 |
 * |---|---|---|
 * | `start_strategy_evaluation_session` | 本体写本地 session 行；受理后宿主推进的逐日 replay 会调 `prepare_strategy_data`（`requiredCapabilities=['external','write']`）取外部数据 | **registry 补 `external`**（受理即代表外部取数，fail-closed） |
 * | `resume_strategy_evaluation_session` | 同上：续跑会让宿主对未完成日期重跑 replay | **registry 补 `external`** |
 * | `create_strict_strategy_backtest` | `assembleBacktest` 只读 strategyEvaluation / strategyRun / strategyBacktest / dailyBar 四张本地表；门禁完备后的执行步也只读本地事实 | **policy 收敛为 `['write']`**（原声明多要了 external） |
 *
 * 因此这里不再登记任何差异，但仍用两侧夹住（新增漂移即红、修好不删即红），并保留一条
 * **永不放松**的方向约束：policy 的能力集合不得弱于 registry（见下一条用例）。
 */
const KNOWN_CAPABILITY_DRIFT: ReadonlyMap<string, string> = new Map();

const registryTools = toolRegistry.all();
const registryNames: ReadonlySet<string> = new Set(registryTools.map((tool) => tool.name));
const policies = createProductionOperationPolicies();
const classification = classifyTools(registryTools);

/** 扫描 `defineTool({ name: '...' })` 的定义名（跳过测试文件）。 */
const readDefinitionNames = (): readonly string[] => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
    }
  };
  for (const group of ['tools', 'queue']) walk(join(TOOLS_SRC, group));
  const pattern = /defineTool\(\{[\s\S]*?\n\s*name:\s*'([^']+)'/g;
  const names = files.flatMap((file) =>
    [...readFileSync(file, 'utf8').matchAll(pattern)].map((match) => match[1] ?? ''),
  );
  // 扫描根写错时要报「扫到 0 个定义」，而不是静默通过。
  expect(files.length).toBeGreaterThan(0);
  return names;
};

const policyNames = policies.map((policy) => policy.tool.name);
const driftedPolicyNames = policyNames.filter((name) => !registryNames.has(name));

describe('surface-consistency · operation policy ↔ 领域 registry', () => {
  it('policy 声明的工具名都在 registry 里（已知漂移除外）', () => {
    const unknown = driftedPolicyNames.filter((name) => !KNOWN_DRIFT.has(name));
    expect(unknown).toEqual([]);
  });

  it('KNOWN_DRIFT 与实测漂移完全一致：只允许缩小，不允许新增', () => {
    expect([...driftedPolicyNames].sort()).toEqual([...KNOWN_DRIFT.keys()].sort());
  });

  it('KNOWN_DRIFT 的每个名字都在「registry 之外有定义」名单里', () => {
    const outside = new Set(WORKFLOW_ONLY_TOOL_NAMES);
    for (const name of KNOWN_DRIFT.keys()) expect(outside.has(name)).toBe(true);
  });

  it('policy 的 sideEffect 与 registry 声明一致', () => {
    const mismatched: string[] = [];
    for (const policy of policies) {
      if (KNOWN_DRIFT.has(policy.tool.name)) continue;
      const registered = toolRegistry.get(policy.tool.name);
      if (registered === undefined) continue; // 已由上面两条用例指名报错
      if (registered.sideEffect !== policy.tool.sideEffect)
        mismatched.push(
          `${policy.tool.name}: policy=${policy.tool.sideEffect} registry=${registered.sideEffect}`,
        );
    }
    expect(mismatched).toEqual([]);
  });

  it('policy 的 requiredCapabilities 与 registry 声明一致（已知能力漂移除外）', () => {
    const mismatched: string[] = [];
    for (const policy of policies) {
      if (KNOWN_DRIFT.has(policy.tool.name)) continue;
      const registered = toolRegistry.get(policy.tool.name);
      if (registered === undefined) continue;
      const policyCapabilities = [...policy.tool.requiredCapabilities].sort();
      const registryCapabilities = [...registered.requiredCapabilities].sort();
      if (policyCapabilities.join(',') !== registryCapabilities.join(','))
        mismatched.push(
          `${policy.tool.name}: policy=[${policyCapabilities}] registry=[${registryCapabilities}]`,
        );
    }
    const unknown = mismatched.filter(
      (line) => !KNOWN_CAPABILITY_DRIFT.has(line.slice(0, line.indexOf(':'))),
    );
    expect(unknown).toEqual([]);
    // 两侧夹住：登记过的差异一旦被修好，条目必须删掉，否则本行报红。
    expect(new Set(mismatched.map((line) => line.slice(0, line.indexOf(':'))))).toEqual(
      new Set(KNOWN_CAPABILITY_DRIFT.keys()),
    );
  });

  it('policy 的能力集合不得弱于 registry（方向约束，永不放松）', () => {
    const weakened: string[] = [];
    for (const policy of policies) {
      if (KNOWN_DRIFT.has(policy.tool.name)) continue;
      const registered = toolRegistry.get(policy.tool.name);
      if (registered === undefined) continue;
      const declared = new Set(policy.tool.requiredCapabilities);
      for (const capability of registered.requiredCapabilities)
        if (!declared.has(capability)) weakened.push(`${policy.tool.name}: missing ${capability}`);
      if (!declared.has(registered.sideEffect))
        weakened.push(`${policy.tool.name}: missing sideEffect ${registered.sideEffect}`);
    }
    expect(weakened).toEqual([]);
  });
});

describe('surface-consistency · registry 之外的工具定义必须有登记出处', () => {
  it('registry ∪ WORKFLOW_ONLY_TOOL_NAMES ⊇ tools/**、queue/** 全部 defineTool 定义名', () => {
    expect(unaccountedToolDefinitions(readDefinitionNames(), registryNames)).toEqual([]);
  });

  it('WORKFLOW_ONLY_TOOL_NAMES 与 registry 不重叠（收编进 registry 后必须摘除）', () => {
    expect(workflowOnlyNamesInRegistry(registryNames)).toEqual([]);
  });

  it('WORKFLOW_ONLY_TOOL_NAMES 无重复项', () => {
    expect(new Set(WORKFLOW_ONLY_TOOL_NAMES).size).toBe(WORKFLOW_ONLY_TOOL_NAMES.length);
  });
});

describe('surface-consistency · 暴露面五类与 T03 交接断言', () => {
  it('未归类工具数 = 0，五类并集 === registry 全部工具名', () => {
    expect(classification.tools).toHaveLength(registryTools.length);
    const union = new Set(classification.tools.map((item) => item.name));
    expect(union).toEqual(new Set(registryNames));
    const covered = EXPOSURE_CLASSES.reduce(
      (total, exposure) => total + classification.counts[exposure],
      0,
    );
    expect(covered).toBe(classification.tools.length);
    expect(
      classification.tools.filter(
        (item) => !(EXPOSURE_CLASSES as readonly string[]).includes(item.exposure),
      ),
    ).toEqual([]);
  });

  it('例外名单没有腐烂（unknownExposureExceptions 为空）', () => {
    expect(unknownExposureExceptions(registryTools)).toEqual([]);
  });

  it('私人研究面 ⊆ privateResearchTools（复用同一份拒绝清单）', () => {
    const research = new Set<string>(privateResearchTools);
    for (const name of namesInExposure(classification, 'private-research'))
      expect(research.has(name)).toBe(true);
  });

  it('trade 声明的工具必须归 queue-worker，且不得是 retired', () => {
    const tradeTools = classification.tools.filter(
      (item) => item.sideEffect === 'trade' || item.requiredCapabilities.includes('trade'),
    );
    expect(tradeTools.length).toBeGreaterThan(0);
    for (const item of tradeTools) {
      const exposure: ExposureClass = item.exposure;
      expect(exposure).toBe('queue-worker');
      expect(exposure).not.toBe('retired');
    }
  });

  it('retired 面必须为空（摘除工具须同时改本断言）', () => {
    expect(namesInExposure(classification, 'retired')).toEqual([]);
  });
});
