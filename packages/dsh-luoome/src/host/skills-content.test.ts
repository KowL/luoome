// dsh-luoome 打包技能的纯内容校验（需求 §3 四条旅程、§8 技能约束；task-12 验收）。
//
// 只读 packages/dsh-luoome/skills 下的 Markdown 文本并和 @luoome/tools 的 registry 对账，
// 不启动 DSH、不装配数据库、不访问网络。技能只是 agent 的行为说明，权限仍由 host 的
// 原生 surface / 审批策略决定，所以这里只校验「内容是否把话说明白、工具名是否真实存在」。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolRegistry } from '@luoome/tools';
import { describe, expect, it } from 'vitest';

const SKILLS_ROOT = fileURLToPath(new URL('../../skills', import.meta.url));

/** DSH 宿主注册的原生确认操作入口，不是领域 registry 工具。 */
const NATIVE_OPERATION_TOOL = 'luoome_confirmed_operation';

/** 内容里允许出现、但不属于领域工具名的反引号标识（analysis 写回错误值）。 */
const NON_TOOL_BACKTICKS = new Set(['context_expired', 'stale_context']);

const EXPECTED_SKILLS = [
  'daily-market-analysis',
  'post-close-review',
  'strategy-lab',
  'strategy-result-review',
] as const;

type SideEffect = 'read' | 'external' | 'write' | 'queue';

interface ParsedSkill {
  readonly dir: string;
  readonly content: string;
  readonly body: string;
  readonly frontmatter: ReadonlyMap<string, string>;
}

const parseFrontmatter = (dir: string): ParsedSkill => {
  const content = readFileSync(join(SKILLS_ROOT, dir, 'SKILL.md'), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (match === null) throw new Error(`skill ${dir} 缺少 frontmatter`);
  const frontmatter = new Map<string, string>();
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const pair = /^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(line);
    if (pair === null) throw new Error(`skill ${dir} frontmatter 行无法解析: ${line}`);
    frontmatter.set(pair[1] as string, (pair[2] as string).trim());
  }
  return { dir, content, body: content.slice(match[0].length), frontmatter };
};

const skills = (): readonly ParsedSkill[] => EXPECTED_SKILLS.map((dir) => parseFrontmatter(dir));

/** 每条技能必须出现的工具名及其在 registry 中的真实副作用分类。 */
const EXPECTED_TOOLS: Readonly<Record<string, Readonly<Record<string, SideEffect>>>> = {
  'strategy-lab': {
    list_strategies: 'read',
    get_strategy: 'read',
    get_strategy_dsl_catalog: 'read',
    get_strategy_workspace: 'read',
    get_market_data_status: 'read',
    get_strategy_experiment_context: 'read',
    get_strategy_insight_facts: 'read',
    compare_strategy_definitions: 'read',
    propose_strategy_version_draft: 'external',
    trial_strategy_version: 'external',
    create_strategy: 'write',
    create_strategy_version: 'write',
    validate_strategy_version: 'write',
    publish_strategy_version: 'write',
  },
  'strategy-result-review': {
    list_strategies: 'read',
    get_strategy: 'read',
    get_strategy_workspace: 'read',
    list_strategy_runs: 'read',
    get_strategy_run: 'read',
    compare_strategy_runs: 'read',
    strategy_signals_by_stock: 'read',
    get_strategy_insight_facts: 'read',
    list_pending_strategy_observations: 'read',
    get_signal_observation_stats: 'read',
    get_strategy_reliability_summary: 'read',
    get_strategy_decision_cycles: 'read',
    get_analysis_context: 'read',
    record_analysis_result: 'queue',
  },
  'post-close-review': {
    get_advice: 'read',
    list_decision_reviews: 'read',
    get_decision_review_context: 'read',
    get_decision_review_snapshot: 'read',
    list_trades: 'read',
    get_signal_observation_stats: 'read',
    list_pending_strategy_observations: 'read',
    get_decision_loop_review: 'read',
    get_advice_stats: 'read',
    get_confidence_calibration: 'read',
    save_decision_review: 'write',
    record_advice_outcome: 'write',
  },
  'daily-market-analysis': {
    get_market_data_status: 'read',
    get_previous_closes: 'read',
    limit_up_ladder: 'read',
    dragon_tiger_list: 'read',
    northbound_flow: 'read',
    fetch_news: 'external',
    get_analysis_context: 'read',
    list_holdings: 'read',
    get_account_facts: 'read',
    list_watchlists: 'read',
    list_watch_triggers: 'read',
    list_strategies: 'read',
    get_advice: 'read',
    fetch_index_quotes: 'external',
    get_ashare_sentiment: 'external',
    fetch_quote: 'external',
    batch_quote: 'external',
    record_advice: 'queue',
  },
};

