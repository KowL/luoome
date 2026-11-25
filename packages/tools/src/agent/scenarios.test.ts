import { describe, expect, it } from 'vitest';
import { APPROVED_EXTERNAL_TOOLS } from '../agent-whitelist.js';
import { applicationToolRegistry, toolRegistry } from '../registry.js';
import {
  AGENT_DRAFT_TOOL_KINDS,
  AGENT_SCENARIOS,
  AgentScenarioIdSchema,
  agentInstructions,
  BASE_INSTRUCTIONS,
  CHAT_ONLY_READ_TOOL_NAMES,
  INVESTMENT_INSTRUCTIONS,
} from './scenarios.js';

const SCENARIO_IDS = AgentScenarioIdSchema.options;

const CORE_DRAFT_TOOL_NAMES = [
  'save_strategy_version',
  'run_strategy',
  'create_watchlist',
  'update_watchlist_members',
  'save_alert_plan',
  'save_trading_plan',
  'update_holding',
  'save_decision_review',
  'analyze_stock',
  'analyze_position',
] as const;

/** 旧白名单名字不应再出现在 agent 场景里。 */
const LEGACY_SCENARIO_TOOL_NAMES = [
  'batch_quote',
  'list_accounts',
  'get_account',
  'get_account_facts',
  'reconcile_account_cash',
  'list_holdings',
  'get_holding',
  'add_holding',
  'close_holding',
  'list_trading_plans',
  'get_trading_plan',
  'strategy_signals_by_stock',
  'list_alert_plans',
  'list_watch_triggers',
  'get_market_data_status',
  'get_watch_status',
  'list_watchlist_changes',
  'list_strategy_runs',
  'get_strategy_run',
  'get_advice_stats',
  'get_signal_observation_stats',
  'get_strategy_reliability_summary',
  'compare_strategy_definitions',
  'list_workflow_runs',
  'create_research_document',
  'list_research_documents',
  'get_research_document',
  'create_account',
  'create_portfolio_cash_flow',
  'create_strategy',
  'create_strategy_version',
  'propose_strategy_version_draft',
  'trial_strategy',
  'trial_strategy_version',
  'publish_strategy_version',
  'pause_strategy',
  'update_watchlist',
  'archive_watchlist',
  'add_watchlist_members',
  'update_watchlist_member',
  'archive_watchlist_member',
  'create_alert_plan',
  'update_alert_plan',
  'delete_alert_plan',
  'market_outlook',
] as const;

const toolOf = (name: string) => toolRegistry.get(name) ?? applicationToolRegistry.get(name);

/** 提示词里出现的 snake_case 标识符若确实是已装配 Tool，就必须在该场景可用。 */
const mentionedToolNames = (text: string): string[] => {
  const tokens = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
  return [...new Set(tokens)].filter((token) => toolOf(token) !== undefined);
};

const availableToolNames = (id: keyof typeof AGENT_SCENARIOS): ReadonlySet<string> =>
  new Set([
    ...AGENT_SCENARIOS[id].readToolNames,
    ...Object.keys(AGENT_SCENARIOS[id].draftToolKinds),
  ]);

