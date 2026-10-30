// 工具暴露面五类归类（PRD REQ-M1-08）。
//
// 归类是推导出来的，不是手抄名单：主体只看 tool 自身的 `sideEffect`（以及 `trade`
// capability 这条硬约束），只有「按 sideEffect 会落进只读/可写面、但产品上不属于该面」
// 的工具才登记进显式例外名单。新增 tool 自动获得标签；改名/删名会让例外名单对不上，
// 由 `unknownExposureExceptions()` 暴露给守卫（T04）而不是静默腐烂。
//
// 五类之外没有第六类，也没有「悬空」：queue 面、chat 面按 H1、trade 专用人工入口
// 三种情况都是「不暴露但仍存在」，同归第 3 类 `queue-worker`（不暴露面，见该类的释义注释）。
// `retired` 只有一种含义：**已从 registry 摘除**。本轮 H1 不摘除任何工具，故该类为空。
import type { SideEffect } from '@luoome/core';
import { type JudgedTool, privateResearchTools } from './judge.js';

/**
 * 五类标签的稳定顺序（报告与守卫按此顺序输出）。
 *
 * 第 3 类 `queue-worker` 的语义是「**不暴露但仍存在**」，不是「队列专用」。三种情形同归本类：
 *
 * 1. queue 面：入队/出队工具在插件形态无生产者无消费者（H1 保留不暴露，不摘除）；
 * 2. chat 面：会话由 DSH 宿主承载，领域层 chat 工具没有插件入口（见例外名单）；
 * 3. trade：`record_decision_trade` 这类专用人工入口，永不暴露、不经 MCP，
 *    但按设计必须**保留**（`docs/ddd/dsh-luoome-plugin-detailed-design.md` §1
 *    「只能保留专用人工入口，不能因迁移改变分类」）。
 *
 * 所以进入第 3 类的成员都带 `reason`，把「为什么不暴露」和「为什么不能删」讲清楚；
 * 第 5 类 `retired` 只有一种含义——**已从 registry 摘除**，与上述三种情形互斥。
 */
export const EXPOSURE_CLASSES = [
  'read-surface',
  'write-surface',
  'queue-worker',
  'private-research',
  'retired',
] as const;

export type ExposureClass = (typeof EXPOSURE_CLASSES)[number];

export const EXPOSURE_CLASS_LABELS: Readonly<Record<ExposureClass, string>> = {
  'read-surface': '只读面',
  'write-surface': '可写面',
  // 第 3 类表达「不暴露但仍存在」，不是「队列专用」：涵盖 queue 面、chat 面与 trade 专用人工入口。
  'queue-worker': '不暴露面（保留）',
  'private-research': '私人研究 opt-in',
  // key 保留：只有真正待从 registry 摘除的工具才进这一类，本轮为空。
  retired: '废弃（从 registry 摘除）',
};

/** 归类需要的声明字段与判定层同一份结构（`exposure/judge.ts`），不另立第二套形状。 */
export type ExposableTool = JudgedTool;

export type ExposureSource = 'side-effect' | 'private-research-list' | 'exception';

export interface ExposureClassification {
  readonly name: string;
  readonly exposure: ExposureClass;
  readonly sideEffect: SideEffect;
  readonly requiredCapabilities: readonly SideEffect[];
  /** 标签来源：默认推导 / 复用私人研究拒绝清单 / 显式例外。 */
  readonly derivedFrom: ExposureSource;
  /** 为什么它不暴露；第 3 类（不暴露面）与例外条目都带原因，其余为 undefined。 */
  readonly reason: string | undefined;
}

export interface ExposureException {
  readonly name: string;
  readonly exposure: ExposureClass;
  readonly reason: string;
}

