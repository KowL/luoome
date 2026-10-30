// 插件暴露面 ↔ 共享判定的对账守卫（M2-09 / T12 的 M2-03 后续形态）。
//
// 要守的问题：暴露面判定过去在 read surface、market surface、production 装配与旧 stdio
// MCP 面各写一份，谁都不对账 —— 同一个工具「这里说能暴露、那里说不能」这种
// 漂移没人看得见。M2-09 把五条判定（名字白名单 / 拒绝清单 / 私人研究 / 能力 / trade）
// 归位到 `@luoome/tools` 的 `exposure/judge.ts`，本文件证明剩下的插件面**真的**在用它：
//
//   1. read / market 面的最终名单逐工具等于 `judgeTool` 的输出 —— 任一面偷偷加判定都会红；
//   2. 配置不同时，差异必须且只能由「名字没被点名」解释（reason = not-in-allowlist），
//      也就是差异来自配置而不是判定；
//   3. 私人研究 / 拒绝清单 / 能力不足 / trade 四条规则在两侧（全收面与默认面）要么同时
//      放行要么同时拒绝，且拒绝原因与共享判定一致。
//
// M2-03 删除了 MCP stdio 用户入口，原来「MCP 面 ↔ 插件面」的双面对账因此只剩插件面；共享判定本身仍由 `packages/tools/src/exposure/judge.test.ts`
// 逐条覆盖，本文件只负责「surface 的名单 = 判定的输出」这一层。
//
// **运行环境：Node（`bun run test` 的 vitest）。** 本文件不 import 生产 composition root
// （`production.ts` → `node:sqlite`），只 import 纯配置与两个 surface，因此在 Node 与
// Bun 下行为一致。
import type { ToolContext } from '@luoome/core';
import {
  assertTradeNeverExposed,
  exposureCriteria,
  judgeTool,
  privateResearchTools,
  selectExposedTools,
  TRADE_EXPOSURE_MESSAGE,
  toolRegistry,
} from '@luoome/tools';
import { describe, expect, it, vi } from 'vitest';
import { createMarketSurface } from './market-surface.js';
import { DEFAULT_MARKET_TOOL_ALLOWLIST, DEFAULT_READ_TOOL_ALLOWLIST } from './production-config.js';
import { createReadSurface } from './read-surface.js';

const tools = toolRegistry.all();
const byName = new Map(tools.map((tool) => [tool.name, tool]));
const registryNames = tools.map((tool) => tool.name);

/** 按名字取 registry 工具；缺失即测试自身失效（不静默跳过判定对账）。 */
const toolFor = (name: string) => {
  const tool = byName.get(name);
  if (tool === undefined) throw new Error(`registry 缺少工具 ${name}`);
  return tool;
};

/** surface 只需在 descriptor 阶段工作，执行路径不参与判定对账。 */
const context = (): ToolContext => ({}) as ToolContext;

const readNames = (
  options: {
    readonly allowlist?: readonly string[];
    readonly denylist?: readonly string[];
    readonly exposeResearch?: boolean;
  } = {},
): readonly string[] =>
  createReadSurface({
    config: {
      allowlist: [...(options.allowlist ?? registryNames)],
      denylist: [...(options.denylist ?? [])],
      ...(options.exposeResearch === undefined ? {} : { exposeResearch: options.exposeResearch }),
    },
    tools,
    context,
  })
    .descriptors()
    .map((descriptor) => descriptor.name);

const marketNames = (allowlist: readonly string[] = DEFAULT_MARKET_TOOL_ALLOWLIST) =>
  createMarketSurface({ config: { allowlist: [...allowlist] }, tools, context })
    .descriptors()
    .map((descriptor) => descriptor.name);

/** 与 surface 内部折叠出的 criteria 同构：用来证明面没有第二套判定。 */
const criteriaFor = (options: {
  readonly allowedSideEffects: ('read' | 'external')[];
  readonly allowlist?: readonly string[];
  readonly denylist?: readonly string[];
  readonly exposeResearch?: boolean;
}) =>
  exposureCriteria({
    allowedSideEffects: options.allowedSideEffects,
    allowlist: options.allowlist,
    denylist: options.denylist ?? [],
    exposeResearch: options.exposeResearch === true,
  });

const sorted = (names: readonly string[]): readonly string[] => [...names].sort();

