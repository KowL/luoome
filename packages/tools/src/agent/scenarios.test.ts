import { describe, expect, it } from 'vitest';
import { APPROVED_EXTERNAL_TOOLS } from '../agent-whitelist.js';
import { toolRegistry } from '../registry.js';
import {
  AGENT_DRAFT_TOOL_KINDS,
  AGENT_SCENARIOS,
  AgentScenarioIdSchema,
  agentInstructions,
  BASE_INSTRUCTIONS,
  INVESTMENT_INSTRUCTIONS,
} from './scenarios.js';

const SCENARIO_IDS = AgentScenarioIdSchema.options;

/** S4.1c：核心 Agent Tool（registry 收敛前旧名仍注册，但 agent 白名单只用这些）。 */
const CORE_READ_TOOL_NAMES = [
  'search_stocks',
  'get_stock_market_view',
  'get_intraday_summary',
  'fetch_quote',
  'fetch_index_quotes',
  'fetch_sector_quotes',
  'compute_indicators',
  'limit_up_ladder',
  'dragon_tiger_list',
  'northbound_flow',
  'fetch_news',
  'list_watchlists',
  'get_watchlist',
  'list_strategies',
  'get_strategy',
  'get_strategy_dsl_catalog',
  'validate_strategy_definition',
  'get_strategy_signals',
  'get_account_overview',
  'get_account_performance',
  'list_trades',
  'get_advice',
  'get_stock_brief',
  'list_stock_briefs',
  'list_watch_plans',
] as const;

const CORE_DRAFT_TOOL_NAMES = [
  'save_strategy_version',
  'run_strategy',
  'create_watchlist',
  'update_watchlist_members',
  'save_alert_plan',
  'save_trading_plan',
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
  'list_research_documents',
  'get_research_document',
  'get_market_data_status',
  'get_watch_status',
  'list_watchlist_changes',
  'list_strategy_runs',
  'get_strategy_run',
  'get_advice_stats',
  'get_decision_loop_review',
  'get_confidence_calibration',
  'get_signal_observation_stats',
  'get_strategy_reliability_summary',
  'compare_strategy_definitions',
  'list_workflow_runs',
  'list_reports',
  'get_report',
  'create_research_document',
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

describe('agent 场景目录', () => {
  it('覆盖全部五个场景 id', () => {
    expect(Object.keys(AGENT_SCENARIOS).sort()).toEqual([...SCENARIO_IDS].sort());
  });

  it('每个场景只使用核心 Tool 的只读子集，且全部已注册、sideEffect 合法', () => {
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      expect([...scenario.readToolNames]).toEqual([...CORE_READ_TOOL_NAMES]);
      for (const name of scenario.readToolNames) {
        const registered = toolRegistry.get(name);
        expect(registered, `${scenario.id}: ${name} 未注册`).toBeDefined();
        const legal =
          registered?.sideEffect === 'read' ||
          (registered?.sideEffect === 'external' && APPROVED_EXTERNAL_TOOLS.has(name));
        expect(legal, `${scenario.id}: ${name} sideEffect=${registered?.sideEffect}`).toBe(true);
      }
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

  it('草案清单全部已注册、kind 合法；场景按域收窄', () => {
    expect(Object.keys(AGENT_DRAFT_TOOL_KINDS).sort()).toEqual([...CORE_DRAFT_TOOL_NAMES].sort());
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
    expect(AGENT_SCENARIOS.general.draftToolKinds).toBe(AGENT_DRAFT_TOOL_KINDS);
    expect(AGENT_SCENARIOS.research.draftToolKinds).not.toHaveProperty('save_decision_review');
    expect(AGENT_SCENARIOS.review.draftToolKinds.save_decision_review).toBe('review');
    expect(AGENT_SCENARIOS.review.draftToolKinds).not.toHaveProperty('save_trading_plan');
    for (const id of ['portfolio', 'watch'] as const) {
      expect(AGENT_SCENARIOS[id].draftToolKinds).not.toHaveProperty('save_decision_review');
      expect(AGENT_SCENARIOS[id].draftToolKinds).not.toHaveProperty('save_research_document');
    }
  });

  it('账户与计划读取用聚合 facade，交易记录只读、永不生成 add_trade 草案', () => {
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      for (const name of [
        'get_account_overview',
        'get_account_performance',
        'list_trades',
        'list_watch_plans',
        'get_advice',
      ]) {
        expect(scenario.readToolNames).toContain(name);
      }
      expect(scenario.readToolNames).not.toContain('add_trade');
      expect(scenario.draftToolKinds).not.toHaveProperty('add_trade');
      expect(scenario.readToolNames).not.toContain('list_holdings');
    }
  });

  it('四类场景共享同一只读基线，general 白名单相同', () => {
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      expect([...scenario.readToolNames]).toEqual([...CORE_READ_TOOL_NAMES]);
    }
    expect([...AGENT_SCENARIOS.general.readToolNames]).toEqual([...CORE_READ_TOOL_NAMES]);
  });

  it('review 覆写含小样本相关性约束，投资场景有计划维度', () => {
    expect(AGENT_SCENARIOS.review.instructionOverlay).toContain('描述性统计');
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      if (scenario.id === 'general') continue;
      expect(scenario.plannedDimensions.length).toBeGreaterThan(0);
    }
    // 通用问答不做确定性查询计划。
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

  it('INVESTMENT_INSTRUCTIONS 保留投资域约束：五段回答、工具入口与建议边界', () => {
    expect(INVESTMENT_INSTRUCTIONS).toContain('结论摘要');
    expect(INVESTMENT_INSTRUCTIONS).toContain('风险与未知项');
    expect(INVESTMENT_INSTRUCTIONS).toContain('伪完整答案');
    expect(INVESTMENT_INSTRUCTIONS).toContain('get_account_overview');
    expect(INVESTMENT_INSTRUCTIONS).toContain('update_holding');
    expect(INVESTMENT_INSTRUCTIONS).toContain('save_strategy_version');
    expect(INVESTMENT_INSTRUCTIONS).toContain('list_watch_plans');
    expect(INVESTMENT_INSTRUCTIONS).toContain('get_stock_brief');
    expect(INVESTMENT_INSTRUCTIONS).toContain('不得把规则观察描述成 AI 研究结论');
    expect(INVESTMENT_INSTRUCTIONS).toContain('最多生成 1 个 advice 草案');
    expect(INVESTMENT_INSTRUCTIONS).not.toContain('trial_strategy');
    expect(INVESTMENT_INSTRUCTIONS).not.toContain('add_watchlist_members');
  });

  it('agentInstructions 只为投资场景追加投资域规则', () => {
    const general = agentInstructions(AGENT_SCENARIOS.general);
    expect(general).toContain('通用问答');
    expect(general).not.toContain('结论摘要');
    expect(general).not.toContain('get_account_overview');
    for (const id of ['research', 'portfolio', 'watch', 'review'] as const) {
      const text = agentInstructions(AGENT_SCENARIOS[id]);
      expect(text).toContain(INVESTMENT_INSTRUCTIONS);
      expect(text).toContain(AGENT_SCENARIOS[id].instructionOverlay);
      expect(text.startsWith(BASE_INSTRUCTIONS)).toBe(true);
    }
  });
});