/**
 * 偏离默认暴露面的显式例外名单。
 *
 * 只收「按 sideEffect 该进只读/可写面，但插件形态下根本没有入口」的工具：
 *
 * - chat 面（H1）：DSH 对话由宿主会话承载，`DEFAULT_READ_TOOL_ALLOWLIST` 与
 *   `createProductionOperationPolicies()` 都不收录 chat-session 工具，所以它们在
 *   只读面/可写面永远不可达。继续挂在只读/可写面就是「既不暴露也不声明」的债，
 *   故按 H1 与 queue 面同归第 3 类（保留不暴露，不摘除）。
 *
 * 私人研究不在这里登记：它复用 `privateResearchTools` 这一份既有真源（见下）。
 * trade 也不在这里登记：它的 sideEffect 直接推导到第 3 类，原因随推导一起给出（见
 * `TRADE_MANUAL_ENTRY_REASON`），不需要在这里抄一份名字。
 */
export const EXPOSURE_EXCEPTIONS: readonly ExposureException[] = Object.freeze([
  {
    name: 'list_chat_sessions',
    exposure: 'queue-worker',
    reason: 'chat 面保留不暴露（H1）：会话列表由宿主会话承载，read allowlist 不收录',
  },
  {
    name: 'get_chat_session',
    exposure: 'queue-worker',
    reason: 'chat 面保留不暴露（H1）：历史消息由宿主回放，read allowlist 不收录',
  },
  {
    name: 'create_chat_session',
    exposure: 'queue-worker',
    reason: 'chat 面保留不暴露（H1）：插件形态不在领域层新建会话，无 operation policy',
  },
  {
    name: 'rename_chat_session',
    exposure: 'queue-worker',
    reason: 'chat 面保留不暴露（H1）：重命名无插件入口，无 operation policy',
  },
  {
    name: 'delete_chat_session',
    exposure: 'queue-worker',
    reason: 'chat 面保留不暴露（H1）：删除无插件入口，无 operation policy',
  },
  {
    name: 'append_chat_message',
    exposure: 'queue-worker',
    reason: 'chat 面保留不暴露（H1）：消息写入由宿主接管，领域 chat 表不再是真源',
  },
] satisfies readonly ExposureException[]);

/** 私人研究面：复用 packages/tools/src/exposure.ts 的既有拒绝清单，不另造语义。 */
const PRIVATE_RESEARCH_NAMES: ReadonlySet<string> = new Set(privateResearchTools);

const PRIVATE_RESEARCH_REASON =
  '私人研究面：默认拒绝，仅 exposeResearch / LUOOME_EXPOSE_RESEARCH=true 显式开启';

const EXCEPTION_BY_NAME: ReadonlyMap<string, ExposureException> = new Map(
  EXPOSURE_EXCEPTIONS.map((exception) => [exception.name, exception]),
);

/** trade 专用人工入口的不暴露原因；第 3 类与「队列」「chat」两类原因并列。 */
const TRADE_MANUAL_ENTRY_REASON =
  'trade 专用人工入口：永不暴露、不摘除、不经 MCP（AGENTS.md 硬约束 + `LUOOME_EXPOSE_TRADE=true` 启动硬卡；' +
  'trade 语义不可改记为 write，见 ddd §1）';

interface DeclarationClass {
  readonly exposure: ExposureClass;
  readonly reason: string | undefined;
}

/**
 * 默认面：由工具自身的声明推导。
 *
 * `trade` 与任何带 `trade` capability 的声明都落到第 3 类（不暴露面），**不是废弃面**：
 * trade 在任何 surface 都不可暴露（AGENTS.md 硬约束 + `LUOOME_EXPOSE_TRADE=true` 启动硬卡），
 * 插件形态没有 trade 面，把它留在可写面等于谎称它可达；但它按设计必须保留专用人工入口
 * （ddd §1「不能因迁移改变分类」），所以既不摘除也不标废弃。
 */
