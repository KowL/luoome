import type { Context } from '@deepseek-ai/cordis';
// systemPrompt 段的类型增强由 DSH 的 agent 插件声明，import 这个包只为拿类型。
import type {} from '@deepseek-ai/dsh-agent';

/**
 * 独立 DSH 的系统提示词纪律（设计文档 §4.4）。
 * 保留原文，便于评审逐条核对，不做二次解释。
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
export const LUOOME_DISCIPLINE_ORDER = -10000;

export const name = 'luoome-discipline';
export const inject = ['systemPrompt'];

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: LUOOME_DISCIPLINE_SECTION,
    order: LUOOME_DISCIPLINE_ORDER,
    text: LUOOME_DISCIPLINE_CONSTRAINTS.map((line, index) => `${index + 1}. ${line}`).join('\n'),
    interpolate: false,
  });
}
