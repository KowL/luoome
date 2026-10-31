// dsh-luoome 打包技能的纯内容校验（需求 §3 四条旅程、§8 技能约束；task-12 验收）。
//
// 读 packages/dsh-luoome/skills 下的 Markdown 文本，和两件事对账：
//   1. `@luoome/tools` 的 registry —— 工具名真实存在、副作用分类一致（task-12）；
//   2. 插件的**暴露面** —— 技能让模型调用的名字必须真的可达（REQ-M1-02）。
//
// 为什么第 2 条不能只查 registry：registry 收的是**全部**工具定义，插件实际暴露的只有
// read 面 / market 面 / operation policy 面这一小撮。技能正文若点名一个「存在但没暴露」
// 的工具，模型会稳定拿到不可达的名字 —— 这与原始 P0 是同一类缺陷，只是换了一层。
//
// **运行环境：Node（vitest）。** 暴露集取自生产装配本身（`./production.js` → `@luoome/db/node`
// → `node:sqlite`），Bun 运行时下会直接报 `No such built-in module: node:sqlite`。
// 同目录的 `surface-consistency.test.ts` / `skill-journeys.e2e.test.ts` 是同一约束。
//
// 不启动 DSH、不打开数据库、不访问网络：surface 只调用 `descriptors()`，不执行任何工具。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ToolContext } from '@luoome/core';
import { toolRegistry } from '@luoome/tools';
import { describe, expect, it } from 'vitest';
import { BATCH_SCHEDULED_TOOL_NAMES } from '../../../tools/src/internal/workflow-only-tools.js';

import { createMarketSurface, DEFAULT_MARKET_TIMEOUT_MS } from './market-surface.js';
import { createProductionOperationPolicies } from './production.js';
import { DEFAULT_MARKET_TOOL_ALLOWLIST, DEFAULT_READ_TOOL_ALLOWLIST } from './production-config.js';
import { createReadSurface } from './read-surface.js';

const SKILLS_ROOT = fileURLToPath(new URL('../../skills', import.meta.url));

/** 仓库根（`packages/dsh-luoome/skills` 上跳三层），用于断言「技能只有一个根」。 */
const REPO_ROOT = resolve(SKILLS_ROOT, '../../..');

/**
 * 仓库里**不得**再出现随包技能同名目录的其它技能根。
 *
 * `.dsh/skills` 是 REQ-M1-01 删掉的旧根（工作区技能覆盖插件技能的那一次事故）；
 * `skills/` 是仓库根的历史约定位置。两个都盯着，任何一处冒出同名技能都会按 DSH rank
 * 决定赢家 —— 同一产品又跑两套技能集。
 */
const OTHER_SKILL_ROOTS = [join(REPO_ROOT, '.dsh', 'skills'), join(REPO_ROOT, 'skills')] as const;

/** DSH 宿主注册的原生确认操作入口，不是领域 registry 工具。 */
const NATIVE_OPERATION_TOOL = 'luoome_confirmed_operation';

/**
 * 内容里允许出现、但不属于领域工具名的反引号标识：analysis 写回错误值、DSH 宿主工具、
 * 以及只作为 operation policy 执行的批处理入口（`BATCH_SCHEDULED_TOOL_NAMES`，不进 registry）。
 */
const NON_TOOL_BACKTICKS = new Set([
  // DSH `schedule_create` 的参数名，不是工具名。
  'time_zone',
  // 宿主（DSH）的交互提问工具，不在 luoome registry 里；技能只要求模型用它提问。
  'ask_user_question',
  'context_expired',
  'stale_context',
  'configure_plugin_automation',
  'luoome_automation_catalog',
  'luoome_operation_status',
  'luoome_research_status',
  'schedule_create',
  'schedule_list',
  ...BATCH_SCHEDULED_TOOL_NAMES,
]);

/** 技能里可以引用的 analysis context kind：它们是分析口径，不是工具名。 */
const ANALYSIS_KINDS = new Set([
  'advice_stock',
  'advice_position',
  'advice_market',
  'advice_strategy_candidate',
  'advice_strategy_candidate_after_close',
]);

/**
 * 随包技能清单（= `BUNDLED_SKILL_NAMES`）。前四条是插件写回技能，后四条是从工作区
 * `.dsh/skills` 迁入的旅程技能（REQ-M1-01）。
 */