const classFromDeclaration = (tool: ExposableTool): DeclarationClass => {
  const capabilities = tool.requiredCapabilities ?? [tool.sideEffect];
  if (capabilities.includes('trade'))
    return { exposure: 'queue-worker', reason: TRADE_MANUAL_ENTRY_REASON };
  switch (tool.sideEffect) {
    case 'read':
      return { exposure: 'read-surface', reason: undefined };
    case 'write':
    case 'external':
      return { exposure: 'write-surface', reason: undefined };
    case 'queue':
      return { exposure: 'queue-worker', reason: undefined };
    case 'trade':
      return { exposure: 'queue-worker', reason: TRADE_MANUAL_ENTRY_REASON };
  }
};

/** 单个工具的标签。优先级：显式例外 > 私人研究拒绝清单 > 声明推导。 */
export const classifyTool = (tool: ExposableTool): ExposureClassification => {
  const capabilities = tool.requiredCapabilities ?? [tool.sideEffect];
  const exception = EXCEPTION_BY_NAME.get(tool.name);
  if (exception !== undefined)
    return {
      name: tool.name,
      exposure: exception.exposure,
      sideEffect: tool.sideEffect,
      requiredCapabilities: capabilities,
      derivedFrom: 'exception',
      reason: exception.reason,
    };
  if (PRIVATE_RESEARCH_NAMES.has(tool.name))
    return {
      name: tool.name,
      exposure: 'private-research',
      sideEffect: tool.sideEffect,
      requiredCapabilities: capabilities,
      derivedFrom: 'private-research-list',
      reason: PRIVATE_RESEARCH_REASON,
    };
  const declared = classFromDeclaration(tool);
  return {
    name: tool.name,
    exposure: declared.exposure,
    sideEffect: tool.sideEffect,
    requiredCapabilities: capabilities,
    derivedFrom: 'side-effect',
    reason: declared.reason,
  };
};

export interface ExposureClassificationResult {
  /** 与入参同序，每个工具恰好一条。 */
  readonly tools: readonly ExposureClassification[];
  readonly byName: ReadonlyMap<string, ExposureClassification>;
  readonly classes: Readonly<Record<ExposureClass, readonly ExposureClassification[]>>;
  readonly counts: Readonly<Record<ExposureClass, number>>;
}

export const classifyTools = (tools: readonly ExposableTool[]): ExposureClassificationResult => {
  const classified = tools.map(classifyTool);
  const of = (exposure: ExposureClass): readonly ExposureClassification[] =>
    classified.filter((item) => item.exposure === exposure);
  const classes: Readonly<Record<ExposureClass, readonly ExposureClassification[]>> = {
    'read-surface': of('read-surface'),
    'write-surface': of('write-surface'),
    'queue-worker': of('queue-worker'),
    'private-research': of('private-research'),
    retired: of('retired'),
  };
  const counts: Readonly<Record<ExposureClass, number>> = {
    'read-surface': classes['read-surface'].length,
    'write-surface': classes['write-surface'].length,
    'queue-worker': classes['queue-worker'].length,
    'private-research': classes['private-research'].length,
    retired: classes.retired.length,
  };
  return {
    tools: classified,
    byName: new Map(classified.map((item) => [item.name, item])),
    classes,
    counts,
  };
};

/** 按名查标签；不在分类结果里返回 undefined（调用方据此 fail-closed）。 */
export const exposureOf = (
  result: ExposureClassificationResult,
  name: string,
): ExposureClass | undefined => result.byName.get(name)?.exposure;

/** 某一类的全部工具名，保持 registry 顺序。 */
export const namesInExposure = (
  result: ExposureClassificationResult,
  exposure: ExposureClass,
): readonly string[] => result.classes[exposure].map((item) => item.name);

/**
 * 例外名单里对不上当前工具集的名字（改名/删除后的残留）。
 *
 * 守卫（T04）据此让例外名单不能悄悄失效；为空表示例外名单仍然有效。
 */
export const unknownExposureExceptions = (tools: readonly ExposableTool[]): readonly string[] => {
  const known = new Set(tools.map((tool) => tool.name));
  return EXPOSURE_EXCEPTIONS.filter((exception) => !known.has(exception.name)).map(
    (exception) => exception.name,
  );
};
