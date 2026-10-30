// 暴露面判定（M2-09 / T12）：插件面与 MCP 面共用的**唯一**判定实现。
//
// 本文件只做纯数据判断：入参是普通 JS 结构（工具声明、名字集合、能力集合），出参是普通
// JS 值（布尔、字符串、数组）。没有 IO、没有 env 读取、没有宿主服务、没有 `@deepseek-ai/*`
// 类型 —— surface 侧（dsh-luoome 的 read/market surface、MCP 的 env 适配）只负责
// 「把配置解析成 criteria」和「把判定结果包成 ToolResult / 注册给宿主」。
//
// 为什么必须与适配分开：M2 要删 MCP 用户入口（T13），而插件仍在用同一套判定。判定归位到
// 本文件后，删 MCP 只删它的 env 适配层，判定不受影响。守卫：`bun run check:layers` 断言
// `packages/tools` 不含 `@deepseek-ai/` import。
import type { SideEffect } from '@luoome/core';

/**
 * 判定只需要这三个声明字段；registry 的 `Tool`、surface 的 descriptor 都结构上满足它。
 *
 * 坚持「结构满足」而不是 import 具体 Tool 类型，是为了让判定能接受 **任何** surface 的
 * 轻量记录（例如 MCP 侧只声明 name/sideEffect 的假工具），不把某一侧的类型变成公用契约。
 */
export interface JudgedTool {
  readonly name: string;
  readonly sideEffect: SideEffect;
  readonly requiredCapabilities?: readonly SideEffect[] | undefined;
}

/** 能力集合的规范化：未声明 requiredCapabilities 时，工具自身 sideEffect 就是它需要的能力。 */
export const capabilitiesOf = (tool: JudgedTool): readonly SideEffect[] =>
  tool.requiredCapabilities ?? [tool.sideEffect];

// ---------------------------------------------------------------------------
// 规则 1：私人研究面（默认拒绝）
// ---------------------------------------------------------------------------

/**
 * 私人研究边界：默认拒绝，仅在部署侧显式 opt-in（`exposeResearch` /
 * `LUOOME_EXPOSE_RESEARCH=true`）时放开。这张清单是唯一真源 —— `classify.ts` 的五类
 * 归类与两侧 surface 的拒绝判定都读它，不另造语义。
 */
export const privateResearchTools = [
  'run_local_selector_research',
  'list_research_topics',
  'create_research_hypothesis_version',
  'list_research_hypothesis_versions',
  'get_research_topic',
  'create_research_topic',
  'create_research_document',
  'import_local_research_document',
  'import_remote_research_document',
  'link_research_document',
  'archive_research_topic',
  'build_research_brief',
  'list_research_documents',
  'get_research_document',
  'search_research_documents',
  'get_research_embedding_status',
  'search_research_documents_hybrid',
  'rebuild_research_embeddings',
  'evaluate_research_embeddings',
  'get_stock_research_view',
  'get_research_vault_remote_sync_status',
  'sync_research_vault',
] as const;

const PRIVATE_RESEARCH_NAMES: ReadonlySet<string> = new Set(privateResearchTools);

/** 按名判定，不做子串匹配：`research_health_check` 这类新工具不会被误判。 */
export const isPrivateResearchTool = (name: string): boolean => PRIVATE_RESEARCH_NAMES.has(name);

// ---------------------------------------------------------------------------
// 规则 2：trade 硬卡
// ---------------------------------------------------------------------------

/**
 * trade 永不暴露的判定文案。放在共享层是为了让两侧 throw 的语义逐字一致：
 * 任何 surface 报出来的都是同一条约束，而不是各写一句「本 surface 不允许」。
 */
export const TRADE_EXPOSURE_MESSAGE =
  'LUOOME_EXPOSE_TRADE=true is not allowed: trade tools are never exposed ' +
  '(AGENTS.md「副作用与权限」硬约束)';

/** 环境开关判定：只有严格的 `'true'` 才算请求，空串/`1`/`TRUE` 都不算。 */
export const tradeExposureRequested = (...values: readonly (string | undefined)[]): boolean =>
  values.some((value) => value === 'true');

/**
 * 启动硬卡：任一来源（显式配置 env 或进程 env）请求 trade 暴露即抛错。
 * 调用方在创建目录、打开数据库之前调用它，把误配置挡在任何 IO 之前。
 */
export const assertTradeNeverExposed = (...values: readonly (string | undefined)[]): void => {
  if (tradeExposureRequested(...values)) throw new Error(TRADE_EXPOSURE_MESSAGE);
};

/** 声明层判定：`sideEffect` 是 trade，或任一 required capability 是 trade。 */
export const declaresTrade = (tool: JudgedTool): boolean =>
  tool.sideEffect === 'trade' || capabilitiesOf(tool).includes('trade');

// ---------------------------------------------------------------------------
// 规则 3/4/5：名字白名单、名字拒绝清单、能力满足
// ---------------------------------------------------------------------------

/** 白名单为 `undefined` 表示「不设名字闸门」（全收）；空集合表示「一个都不收」。 */
export const isNameAllowed = (name: string, allowlist: ReadonlySet<string> | undefined): boolean =>
  allowlist === undefined || allowlist.has(name);

export const isNameDenied = (name: string, denylist: ReadonlySet<string> | undefined): boolean =>
  denylist?.has(name) === true;

/** 声明的每个能力都必须被放行；缺一个就整体拒绝（不做能力降级）。 */
export const capabilitiesSatisfied = (
  required: readonly SideEffect[],
  allowed: ReadonlySet<SideEffect>,
): boolean => required.every((capability) => allowed.has(capability));

// ---------------------------------------------------------------------------
// 判定入口
// ---------------------------------------------------------------------------

