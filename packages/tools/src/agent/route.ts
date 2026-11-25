// Agent 确定性路由：关键词 + 本地上下文实体匹配的纯函数（设计 §4）。
// 不引入 LLM 路由调用；路由结果同时驱动场景选择与前端计划卡。

import type { AgentScenarioId } from './scenarios.js';

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

/**
 * 场景关键词只收投资域名词，不收「分析」「研究」「资料」这类通用动词：
 * 否则「分析这段代码」会被误判成个股研究并把行情工具塞进通用问答。
 */
const SCENARIO_KEYWORDS: Readonly<Record<Exclude<AgentScenarioId, 'general'>, readonly string[]>> =
  {
    review: [
      '复盘',
      '准不准',
      '校准',
      '命中率',
      '胜率',
      '建议成绩',
      '建议表现',
      '建议效果',
      '决策质量',
    ],
    portfolio: [
      '持仓',
      '成本',
      '仓位',
      '盈亏',
      '亏',
      '赚',
      '账户',
      '开户',
      '现金',
      '入金',
      '出金',
      '转入',
      '转出',
      '流水',
      '对账',
      '平仓',
      '交易计划',
      '集中度',
      '收益率',
      '可用资金',
      '加仓',
      '减仓',
      '建仓',
      '止损',
      '止盈',
      '持有',
    ],
    watch: [
      '盯盘',
      '预警',
      '观察池',
      '观察清单',
      '自选股',
      '关注列表',
      '监控',
      '触发',
      '条件单',
      '盘中提醒',
      '提醒规则',
    ],
    research: [
      '股票',
      '个股',
      '行情',
      '走势',
      'k线',
      '估值',
      '财报',
      '基本面',
      '板块',
      '涨停',
      '龙虎榜',
      '北向',
      '概念股',
      '新股',
      '转债',
      '新闻',
      '公告',
      '研报',
      '策略',
      '选股',
      '目标价',
    ],
  };

/** 英文领域名词同样只表达投资域，不表达通用分析意图。 */
const SCENARIO_KEYWORDS_EN: Readonly<
  Record<Exclude<AgentScenarioId, 'general'>, readonly string[]>
> = {
  review: [],
  portfolio: ['portfolio'],
  watch: ['watchlist'],
  research: ['stock'],
};

/** 只有带上标的类名词时，「该不该买」才算投资意图，避免「要不要买空气炸锅」被路由。 */
const INVESTMENT_SUBJECT_HINTS = ['股', '票', '仓', '债', '基金', 'etf', '标的'];

/** 「该不该买」这类意图只在用户明确说的是买卖时才进入个股研究。 */
const INVESTMENT_INTENT_PATTERNS: readonly RegExp[] = [
  /该不该[买卖]/,
  /要不要[买卖]/,
  /能不能[买卖]/,
  /买不买/,
  /卖不卖/,
  /值不值得[买卖]/,
];

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
  '登记',
  '录入',
  '记录',
  '纠错',
  '修正',
  '开户',
  '平仓',
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

const containsEnglish = (message: string, words: readonly string[]): boolean =>
  words.some((word) => new RegExp(`\\b${word}\\b`, 'i').test(message));

/** 持仓股票标识既匹配完整 stockId，也匹配其中连续 6 位数字代码（如 SZ300857 → 300857）。 */
const mentionsStockId = (message: string, stockId: string): boolean => {
  if (stockId.length > 0 && message.includes(stockId)) return true;
  const code = stockId.match(/\d{6}/)?.[0];
  return code !== undefined && message.includes(code);
};

/** 只给代码的个股问题（如「300857 怎么样」）没有账户实体可匹配时仍按个股研究处理。 */
const mentionsStockCode = (message: string): boolean =>
  /(?<![0-9A-Za-z])(?:SH|SZ|BJ)?\d{6}(?![0-9])/i.test(message);

export const routeAgentMessage = (message: string, context: AgentRouteContext): AgentRoute => {
  const subjects = new Set<string>();
  const matched = new Set<AgentScenarioId>();
  const lower = message.toLowerCase();

  for (const [id, keywords] of Object.entries(SCENARIO_KEYWORDS) as [
    Exclude<AgentScenarioId, 'general'>,
    readonly string[],
  ][]) {
    if (containsAny(lower, keywords) || containsEnglish(lower, SCENARIO_KEYWORDS_EN[id])) {
      matched.add(id);
    }
  }
  if (
    containsAny(lower, INVESTMENT_SUBJECT_HINTS) &&
    INVESTMENT_INTENT_PATTERNS.some((pattern) => pattern.test(lower))
  ) {
    matched.add('research');
  }
  if (mentionsStockCode(message)) matched.add('research');

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
    needsAdvice: containsAny(lower, ADVICE_INTENT_WORDS),
    involvesWrite: containsAny(lower, WRITE_INTENT_WORDS),
    // 保守实现：无法可靠识别"指代了但解析不出"的股票时不强行标记，留给模型用 search_stocks 澄清。
    missingIdentifiers: [],
  };
};
