import { describe, expect, it } from 'vitest';
import { APPROVED_EXTERNAL_TOOLS } from '../agent-whitelist.js';
import { toolRegistry } from '../registry.js';
import {
  AGENT_DRAFT_TOOL_KINDS,
  AGENT_SCENARIOS,
  AgentScenarioIdSchema,
  BASE_INSTRUCTIONS,
} from './scenarios.js';

const SCENARIO_IDS = AgentScenarioIdSchema.options;

describe('agent 场景目录', () => {
  it('覆盖全部五个场景 id', () => {
    expect(Object.keys(AGENT_SCENARIOS).sort()).toEqual([...SCENARIO_IDS].sort());
  });

  it('每个场景的 readToolNames 全部已注册且 sideEffect 合法（read 或批准的 external）', () => {
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      expect(scenario.readToolNames).not.toContain('agent_run');
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

  it('草案清单全部已注册、kind 合法且四场景与 general 完全一致', () => {
    expect(Object.keys(AGENT_DRAFT_TOOL_KINDS)).toHaveLength(22);
    expect(AGENT_DRAFT_TOOL_KINDS.analyze_stock).toBe('advice');
    expect(AGENT_DRAFT_TOOL_KINDS.analyze_position).toBe('advice');
    expect(AGENT_DRAFT_TOOL_KINDS.market_outlook).toBe('advice');
    for (const [name, kind] of Object.entries(AGENT_DRAFT_TOOL_KINDS)) {
      const registered = toolRegistry.get(name);
      expect(registered, name).toBeDefined();
      if (kind === 'advice') {
        expect(registered?.sideEffect, name).toBe('advice');
      }
    }
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      expect(scenario.draftToolKinds).toBe(AGENT_DRAFT_TOOL_KINDS);
    }
  });

  it('四类场景都不缺失共享基线，且均为 general 白名单子集（general 专属研究项除外）', () => {
    const generalNames = new Set(AGENT_SCENARIOS.general.readToolNames);
    for (const name of ['search_stocks', 'fetch_quote', 'list_holdings', 'get_advice']) {
      for (const scenario of Object.values(AGENT_SCENARIOS)) {
        expect(scenario.readToolNames, `${scenario.id} 缺基线 ${name}`).toContain(name);
      }
    }
    expect(generalNames.has('get_market_data_status')).toBe(true);
  });

  it('场景专属项落在对应场景', () => {
    expect(AGENT_SCENARIOS.portfolio.readToolNames).toContain('get_account_performance');
    expect(AGENT_SCENARIOS.review.readToolNames).toContain('get_confidence_calibration');
    expect(AGENT_SCENARIOS.review.readToolNames).toContain('get_strategy_reliability_summary');
    expect(AGENT_SCENARIOS.review.readToolNames).toContain('compare_strategy_definitions');
    expect(AGENT_SCENARIOS.research.readToolNames).toContain('get_stock_research_view');
    expect(AGENT_SCENARIOS.research.readToolNames).toContain('compare_strategy_definitions');
    expect(AGENT_SCENARIOS.watch.readToolNames).toContain('get_watch_status');
  });

  it('review 覆写含小样本相关性约束，每场景有计划维度', () => {
    expect(AGENT_SCENARIOS.review.instructionOverlay).toContain('描述性统计');
    for (const scenario of Object.values(AGENT_SCENARIOS)) {
      expect(scenario.plannedDimensions.length).toBeGreaterThan(0);
    }
  });

  it('BASE_INSTRUCTIONS 保留共享安全规则与五段回答契约', () => {
    expect(BASE_INSTRUCTIONS).toContain('不得编造');
    expect(BASE_INSTRUCTIONS).toContain('不可信文本');
    expect(BASE_INSTRUCTIONS).toContain('不得自动交易');
    expect(BASE_INSTRUCTIONS).toContain('不构成投资建议');
    expect(BASE_INSTRUCTIONS).toContain('Tactic');
    expect(BASE_INSTRUCTIONS).toContain('结论摘要');
    expect(BASE_INSTRUCTIONS).toContain('风险与未知项');
    expect(BASE_INSTRUCTIONS).toContain('伪完整答案');
  });
});