describe('agent 场景目录', () => {
  it('覆盖全部五个场景 id', () => {
    expect(Object.keys(AGENT_SCENARIOS).sort()).toEqual([...SCENARIO_IDS].sort());
  });

  it('每个场景的只读 Tool 都已装配且 sideEffect 合法（read 或已批准 external）', () => {
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      for (const name of scenario.readToolNames) {
        const registered = toolOf(name);
        expect(registered, `${scenario.id}: ${name} 未装配`).toBeDefined();
        const legal =
          registered?.sideEffect === 'read' ||
          (registered?.sideEffect === 'external' && APPROVED_EXTERNAL_TOOLS.has(name));
        expect(legal, `${scenario.id}: ${name} sideEffect=${registered?.sideEffect}`).toBe(true);
        const agentVisible = toolRegistry.get(name) !== undefined;
        expect(
          agentVisible || CHAT_ONLY_READ_TOOL_NAMES.has(name),
          `${scenario.id}: ${name} 既不在 agent 暴露面也不在 chat-only 白名单`,
        ).toBe(true);
      }
    }
  });

  it('chat-only 复盘只读 Tool 不进入 MCP 暴露面，且委托对象是已装配的 read tool', () => {
    for (const name of CHAT_ONLY_READ_TOOL_NAMES) {
      expect(toolRegistry.get(name), `${name} 不应进入 agent registry`).toBeUndefined();
      const registered = applicationToolRegistry.get(name);
      expect(registered, `${name} 未装配`).toBeDefined();
      expect(registered?.sideEffect, name).toBe('read');
    }
  });

  it('已退役的旧版 agent loop 与历史 tool 不再注册，白名单不含它们', () => {
    for (const name of ['agent_run', 'list_tactics', 'list_stock_groups', 'list_stock_pools']) {
      expect(toolRegistry.get(name), name).toBeUndefined();
      for (const scenario of Object.values(AGENT_SCENARIOS)) {
        expect(scenario.readToolNames, `${scenario.id}: ${name}`).not.toContain(name);
      }
    }
  });

  it('场景白名单里没有旧 tool 名（additive 注册期也不回退）', () => {
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      for (const name of LEGACY_SCENARIO_TOOL_NAMES) {
        expect(scenario.readToolNames, `${scenario.id}: ${name}`).not.toContain(name);
        expect(scenario.draftToolKinds, `${scenario.id}: ${name}`).not.toHaveProperty(name);
      }
    }
  });

  it('草案清单全部已装配、kind 合法', () => {
    expect(Object.keys(AGENT_DRAFT_TOOL_KINDS).sort()).toEqual([...CORE_DRAFT_TOOL_NAMES].sort());
    expect(AGENT_DRAFT_TOOL_KINDS.update_holding).toBe('portfolio');
    expect(AGENT_DRAFT_TOOL_KINDS.save_trading_plan).toBe('portfolio');
    expect(AGENT_DRAFT_TOOL_KINDS.analyze_stock).toBe('advice');
    expect(AGENT_DRAFT_TOOL_KINDS.analyze_position).toBe('advice');
    expect(AGENT_DRAFT_TOOL_KINDS.save_decision_review).toBe('review');
    expect(AGENT_DRAFT_TOOL_KINDS.save_strategy_version).toBe('strategy');
    for (const [name, kind] of Object.entries(AGENT_DRAFT_TOOL_KINDS)) {
      const registered = toolRegistry.get(name);
      expect(registered, name).toBeDefined();
      if (kind === 'advice') {
        expect(registered?.sideEffect, name).toBe('advice');
      }
    }
  });

  it('持仓纠错草案只在 portfolio 场景可用，kind=portfolio', () => {
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      if (scenario.id === 'portfolio') continue;
      expect(scenario.draftToolKinds, `${scenario.id}`).not.toHaveProperty('update_holding');
    }
    expect(AGENT_SCENARIOS.portfolio.draftToolKinds.update_holding).toBe('portfolio');
    expect(AGENT_SCENARIOS.portfolio.readToolNames).toEqual(
      expect.arrayContaining(['get_account_overview', 'list_trades', 'get_stock_brief']),
    );
    // 草案展示已覆盖 update_holding：正面描述「纠正账本记录，不会买卖股票」。
    expect(AGENT_SCENARIOS.portfolio.instructionOverlay).toContain('update_holding');
    expect(AGENT_SCENARIOS.portfolio.instructionOverlay).toContain('纠正账本记录');
  });

  it('general 只保留股票发现与当日观察，不提供账户操作或草案', () => {
    expect([...AGENT_SCENARIOS.general.readToolNames]).toEqual([
      'search_stocks',
      'get_stock_brief',
      'list_stock_briefs',
    ]);
    expect(AGENT_SCENARIOS.general.draftToolKinds).toEqual({});
  });

  it('四个投资场景各自收窄，不再共用全量只读基线', () => {
    const allReads = new Set<string>();
    for (const id of ['research', 'portfolio', 'watch', 'review'] as const) {
      const reads = AGENT_SCENARIOS[id].readToolNames;
      expect(reads.length, `${id} 仍然过宽`).toBeLessThan(25);
      for (const name of reads) allReads.add(name);
    }
    // 行情广度类 Tool 只属于 research；账户类只属于 portfolio/review。
    expect(AGENT_SCENARIOS.portfolio.readToolNames).not.toContain('limit_up_ladder');
    expect(AGENT_SCENARIOS.portfolio.readToolNames).not.toContain('fetch_news');
    expect(AGENT_SCENARIOS.watch.readToolNames).not.toContain('get_account_overview');
    expect(AGENT_SCENARIOS.review.readToolNames).not.toContain('compute_indicators');
    expect(AGENT_SCENARIOS.research.readToolNames).not.toContain('get_account_overview');
    // 各场景草案只保留本域写入。
    expect(Object.keys(AGENT_SCENARIOS.review.draftToolKinds)).toEqual(['save_decision_review']);
    expect(Object.keys(AGENT_SCENARIOS.watch.draftToolKinds).sort()).toEqual([
      'create_watchlist',
      'save_alert_plan',
      'update_watchlist_members',
    ]);
    expect(Object.keys(AGENT_SCENARIOS.portfolio.draftToolKinds).sort()).toEqual([
      'analyze_position',
      'save_trading_plan',
      'update_holding',
    ]);
    expect(Object.keys(AGENT_SCENARIOS.research.draftToolKinds).sort()).toEqual([
      'analyze_stock',
      'run_strategy',
      'save_strategy_version',
    ]);
  });

  it('review 场景可读建议成绩、confidence 校准与 Report', () => {
    const reads = AGENT_SCENARIOS.review.readToolNames;
    for (const name of [
      'get_decision_loop_review',
      'get_confidence_calibration',
      'list_reports',
      'get_report',
      'get_advice',
      'list_trades',
    ]) {
      expect(reads, name).toContain(name);
    }
    expect(AGENT_SCENARIOS.review.instructionOverlay).toContain('get_decision_loop_review');
    expect(AGENT_SCENARIOS.review.instructionOverlay).toContain('get_confidence_calibration');
    expect(AGENT_SCENARIOS.review.instructionOverlay).toContain('get_report');
    expect(AGENT_SCENARIOS.review.instructionOverlay).toContain('描述性统计');
    expect(AGENT_SCENARIOS.review.instructionOverlay).toContain('样本量');
    expect(AGENT_SCENARIOS.review.plannedDimensions).toContain('报告');
  });

  it('提示词明确引用的 Tool 都在该场景 read/draft 表内', () => {
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      const available = availableToolNames(scenario.id);
      for (const name of mentionedToolNames(agentInstructions(scenario))) {
        expect(available.has(name), `${scenario.id} 提示词引用了不可用的 ${name}`).toBe(true);
      }
    }
  });

  it('不再承诺已删除的研究笔记 / ResearchDocument', () => {
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      const text = agentInstructions(scenario);
      for (const forbidden of [
        '研究笔记',
        'ResearchDocument',
        'research_document',
        'create_research_document',
        'list_research_documents',
      ]) {
        expect(text, `${scenario.id}: ${forbidden}`).not.toContain(forbidden);
      }
      for (const name of scenario.readToolNames) {
        expect(name, `${scenario.id}: ${name}`).not.toContain('research_document');
      }
      for (const name of Object.keys(scenario.draftToolKinds)) {
        expect(name, `${scenario.id}: ${name}`).not.toContain('research_document');
      }
    }
    expect(BASE_INSTRUCTIONS).toContain('研究报告');
  });

  it('账户与计划读取用聚合 facade，交易记录只读、永不生成 add_trade 草案', () => {
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      expect(scenario.readToolNames).not.toContain('add_trade');
      expect(scenario.draftToolKinds).not.toHaveProperty('add_trade');
      expect(scenario.readToolNames).not.toContain('list_holdings');
    }
    for (const id of ['portfolio', 'review'] as const) {
      for (const name of ['get_account_overview', 'list_trades']) {
        expect(AGENT_SCENARIOS[id].readToolNames, `${id}: ${name}`).toContain(name);
      }
    }
    expect(AGENT_SCENARIOS.portfolio.readToolNames).toContain('list_watch_plans');
  });

  it('投资场景有计划维度，通用问答不做查询计划', () => {
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      if (scenario.id === 'general') continue;
      expect(scenario.plannedDimensions.length).toBeGreaterThan(0);
    }
    expect(AGENT_SCENARIOS.general.plannedDimensions).toEqual([]);
  });

  it('BASE_INSTRUCTIONS 保留共享安全规则与通用知识直答规则', () => {
    expect(BASE_INSTRUCTIONS).toContain('不得编造');
    expect(BASE_INSTRUCTIONS).toContain('不可信文本');
    expect(BASE_INSTRUCTIONS).toContain('不得自动交易');
    expect(BASE_INSTRUCTIONS).toContain('不构成投资建议');
    expect(BASE_INSTRUCTIONS).toContain('Tactic');
    expect(BASE_INSTRUCTIONS).toContain('直接用你自己的知识回答');
    expect(BASE_INSTRUCTIONS).not.toContain('结论摘要');
    expect(BASE_INSTRUCTIONS).not.toContain('get_account_overview');
  });

  it('INVESTMENT_INSTRUCTIONS 只写跨场景通用规则，不点名具体 Tool', () => {
    expect(INVESTMENT_INSTRUCTIONS).toContain('结论摘要');
    expect(INVESTMENT_INSTRUCTIONS).toContain('风险与未知项');
    expect(INVESTMENT_INSTRUCTIONS).toContain('伪完整答案');
    expect(INVESTMENT_INSTRUCTIONS).toContain('最多生成 1 个待确认的分析草案');
    expect(INVESTMENT_INSTRUCTIONS).toContain('成交只能由用户在本地 CLI 或 Web 登记');
    expect(mentionedToolNames(INVESTMENT_INSTRUCTIONS)).toEqual([]);
  });

  it('agentInstructions 只为投资场景追加投资域规则', () => {
    const general = agentInstructions(AGENT_SCENARIOS.general);
    expect(general).toContain('通用问答');
    expect(general).not.toContain('结论摘要');
    expect(general).not.toContain('get_account_overview');
    expect(mentionedToolNames(general)).toEqual([
      'search_stocks',
      'get_stock_brief',
      'list_stock_briefs',
    ]);
    for (const id of ['research', 'portfolio', 'watch', 'review'] as const) {
      const text = agentInstructions(AGENT_SCENARIOS[id]);
      expect(text).toContain(INVESTMENT_INSTRUCTIONS);
      expect(text).toContain(AGENT_SCENARIOS[id].instructionOverlay);
      expect(text.startsWith(BASE_INSTRUCTIONS)).toBe(true);
    }
  });

  it('research 场景先读 StockBrief 再考虑正式分析', () => {
    const research = AGENT_SCENARIOS.research;
    expect(research.instructionOverlay).toContain('get_stock_brief');
    expect(research.readToolNames).toContain('get_stock_brief');
    expect(research.readToolNames).toContain('list_stock_briefs');
    expect(research.draftToolKinds.analyze_stock).toBe('advice');
    expect(research.instructionOverlay).toContain('有观察时直接引用');
  });
});