const EXPECTED_SKILLS = [
  'daily-market-analysis',
  'decision-journal',
  'luoome-batch',
  'morning-brief',
  'post-close-review',
  'stock-deep-dive',
  'strategy-lab',
  'strategy-result-review',
] as const;

/**
 * 承载插件写回契约的四条技能：正文负责解释 `luoome_confirmed_operation`、零人工审批、
 * 禁止自报授权与分析 context 时效。迁入的四条按 H2 **原文保留、只改工具名与写回路径**，
 * 不重写正文，因此这些叙述性断言只对写回技能生效。
 */
const WRITE_CONTRACT_SKILLS: ReadonlySet<string> = new Set([
  'daily-market-analysis',
  'post-close-review',
  'strategy-lab',
  'strategy-result-review',
]);

/**
 * 迁入技能按原文保留（H2），正文长度不套用写回技能的 ≥800 字符门槛：最短的
 * `decision-journal` 按原文口径本就短于 800，删改它会丢掉金融评审认可的方法论。
 */
const PRESERVED_BODY_SKILLS: ReadonlySet<string> = new Set([
  'decision-journal',
  'luoome-batch',
  'morning-brief',
  'stock-deep-dive',
]);

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
    get_strategy_research_state: 'read',
    get_strategy_data_preflight: 'read',
    get_strategy_evaluation_progress: 'read',
    list_strategy_evaluation_sessions: 'read',
    assess_adaptive_personality: 'read',
    export_strategy_manifest: 'read',
    save_strategy_research_state: 'write',
    start_strategy_evaluation_session: 'write',
    resume_strategy_evaluation_session: 'write',
    cancel_strategy_evaluation_session: 'write',
    run_strategy_research_comparison: 'external',
    get_strategy_insight_facts: 'read',
    compare_strategy_definitions: 'read',
    propose_strategy_version_draft: 'external',
    trial_strategy_version: 'external',
    create_strategy: 'write',
    create_strategy_version: 'write',
    validate_strategy_version: 'write',
    publish_strategy_version: 'write',
    get_strategy_schedule: 'read',
    set_strategy_schedule: 'write',
    list_watchlists: 'read',
    list_strategy_watchlist_subscriptions: 'read',
    subscribe_strategy_to_watchlist: 'write',
    unsubscribe_strategy_from_watchlist: 'write',
    pause_strategy: 'write',
    resume_strategy: 'write',
    run_strategy: 'external',
  },
  'strategy-result-review': {
    list_strategies: 'read',
    get_strategy: 'read',
    get_strategy_workspace: 'read',
    get_strategy_research_state: 'read',
    get_strategy_experiment_context: 'read',
    get_strategy_data_preflight: 'read',
    get_strategy_selection_diagnostics: 'read',
    get_strategy_evaluation_progress: 'read',
    list_strategy_evaluation_sessions: 'read',
    get_strict_strategy_backtest: 'read',
    list_strict_strategy_backtests: 'read',
    export_strategy_manifest: 'read',
    trial_strategy_version: 'external',
    run_strategy_research_comparison: 'external',
    save_strategy_research_state: 'write',
    list_strategy_runs: 'read',
    get_strategy_run: 'read',
    compare_strategy_runs: 'read',
    strategy_signals_by_stock: 'read',
    get_strategy_insight_facts: 'read',
    list_pending_strategy_observations: 'read',
    get_signal_observation_stats: 'read',
    get_strategy_reliability_summary: 'read',
    get_strategy_decision_cycles: 'read',
    get_strategy_schedule: 'read',
    list_strategy_watchlist_subscriptions: 'read',
    run_strategy: 'external',
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
  // 以下四条由 `.dsh/skills` 迁入（REQ-M1-01）：正文只写裸工具名，必须仍与 registry 对得上。
  'morning-brief': {
    get_market_data_status: 'read',
    list_holdings: 'read',
    list_watch_triggers: 'read',
    get_advice: 'read',
    list_watchlists: 'read',
    list_strategies: 'read',
    get_watch_status: 'read',
  },
  'stock-deep-dive': {
    get_analysis_context: 'read',
    record_advice: 'queue',
    record_analysis_result: 'queue',
  },
  'decision-journal': {
    get_analysis_context: 'read',
    save_decision_review: 'write',
  },
  // `luoome-batch` 的五个 `run_*` 入口只作为 scheduled policy 执行，不在 registry；
  // 这里显式登记为空，表示「本条技能不引用任何 registry 工具」，由下一用例的
  // 反引号对账保证它引用的名字都有出处。
  'luoome-batch': {},
};