describe('dsh-luoome 打包技能内容', () => {
  it('skills 目录只有四个技能，每个一个 SKILL.md，name 唯一且为 kebab-case', () => {
    const entries = readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(entries).toEqual([...EXPECTED_SKILLS].sort());

    const names = new Set<string>();
    for (const skill of skills()) {
      const name = skill.frontmatter.get('name');
      expect(name, `${skill.dir} 缺 name`).toBe(skill.dir);
      expect(name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      expect(names.has(name as string), `技能 name 重复: ${name}`).toBe(false);
      names.add(name as string);
      expect(skill.frontmatter.get('description')?.length ?? 0).toBeGreaterThan(10);
      expect(skill.frontmatter.get('whenToUse')?.length ?? 0).toBeGreaterThan(5);
      expect(skill.body).toContain(`本技能版本：${skill.dir}-v1`);
      expect(skill.body.length).toBeGreaterThan(800);
    }
  });

  it('不出现旧形态命名：mcp 前缀、worker、队列管理工具', () => {
    for (const skill of skills()) {
      expect(skill.content, `${skill.dir} 出现 mcp`).not.toMatch(/mcp/i);
      expect(skill.content, `${skill.dir} 出现 worker`).not.toMatch(/luoome[-_]worker/i);
      expect(skill.content, `${skill.dir} 引用队列管理工具`).not.toMatch(
        /claim_analysis_jobs|complete_analysis_job|fail_analysis_job|get_analysis_metrics/,
      );
      expect(skill.content, `${skill.dir} 引用 save_report`).not.toMatch(/save_report/);
    }
  });

  it('工具名与 registry 对账，副作用分类一致', () => {
    for (const skill of skills()) {
      for (const [name, sideEffect] of Object.entries(EXPECTED_TOOLS[skill.dir] ?? {})) {
        expect(skill.content, `${skill.dir} 未提到 ${name}`).toContain(name);
        const tool = toolRegistry.get(name);
        expect(tool, `${skill.dir} 引用了 registry 中不存在的工具 ${name}`).toBeDefined();
        expect(tool?.sideEffect, `${name} 的副作用分类与技能描述不一致`).toBe(sideEffect);
      }
    }
  });

  it('反引号里的 snake_case 名字都真实存在于 registry（或为原生审批入口/时效错误值）', () => {
    const backticked = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;
    for (const skill of skills()) {
      for (const match of skill.content.matchAll(backticked)) {
        const token = match[1] as string;
        if (token === NATIVE_OPERATION_TOOL || NON_TOOL_BACKTICKS.has(token)) continue;
        expect(
          toolRegistry.get(token),
          `${skill.dir} 反引号引用了未知工具名 ${token}`,
        ).toBeDefined();
      }
    }
  });

  it('写入一律经 DSH 原生审批，且禁止模型自报授权', () => {
    for (const skill of skills()) {
      expect(skill.content, `${skill.dir} 未说明原生审批`).toContain(NATIVE_OPERATION_TOOL);
      expect(skill.content, `${skill.dir} 未说明审批`).toContain('原生审批');
      expect(skill.content, `${skill.dir} 未禁止自报 approved`).toContain('approved');
      expect(skill.content, `${skill.dir} 未禁止自报 callId`).toContain('callId');
      expect(skill.content, `${skill.dir} 未禁止自报 taskId`).toContain('taskId');
    }
  });

  it('四条旅程覆盖点齐全', () => {
    const byDir = new Map(skills().map((skill) => [skill.dir, skill.content]));
    const lab = byDir.get('strategy-lab') as string;
    expect(lab).toContain('get_strategy_dsl_catalog');
    expect(lab).toContain('create_strategy');
    expect(lab).toContain('create_strategy_version');
    expect(lab).toContain('validate_strategy_version');
    expect(lab).toContain('publish_strategy_version');
    expect(lab).toContain('trial_strategy_version');
    expect(lab).toMatch(/独立审批|单独审批/);
    expect(lab).toContain('不隐含发布');

    const result = byDir.get('strategy-result-review') as string;
    expect(result).toContain('get_strategy_run');
    expect(result).toContain('list_strategy_runs');
    expect(result).toContain('get_strategy_insight_facts');
    expect(result).toContain('get_analysis_context');
    expect(result).toContain('record_analysis_result');
    expect(result).toContain('严格回测');

    const close = byDir.get('post-close-review') as string;
    expect(close).toContain('save_decision_review');
    expect(close).toContain('record_advice_outcome');
    expect(close).toContain('followed');
    expect(close).toContain('partially_followed');
    expect(close).toContain('ignored');
    expect(close).toMatch(/不得替用户|不自动/);
    expect(close).toContain('不伪造盈亏');

    const market = byDir.get('daily-market-analysis') as string;
    expect(market).toContain('fetch_index_quotes');
    expect(market).toContain('get_ashare_sentiment');
    expect(market).toContain('fetch_news');
    expect(market).toContain('get_market_data_status');
    expect(market).toContain('get_analysis_context');
    expect(market).toContain('record_advice');
    expect(market).toContain('observedAt');
    expect(market).toContain('dataAsOf');
    expect(market).toMatch(/partial/);
    expect(market).toMatch(/unavailable/);
    expect(market).toContain('source');
  });

  it('analysis context 时效、建议边界与 trade 边界在每条技能中都有约束', () => {
    for (const skill of skills()) {
      expect(skill.content, `${skill.dir} 未写 context_expired 处理`).toContain('context_expired');
      expect(skill.content, `${skill.dir} 未写 stale_context 处理`).toContain('stale_context');
      expect(skill.content, `${skill.dir} 未要求重取一次`).toContain('重取一次');
      expect(skill.content, `${skill.dir} 未写建议不等于交易`).toContain('建议不等于交易');
      expect(skill.content, `${skill.dir} 未写不调用 trade`).toMatch(/不调用 trade/);
    }
  });
});
