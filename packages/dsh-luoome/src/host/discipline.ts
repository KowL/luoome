// luoome 全局纪律约束（设计文档 `docs/ddd/luoome-dsh-transformation-detailed-design.md:131`）。
//
// 七条约束的原文来自 `packages/dsh-bridge/src/standalone-prompt.ts`（M2-02 随独立 MCP 形态删除，
// T11）。那个文件唯一的接线点是 `deploy/dsh/bootstrap.ts` 的 LEGACY MCP 引导，所以默认部署
// （`deploy/dsh/profile-seed.mjs` + dsh-luoome 插件）从来没挂载过这些约束。
//
// 为什么必须全局生效，而不是只写进随包技能：
// 技能段落只在模型判定触发该技能时才进入系统提示。用户不点技能、直接问「这票能买吗」时，
// 提示词里没有任何一条技能纪律 —— 但 `advice` 不等于 `trade`、不得声称「已买入」、
// `confidence` 不是概率、先给反证再给结论，这些是不依赖技能触发的产品红线。
// 因此它们是插件级的全局 section（order -10000，排在身份/persona/工具说明之前），
// 每次装配无条件生效。约束文本逐字保留，不改写、不精简：它们是评审口径，不是文案。
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

/**
 * 七条约束的逐字原文。来自 `packages/dsh-bridge/src/standalone-prompt.ts`
 * （M2-02 删除），`discipline.test.ts` 用同一份常量做对账，防止后续编辑悄悄改写红线。
 */
export const LUOOME_DISCIPLINE_CONSTRAINTS: readonly string[] = [
  '谈具体标的时先取事实再下结论，不要凭记忆报价格、涨跌幅或财报数字；取不到就直说取不到。',
  '`advice` 不等于 `trade`；没有下单能力，永远不说「已买入/已卖出」；给出的是带条件的建议与观察计划。',
  '引用建议时保留反证、风险、免责声明和有效期；`confidence` 是模型信心度，不是概率，更不是确定性。',
  '区分 `StrategySignal`、`Advice` 和成交记录，不要把信号说成建议，也不要把建议说成已执行。',
  '讨论「要不要买」时，先给反面证据，再给结论，最后给可证伪的观察条件（价位、量能、失效条件）。',
  '侧栏面板与工具是同一份数据；聊天里读到的，面板会同步显示。',
  'luoome 的批处理由 DSH 定时任务调度：涉及 luoome 定时任务时先读 luoome-batch 技能，不要自己起常驻调度进程或用 shell 轮询。',
];

export const LUOOME_DISCIPLINE_SECTION = 'luoome:discipline';

/**
 * section 排序：远早于 `HARNESS_IDENTITY`(-1000)、persona(0) 与工具说明(1000+)，
 * 让纪律成为模型读到的第一段产品约束。
 */
export const LUOOME_DISCIPLINE_ORDER = -10000;

/** 注册只需要目标服务上的 `section()`；结构化类型便于用真实 registry 或替身测试。 */
export interface DisciplineService {
  section(section: PromptSection): () => void;
}

export interface DisciplineContext {
  readonly systemPrompt: DisciplineService;
}

/** 编号列表：`1. …` / `2. …`，序号由数组顺序决定，便于测试逐条核对。 */
export const formatDisciplineText = (
  constraints: readonly string[] = LUOOME_DISCIPLINE_CONSTRAINTS,
) => constraints.map((line, index) => `${index + 1}. ${line}`).join('\n');

/**
 * 把纪律段注册进 DSH system prompt registry，返回幂等的整体 disposer（与
 * `registerBundledSkills` 同一形状：由插件 apply 包进 `ctx.effect`）。
 *
 * `systemPrompt.section()` 注册的是 scope layer 上的条目，随该服务的上下文撤销，**不随**
 * 调用方 fiber 撤销；所以这里显式返回它的 disposer，由插件 fiber 的 effect 负责调用。
 * 服务缺失或注册失败 fail-loud：默认部署不能在没有红线的情况下静默启动。
 */
export const registerDiscipline = (ctx: DisciplineContext): (() => void) => {
  const service = ctx.systemPrompt;
  if (service === undefined || typeof service.section !== 'function')
    throw new Error('dsh-luoome 插件需要 DSH systemPrompt 服务（section）；宿主未提供时拒绝装配');
  let dispose: () => void;
  try {
    dispose = service.section({
      name: LUOOME_DISCIPLINE_SECTION,
      order: LUOOME_DISCIPLINE_ORDER,
      text: formatDisciplineText(),
      // 纪律文本里的 `{{`/`}}` 与 `$` 一律按字面保留，不做提示词变量插值。
      interpolate: false,
    });
  } catch (error) {
    throw new Error(
      `dsh-luoome 纪律段注册失败: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
};