/**
 * 「禁止调用」白名单：技能正文点名的、但在插件形态下**不得**由模型调用的工具名。
 *
 * 存在的理由：技能里合法地会出现「不直接调用 X」这种边界说明，X 因此必然**不在**暴露面
 * 内。没有这份名单，可达性断言会把正确的「禁止引用」判成缺陷 —— 而放过它，又会把
 * 「建议调用但不可达」的真缺陷一起放过。两件事必须显式分开。
 *
 * 名单被两侧夹住，只能缩小、不能新增：
 * - 每个条目必须**真的**命中某条技能，且引用它的那一行必须写明禁止/不可用（否则红）；
 * - 每个条目必须**真的**不在暴露集里（谁把它纳入暴露面，就必须回来删条目，否则红）。
 */
const FORBIDDEN_IN_SKILL: ReadonlyMap<string, string> = new Map([
  [
    'run_strategy',
    '技能写「不直接调用 `run_strategy`」：到期执行只走 `run_strategy_daily_cycle` 的 workflow，单策略立即运行不在 agent 面',
  ],
  [
    'propose_strategy_version_draft',
    '插件形态下没有对应 operation policy、不在暴露面内；草案一步改为对话内给完整 definition + `compare_strategy_definitions`',
  ],
]);

/** 引用处必须出现的禁止/不可用语汇；与 FORBIDDEN_IN_SKILL 一起挡住「禁止」被改写成「建议」。 */
const PROHIBITION_CUE = /不(?:直接)?调用|不要调用|禁止|不得|不可用/;

/** 技能正文里的反引号 snake_case 工具名引用，带所在整行（用于区分建议/禁止）。 */
interface ToolReference {
  readonly skill: string;
  readonly token: string;
  readonly line: string;
}

const TOOL_BACKTICK = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;

const toolReferences = (): readonly ToolReference[] => {
  const references: ToolReference[] = [];
  for (const skill of skills())
    for (const line of skill.content.split(/\r?\n/))
      for (const match of line.matchAll(TOOL_BACKTICK))
        references.push({ skill: skill.dir, token: match[1] as string, line });
  return references;
};

/** 反引号里不是工具名的标识（宿主工具、批处理入口、analysis context kind 等）。 */
const isNonToolToken = (token: string): boolean =>
  token === NATIVE_OPERATION_TOOL || NON_TOOL_BACKTICKS.has(token) || ANALYSIS_KINDS.has(token);

/**
 * 插件暴露集 —— 不手抄名单，直接问生产装配。
 *
 * 三个来源与 `bun run tools:list --json` 的 `.surface` 同源：
 * `readAllowlist` ∪ `marketAllowlist` ∪ `operationPolicies`。区别是这里求的是
 * **装配后的 descriptors()**，因此 read 面的 sideEffect 约束、私人研究拒绝清单、
 * market 面的 external 约束都已生效 —— 「名单里有名字但被过滤掉」不会被误判成可达。
 *
 * 懒求值：模块加载不触发 surface 构造（也就不在 collection 阶段踩装配前置条件）。
 */
let cachedSurface: ReadonlySet<string> | undefined;

const exposedSurface = (): ReadonlySet<string> => {
  if (cachedSurface !== undefined) return cachedSurface;
  const unused = (): ToolContext => {
    throw new Error('技能内容校验只读 descriptors()，不执行工具');
  };
  const read = createReadSurface({
    config: { allowlist: [...DEFAULT_READ_TOOL_ALLOWLIST] },
    tools: toolRegistry.all(),
    context: unused,
  });
  const market = createMarketSurface({
    config: {
      allowlist: [...DEFAULT_MARKET_TOOL_ALLOWLIST],
      timeoutMs: DEFAULT_MARKET_TIMEOUT_MS,
    },
    tools: toolRegistry.all(),
    context: unused,
  });
  cachedSurface = new Set<string>([
    ...read.descriptors().map((descriptor) => descriptor.name),
    ...market.descriptors().map((descriptor) => descriptor.name),
    ...createProductionOperationPolicies().map((policy) => policy.tool.name),
  ]);
  read.dispose();
  market.dispose();
  return cachedSurface;
};

