// Agent 确定性路由：关键词 + 本地上下文实体匹配的纯函数（设计 §4）。
// 不引入 LLM 路由调用；路由结果同时驱动场景选择与前端计划卡。

import { type AgentScenarioId, AgentScenarioIdSchema } from './scenarios.js';

export interface AgentRouteContext {
  readonly accountName?: string | null;
  readonly watchlistNames: readonly string[];
  readonly strategyNames: readonly string[];
  readonly alertPlanNames: readonly string[];
  readonly holdingStockIds: readonly string[];
}

export interface AgentRoute {
  readonly scenario: AgentScenarioId;
  /** 从消息与上下文匹配到的股票/账户/Strategy 等主体标识 */
  readonly subjects: string[];
  readonly needsAdvice: boolean;
  readonly involvesWrite: boolean;
  /** 回答问题缺少的必要标识；保守实现，识别不出就不强行标记 */
  readonly missingIdentifiers: string[];
}

const SCENARIO_KEYWORDS: Readonly<Record<Exclude<AgentScenarioId, 'general'>, readonly string[]>> =
  {
    review: ['复盘', '回顾', '准不准', '校准', '表现如何', '命中率', '效果如何'],
    portfolio: ['持仓', '成本', '仓位', '亏', '赚', '风险', '账户'],
    watch: ['盯盘', '预警', '提醒', '触发', '观察池', '监控'],
    research: ['研究', '分析', '调研', '基本面', '笔记', '资料'],
  };

const ADVICE_INTENT_WORDS = ['买', '卖', '调仓', '怎么办', '建议', '该不该', '要不要'];

const WRITE_INTENT_WORDS = [
  '创建',
  '新建',
  '添加',
  '修改',
  '更新',
  '删除',
  '归档',
  '加入',
  '订阅',
  '暂停',
  '发布',
];

/** 命中优先级：review > portfolio > watch > research > general。 */
const PRIORITY: readonly AgentScenarioId[] = [
  'review',
  'portfolio',
  'watch',
  'research',
  'general',
];

const containsAny = (message: string, words: readonly string[]): boolean =>
  words.some((word) => message.includes(word));

/** 持仓股票标识既匹配完整 stockId，也匹配其中连续 6 位数字代码（如 SZ300857 → 300857）。 */
const mentionsStockId = (message: string, stockId: string): boolean => {
  if (stockId.length > 0 && message.includes(stockId)) return true;
  const code = stockId.match(/\d{6}/)?.[0];
  return code !== undefined && message.includes(code);
};

export const routeAgentMessage = (message: string, context: AgentRouteContext): AgentRoute => {
  const subjects = new Set<string>();
  const matched = new Set<AgentScenarioId>();

  for (const [scenarioId, keywords] of Object.entries(SCENARIO_KEYWORDS)) {
    if (containsAny(message, keywords)) {
      matched.add(AgentScenarioIdSchema.parse(scenarioId));
    }
  }

  for (const name of context.watchlistNames) {
    if (name.length > 0 && message.includes(name)) {
      matched.add('watch');
      subjects.add(name);
    }
  }
  for (const name of context.alertPlanNames) {
    if (name.length > 0 && message.includes(name)) {
      matched.add('watch');
      subjects.add(name);
    }
  }
  for (const name of context.strategyNames) {
    if (name.length > 0 && message.includes(name)) {
      matched.add(matched.has('watch') ? 'watch' : 'research');
      subjects.add(name);
    }
  }
  for (const stockId of context.holdingStockIds) {
    if (mentionsStockId(message, stockId)) {
      matched.add('portfolio');
      subjects.add(stockId);
    }
  }
  if (
    context.accountName !== undefined &&
    context.accountName !== null &&
    context.accountName.length > 0 &&
    message.includes(context.accountName)
  ) {
    matched.add('portfolio');
    subjects.add(context.accountName);
  }

  const scenario = PRIORITY.find((id) => id !== 'general' && matched.has(id)) ?? 'general';

  return {
    scenario,
    subjects: [...subjects],
    needsAdvice: containsAny(message, ADVICE_INTENT_WORDS),
    involvesWrite: containsAny(message, WRITE_INTENT_WORDS),
    // 保守实现：无法可靠识别"指代了但解析不出"的股票时不强行标记，留给模型用 search_stocks 澄清。
    missingIdentifiers: [],
  };
};