/** surface 提供给判定的输入：全部是普通数据结构，可序列化、可比较、可缓存。 */
export interface ExposureCriteriaSpec {
  readonly allowedSideEffects: Iterable<SideEffect>;
  readonly allowlist?: Iterable<string> | undefined;
  readonly denylist?: Iterable<string> | undefined;
  /** 私人研究面开关；缺省 false（默认拒绝）。 */
  readonly exposeResearch?: boolean | undefined;
}

export interface ExposureCriteria {
  readonly allowedSideEffects: ReadonlySet<SideEffect>;
  readonly allowlist: ReadonlySet<string> | undefined;
  readonly denylist: ReadonlySet<string> | undefined;
  readonly exposeResearch: boolean;
}

/**
 * 归一化 criteria：接收数组/Set/任意 iterable，复制成独立的 Set 并冻结。
 *
 * 复制有两个目的：调用方后续改自己的配置数组不会影响已装配的 surface（暴露面快照必须
 * 冻结）；两侧 surface 也能直接比较 criteria 是否等价。
 */
export const exposureCriteria = (spec: ExposureCriteriaSpec): ExposureCriteria =>
  Object.freeze({
    allowedSideEffects: new Set(spec.allowedSideEffects),
    allowlist: spec.allowlist === undefined ? undefined : new Set(spec.allowlist),
    denylist: spec.denylist === undefined ? undefined : new Set(spec.denylist),
    exposeResearch: spec.exposeResearch === true,
  });

/** 拒绝原因，按判定顺序排列；两侧 surface 据此给出同一句话术。 */
export type ExposureDenial =
  | 'trade'
  | 'not-in-allowlist'
  | 'denylisted'
  | 'private-research'
  | 'capability-not-allowed';

export type ExposureVerdict =
  | { readonly exposed: true; readonly reason?: undefined }
  | { readonly exposed: false; readonly reason: ExposureDenial };

export interface ToolVerdict {
  readonly name: string;
  readonly verdict: ExposureVerdict;
}

/**
 * 单个工具的判定。
 *
 * 顺序刻意固定为 trade → 白名单 → 拒绝清单 → 私人研究 → 能力：
 * - trade 排第一：它不是配置项，任何放行集合都不该把它「解释成」其他原因；
 * - 白名单先于拒绝清单：没被点名就不必再解释拒绝清单；
 * - 私人研究先于能力：研究工具常带 write/external 组合能力，报「私人研究」比报
 *   「能力不足」更接近真实原因，且不影响最终是否暴露。
 */
export const judgeTool = (tool: JudgedTool, criteria: ExposureCriteria): ExposureVerdict => {
  if (declaresTrade(tool)) return { exposed: false, reason: 'trade' };
  if (!isNameAllowed(tool.name, criteria.allowlist))
    return { exposed: false, reason: 'not-in-allowlist' };
  if (isNameDenied(tool.name, criteria.denylist)) return { exposed: false, reason: 'denylisted' };
  if (!criteria.exposeResearch && isPrivateResearchTool(tool.name))
    return { exposed: false, reason: 'private-research' };
  if (!capabilitiesSatisfied(capabilitiesOf(tool), criteria.allowedSideEffects))
    return { exposed: false, reason: 'capability-not-allowed' };
  return { exposed: true };
};

/** 批量判定，与入参同序；用于对账与守卫报告「为什么没暴露」。 */
export const judgeTools = (
  tools: readonly JudgedTool[],
  criteria: ExposureCriteria,
): readonly ToolVerdict[] =>
  tools.map((tool) => ({ name: tool.name, verdict: judgeTool(tool, criteria) }));

/** 暴露选择：唯一的筛选入口，`judgeTool` 之外不允许再有第二套判定。 */
export const selectExposedTools = <T extends JudgedTool>(
  tools: readonly T[],
  criteria: ExposureCriteria,
): readonly T[] => tools.filter((tool) => judgeTool(tool, criteria).exposed);

// ---------------------------------------------------------------------------
// 装配期 fail-closed 断言（配置错误的工具名必须让装配失败，而不是静默过滤）
// ---------------------------------------------------------------------------

/** 面类型：只读面只收 read 声明，外部面只收 external 声明。 */
export type SelectionSurface = 'read' | 'external';

const SURFACE_DECLARATION: Readonly<
  Record<SelectionSurface, { readonly sideEffect: SideEffect; readonly word: string }>
> = {
  read: { sideEffect: 'read', word: 'read-only' },
  external: { sideEffect: 'external', word: 'external' },
};

export interface SelectionAssertionOptions {
  /** 报错里的配置主体，例如 `dsh-luoome read tool` / `market tool`。 */
  readonly label: string;
}

/**
 * 校验一份点名名单能在某个面上成立：名字必须存在，声明必须正好属于该面。
 *
 * 与 `selectExposedTools` 的分工：选择是「在合法的工具集里挑」，断言是「配置本身是否
 * 合法」。配置写错时直接拒绝装配，避免「注册了但永远不可达」的静默降级。
 */
export const assertSurfaceSelection = (
  names: Iterable<string>,
  tools: readonly JudgedTool[],
  surface: SelectionSurface,
  options: SelectionAssertionOptions,
): void => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const declaration = SURFACE_DECLARATION[surface];
  for (const name of names) {
    const tool = byName.get(name);
    if (tool === undefined) throw new Error(`Unknown configured ${options.label}: ${name}`);
    if (tool.sideEffect !== declaration.sideEffect)
      throw new Error(`Configured ${options.label} is not ${declaration.word}: ${name}`);
    if (capabilitiesOf(tool).some((capability) => capability !== declaration.sideEffect))
      throw new Error(`Configured ${options.label} requires unsupported capabilities: ${name}`);
  }
};