describe('dsh-luoome 打包技能内容', () => {
  it('skills 目录只有八条随包技能，每个一个 SKILL.md，name 唯一且为 kebab-case', () => {
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
      const version =
        skill.dir === 'strategy-lab' ? 4 : skill.dir === 'strategy-result-review' ? 3 : 1;
      expect(skill.body).toContain(`本技能版本：${skill.dir}-v${version}`);
      if (!PRESERVED_BODY_SKILLS.has(skill.dir))
        expect(skill.body.length, `${skill.dir} 正文过短`).toBeGreaterThan(800);
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

  it('反引号里的 snake_case 名字都真实存在于 registry（或为个人操作入口/时效错误值）', () => {
    const backticked = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;
    for (const skill of skills()) {
      for (const match of skill.content.matchAll(backticked)) {
        const token = match[1] as string;
        if (
          token === NATIVE_OPERATION_TOOL ||
          NON_TOOL_BACKTICKS.has(token) ||
          ANALYSIS_KINDS.has(token)
        )
          continue;
        expect(
          toolRegistry.get(token),
          `${skill.dir} 反引号引用了未知工具名 ${token}`,
        ).toBeDefined();
      }
    }
  });

  it('写入按明确意图直接执行，且禁止模型自报授权', () => {
    for (const skill of skills().filter((item) => WRITE_CONTRACT_SKILLS.has(item.dir))) {
      expect(skill.content, `${skill.dir} 未说明个人操作入口`).toContain(NATIVE_OPERATION_TOOL);
      expect(skill.content, `${skill.dir} 未说明零人工审批`).toContain('没有人工审批');
      expect(skill.content, `${skill.dir} 未禁止自报 approved`).toContain('approved');
      expect(skill.content, `${skill.dir} 未禁止自报 callId`).toContain('callId');
      expect(skill.content, `${skill.dir} 未禁止自报 taskId`).toContain('taskId');
    }
  });

  it('复盘回填用 ask-user 四选一，且必须含「不知道」', () => {
    const close = skills().find((skill) => skill.dir === 'post-close-review')?.content ?? '';
    expect(close).toContain('ask_user_question');
    // 选项集合按原样断言：少一项（尤其「不知道」）或多一项都要红。
    expect(close).toContain('`兑现` / `部分兑现` / `忽略` / `不知道`');
    for (const label of ['兑现', '部分兑现', '忽略', '不知道'])
      expect(close, `回填技能缺选项 ${label}`).toContain(label);
    expect(close).toMatch(/没有预选|不得替用户选择/);
    // 预选的一种具体形态：给某一项打「推荐」标签。
    expect(close).toContain('(Recommended)');
    expect(close).toContain('不调用');
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
    expect(lab).toMatch(/按明确意图直接执行|明确要求发布/);
    expect(lab).toContain('不隐含发布');
    expect(lab).toContain('set_strategy_schedule');
    expect(lab).toContain('run_strategy_daily_cycle');
    expect(lab).toContain('configure_plugin_automation');
    expect(lab).toContain('两层都成功');
    expect(lab).toContain('不直接调用 `run_strategy`');
    expect(lab).toContain('subscribe_strategy_to_watchlist');
    expect(lab).toContain('pause_strategy');
    expect(lab).toContain('resume_strategy');

    const result = byDir.get('strategy-result-review') as string;
    expect(result).toContain('get_strategy_run');
    expect(result).toContain('list_strategy_runs');
    expect(result).toContain('get_strategy_insight_facts');
    expect(result).toContain('get_analysis_context');
    expect(result).toContain('record_analysis_result');
    expect(result).toContain('组合回测');

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

  it('analysis context 时效、建议边界与 trade 边界在写回技能中都有约束', () => {
    for (const skill of skills().filter((item) => WRITE_CONTRACT_SKILLS.has(item.dir))) {
      expect(skill.content, `${skill.dir} 未写 context_expired 处理`).toContain('context_expired');
      expect(skill.content, `${skill.dir} 未写 stale_context 处理`).toContain('stale_context');
      expect(skill.content, `${skill.dir} 未要求重取一次`).toContain('重取一次');
      expect(skill.content, `${skill.dir} 未写建议不等于交易`).toContain('建议不等于交易');
      expect(skill.content, `${skill.dir} 未写不调用 trade`).toMatch(/不调用 trade/);
    }
  });
});

/**
 * 技能 → 插件暴露面对账（REQ-M1-02）。
 *
 * 原始 P0 是「技能写 `mcp__luoome__*`，插件按裸名注册，工具名根本不存在」；上一版的修法
 * 只把守卫升级到「名字在 registry 里」，于是留下同一类的另一半：registry 是全部定义，
 * 插件实际暴露的只是 read 面 ∪ market 面 ∪ operation policy 面。技能仍可以让
 * 模型去调一个「定义存在、但插件没暴露」的工具，模型拿到的所有调用都会失败。
 *
 * 本组把判定基准换成**暴露集**，并要求「禁止引用」显式登记：
 *   建议调用 ⊆ 暴露集；禁止引用 ⊂ 暴露集之外（每条带理由，且引用处必须写明禁止）。
 */
describe('技能 → 插件暴露面对账（REQ-M1-02）', () => {
  it('技能建议调用的工具名必须落在插件暴露集内，而不是「在 registry 里」', () => {
    const surface = exposedSurface();
    // 自检：装配失败会让暴露集退化成空集合，那样下面会「全部不在暴露面」地爆红，
    // 但若反过来被写成空集合跳过，断言就会静默全绿。先钉住「非空」。
    expect(surface.size).toBeGreaterThan(0);

    // 反向自检：暴露集必须是 registry 的真子集关系里的「可达那一半」，且证明它确实更窄
    // —— 只要 registry 里有一个工具不在暴露集，「换基准」才有意义（不写死任何数量）。
    const registryNames = toolRegistry.all().map((tool) => tool.name);
    expect(registryNames.some((name) => !surface.has(name))).toBe(true);

    const unreachable: string[] = [];
    for (const reference of toolReferences()) {
      if (isNonToolToken(reference.token) || FORBIDDEN_IN_SKILL.has(reference.token)) continue;
      if (surface.has(reference.token)) continue;
      unreachable.push(
        `${reference.skill}: ${reference.token}` +
          `（registry ${toolRegistry.get(reference.token) === undefined ? '无' : '有'} / 暴露面 无）`,
      );
    }
    expect(unreachable, '技能建议调用了一个「存在但没暴露」的工具').toEqual([]);
  });

  it('禁止引用的工具名必须在暴露面外，且引用处写明禁止/不可用（白名单两侧夹住）', () => {
    const surface = exposedSurface();
    const referenced = new Set<string>();
    for (const reference of toolReferences()) {
      if (!FORBIDDEN_IN_SKILL.has(reference.token)) continue;
      referenced.add(reference.token);
      expect(
        surface.has(reference.token),
        `${reference.token} 已在暴露面内，与 FORBIDDEN_IN_SKILL 冲突：${FORBIDDEN_IN_SKILL.get(reference.token)}`,
      ).toBe(false);
      expect(
        reference.line,
        `${reference.skill} 引用 ${reference.token} 的那一行没写禁止/不可用（白名单不能把建议引用洗成禁止引用）`,
      ).toMatch(PROHIBITION_CUE);
    }
    // 只缩小：条目必须仍被某条技能引用；正文不再提它时必须回来删条目。
    expect([...FORBIDDEN_IN_SKILL.keys()].filter((name) => !referenced.has(name))).toEqual([]);
  });

  it('技能只有一个根：仓库内其它技能根不得出现同名技能目录', () => {
    const bundled = new Set<string>(EXPECTED_SKILLS);
    const duplicates: string[] = [];
    for (const root of OTHER_SKILL_ROOTS) {
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true }))
        if (entry.isDirectory() && bundled.has(entry.name))
          duplicates.push(relative(REPO_ROOT, join(root, entry.name)));
    }
    expect(
      duplicates,
      '同名技能出现在第二个技能根：DSH 按 rank 选赢家，技能集会被静默换掉',
    ).toEqual([]);
  });
});