describe('exposure reconciliation · 插件面与共享判定同源', () => {
  it('全收配置下 read 面逐工具等于共享判定的输出', () => {
    const criteria = criteriaFor({ allowedSideEffects: ['read'], allowlist: registryNames });
    const expected = selectExposedTools(tools, criteria).map((tool) => tool.name);
    expect(sorted(readNames())).toEqual(sorted(expected));
    // 非空断言：两面都空时下面的「等于判定输出」会一起变成空转。
    expect(expected.length).toBeGreaterThan(0);
    // 逐工具再核一遍 exposed 布尔，避免「集合相等但判定来源不同」的巧合。
    for (const tool of tools)
      expect(judgeTool(tool, criteria).exposed, tool.name).toBe(readNames().includes(tool.name));
  });

  it('默认 read 面与全收面的差异只来自名字没被点名，不来自判定分歧', () => {
    const all = readNames();
    const defaults = readNames({ allowlist: DEFAULT_READ_TOOL_ALLOWLIST });
    const criteria = criteriaFor({
      allowedSideEffects: ['read'],
      allowlist: DEFAULT_READ_TOOL_ALLOWLIST,
    });

    expect(defaults.filter((name) => !all.includes(name))).toEqual([]);
    const onlyAll = all.filter((name) => !defaults.includes(name));
    expect(onlyAll.length).toBeGreaterThan(0);
    for (const name of onlyAll)
      expect(judgeTool(toolFor(name), criteria)).toEqual({
        exposed: false,
        reason: 'not-in-allowlist',
      });
    // 默认 read allowlist 全是只读工具：否则 surface 会静默少注册，上一条会红。
    expect(defaults).toHaveLength(DEFAULT_READ_TOOL_ALLOWLIST.length);
  });

  it('私人研究：默认关闭，显式 opt-in 才放开，两侧同时生效', () => {
    const research = privateResearchTools.find((name) => byName.has(name));
    expect(research).toBeDefined();
    if (research === undefined) return;

    expect(readNames()).not.toContain(research);
    expect(
      judgeTool(
        toolFor(research),
        criteriaFor({ allowedSideEffects: ['read'], allowlist: registryNames }),
      ),
    ).toEqual({ exposed: false, reason: 'private-research' });
    expect(readNames({ exposeResearch: true })).toContain(research);
  });

  it('拒绝清单：同一个名字由配置决定，判定原因固定为 denylisted', () => {
    const deniedName = 'get_advice';
    expect(readNames()).toContain(deniedName);
    expect(readNames({ denylist: [deniedName] })).not.toContain(deniedName);
    expect(
      judgeTool(toolFor(deniedName), {
        ...criteriaFor({ allowedSideEffects: ['read'], allowlist: registryNames }),
        denylist: new Set([deniedName]),
      }),
    ).toEqual({ exposed: false, reason: 'denylisted' });
  });

  it('能力不足：external+write 组合工具在只读面上不可见', () => {
    const multi = tools.find(
      (tool) => tool.sideEffect === 'external' && tool.requiredCapabilities.includes('write'),
    );
    expect(multi).toBeDefined();
    if (multi === undefined) return;
    expect(readNames()).not.toContain(multi.name);
    expect(
      judgeTool(multi, criteriaFor({ allowedSideEffects: ['read'], allowlist: registryNames })),
    ).toEqual({ exposed: false, reason: 'capability-not-allowed' });
  });

  it('market 面名单正好等于配置，且逐工具落在 external 判定内', () => {
    const market = marketNames();
    expect(sorted(market)).toEqual(sorted(DEFAULT_MARKET_TOOL_ALLOWLIST));
    expect(market.length).toBeGreaterThan(0);
    expect(market).toEqual(
      selectExposedTools(
        tools,
        criteriaFor({
          allowedSideEffects: ['external'],
          allowlist: DEFAULT_MARKET_TOOL_ALLOWLIST,
        }),
      ).map((tool) => tool.name),
    );
  });

  it('trade 硬卡：同一判定、同一文案，永不暴露', () => {
    const trades = tools.filter((tool) => tool.sideEffect === 'trade');
    expect(trades.length).toBeGreaterThan(0);
    for (const tool of trades) {
      expect(readNames()).not.toContain(tool.name);
      expect(
        judgeTool(tool, criteriaFor({ allowedSideEffects: ['read'], allowlist: registryNames })),
      ).toEqual({ exposed: false, reason: 'trade' });
    }
    expect(() => assertTradeNeverExposed('true')).toThrow(TRADE_EXPOSURE_MESSAGE);

    vi.stubEnv('LUOOME_EXPOSE_TRADE', 'true');
    try {
      expect(() => createReadSurface({ config: { allowlist: [] }, tools, context })).toThrow(
        TRADE_EXPOSURE_MESSAGE,
      );
      expect(() => createMarketSurface({ config: { allowlist: [] }, tools, context })).toThrow(
        TRADE_EXPOSURE_MESSAGE,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
