// 技能级 e2e（REQ-M1-01 核心验收；PRD §3.0 的 J1 盘前 / J3 盘后 / J4 研究 / J5 复盘）。
//
// 要守的缺陷：同一产品在两个环境跑两套技能集，各有一套坏法——工作区 `.dsh/skills` 覆盖了
// 插件随包技能，且正文写 `mcp__luoome*` 命名空间，而插件是**裸名原生注册**，所以四条旅程的
// 工具名根本不存在。本文件把「技能 → catalog → 暴露面 → 真实调用 → 产出诚实度」串成一条链，
// 每条旅程断言四件事：
//
//   ① 该技能被 DSH catalog 命中（按名查得到，且正文已加载）；
//   ② 首轮 tool 调用名 ∈ 插件暴露集（read 面 ∪ market 面 ∪ operation policy 面）；
//   ③ 首轮调用成功率 100%；
//   ④ 产出含 `dataAsOf`，且至少含 1 条 `missingFacts` 或显式 `unavailable` 标注。
//
// **与工具级的区别**：`mvp-journeys.e2e.test.ts` 的「工具级旅程 1–5」是从工具出发的协议/装配
// 用例，不加载任何技能；本文件的输入是 SKILL.md 本身（首轮工具必须写在技能正文里），因此
// 两者不得互相当证明。
//
// **运行环境**：Node（vitest）。`./production.js` 依赖 `node:sqlite`，Bun 下会报
// `No such built-in module: node:sqlite`。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { SkillRegistry } from '@deepseek-ai/dsh-skill';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { FakeMarketAdapter, TEST_ACCOUNT, TEST_STOCKS } from '@luoome/adapters/testing';
import { money, type ToolContext } from '@luoome/core';
import { seedData } from '@luoome/db/memory';
import { createNodeDrizzleRepos, type NodeDrizzleReposHandle } from '@luoome/db/node';
import { buildContext, toolRegistry } from '@luoome/tools';
import { seedTestStockUniverse } from '@luoome/tools/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMarketSurface,
  DEFAULT_MARKET_TIMEOUT_MS,
  registerMarketTools,
} from './market-surface.js';
import { createProductionOperationPolicies } from './production.js';
import { DEFAULT_MARKET_TOOL_ALLOWLIST, DEFAULT_READ_TOOL_ALLOWLIST } from './production-config.js';
import { createReadSurface } from './read-surface.js';
import { createResearchJobs } from './research-jobs.js';
import {
  BUNDLED_SKILL_NAMES,
  type BundledSkillName,
  readBundledSkills,
  registerBundledSkills,
} from './skills.js';
import { registerReadTools } from './tools.js';

const NOW = new Date('2026-07-17T02:00:00.000Z'); // 2026-07-17（周五）北京时间 10:00
const STOCK_ID = TEST_STOCKS[0]?.id ?? '600519.SH';
const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const temporaryRoots: string[] = [];

/**
 * 合成新闻源：`status()` 报告一次真实失败（`lastErrorKind`），
 * 让「要闻」这一维度在事实里显式 `unavailable`，而不是在报告里被省略。
 */
const newsWithFailedSource = {
  name: 'news' as const,
  sources: ['synthetic'],
  async fetchNews() {
    return {
      ok: true as const,
      data: {
        total: 0,
        source: 'eastmoney' as const,
        items: [],
        warnings: ['partial: synthetic news source unavailable'],
        asOf: new Date(NOW),
      },
    };
  },
  status: () => [
    {
      dataset: 'finance-news',
      source: 'synthetic',
      coverage: ['CN_FINANCE_NEWS'],
      capabilityEnabled: true,
      configurationReady: true,
      lastAttemptAt: NOW,
      lastSuccessAt: new Date(NOW.getTime() - 60_000),
      dataAsOf: new Date(NOW.getTime() - 60_000),
      lastErrorKind: 'network',
    },
  ],
};

interface JourneyCall {
  readonly name: string;
  readonly input: unknown;
  /**
   * 技能正文是否**点名**了该工具。正文点名 → 名字必须逐字出现在 SKILL.md 里；
   * 正文只写了维度（例如「行情」）→ 由该旅程的 `rationale` 说明落地到哪个工具，
   * 该理由同样受断言约束（不允许出现无出处的工具调用）。
   */
  readonly citedInSkill: boolean;
}

interface SkillJourney {
  readonly id: string;
  readonly title: string;
  /** 承接技能的随包名；catalog 必须按名命中。 */
  readonly skill: BundledSkillName;
  /** 技能正文「先取事实」那一步点名（或被该步要求）的首轮读工具。 */
  readonly firstRound: readonly JourneyCall[];
  readonly rationale: string;
}

/**
 * 旅程 → 技能映射（PRD §3.0 承接列 + REQ-M1-01 迁入清单）：
 * J1 盘前 → morning-brief（盘前简报）；J3 盘后 → post-close-review（当日建议与用户实际）；
 * J4 研究 → stock-deep-dive（单标的研究）；J5 复盘 → decision-journal（落 DecisionReview 的决策记录）。
 *
 * 首轮工具全部取自技能正文：正文点名的工具名必须先出现在 SKILL.md 里（用例内断言），
 * J4/J5 额外要求「行情」这一维度的事实缺口可判定，故带上 `get_market_data_status`——
 * 技能正文写的是「行情」而不是工具名，这里按暴露面里唯一提供行情时点与缺口的读工具落地。
 */
const JOURNEYS: readonly SkillJourney[] = [
  {
    id: 'J1',
    title: '盘前',
    skill: 'morning-brief',
    firstRound: [{ name: 'get_market_data_status', input: {}, citedInSkill: true }],
    rationale: 'morning-brief 步骤 1 点名 get_market_data_status：先查交易日，非交易日静默退出。',
  },
  {
    id: 'J3',
    title: '盘后',
    skill: 'post-close-review',
    firstRound: [{ name: 'get_decision_loop_review', input: {}, citedInSkill: true }],
    rationale:
      'post-close-review 步骤 2「账户层面」点名 get_decision_loop_review：描述性聚合，明确未知与数据截止时间。',
  },
  {
    id: 'J4',
    title: '研究',
    skill: 'stock-deep-dive',
    firstRound: [
      {
        name: 'get_analysis_context',
        input: { kind: 'advice_stock', subject: { kind: 'stock', id: STOCK_ID } },
        citedInSkill: true,
      },
      { name: 'get_market_data_status', input: {}, citedInSkill: false },
    ],
    rationale:
      'stock-deep-dive 步骤 1 点名 get_analysis_context 取事实包；正文另要求「行情」这一维度，' +
      '按插件暴露面落地为 get_market_data_status（唯一报告行情时点与 freshness=unavailable 的读工具）。',
  },
  {
    id: 'J5',
    title: '复盘',
    skill: 'decision-journal',
    firstRound: [
      {
        name: 'get_analysis_context',
        input: { kind: 'advice_stock', subject: { kind: 'stock', id: STOCK_ID } },
        citedInSkill: true,
      },
      { name: 'get_market_data_status', input: {}, citedInSkill: false },
    ],
    rationale:
      'decision-journal 步骤 1 点名 get_analysis_context 确认事实底座；正文同时要求「行情」，' +
      '按插件暴露面落地为 get_market_data_status（事实缺口必须可判定，不允许静默省略）。',
  },
];

interface ExecutedCall {
  readonly name: string;
  readonly value: unknown;
  readonly isError: boolean;
}

interface SkillJourneyFixture {
  readonly ctx: Context;
  readonly db: NodeDrizzleReposHandle;
  readonly domain: ToolContext;
  /** 插件暴露集：read 面 ∪ market 面 ∪ operation policy 面（与生产装配同一份声明）。 */
  readonly exposed: ReadonlySet<string>;
  /**
   * 暴露面的三类拆分。`exposed` 混了两类**性质不同**的名字：
   * read / market 是真 DSH 工具（走 ctx.tools.register），operation policy 是**操作目标**
   * （经 luoome_confirmed_operation 分发）。层①必须按这个拆分分别对账。
   */
  readonly exposedSurfaces: {
    readonly read: readonly string[];
    readonly market: readonly string[];
    readonly operations: readonly string[];
  };
  /** DSH catalog 里实际注册的技能名 → 正文。 */
  readonly skillContents: ReadonlyMap<string, string>;
  execute(call: JourneyCall): Promise<ExecutedCall>;
  dispose(): Promise<void>;
}

const createFixture = async (): Promise<SkillJourneyFixture> => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-skill-journeys-'));
  temporaryRoots.push(root);
  const db = createNodeDrizzleRepos(join(root, 'luoome.db'));
  await seedData(db.repos, {
    accounts: [TEST_ACCOUNT],
    stocks: TEST_STOCKS.slice(0, 3),
  });
  // 已保存行情：让事实包里的 `dataAsOf` 来自真实事实，而不是空事实包的兜底时点。
  await db.repos.quote.save({
    stockId: STOCK_ID,
    ts: new Date(NOW.getTime() - 60 * 60 * 1000),
    observedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    fetchedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    timestampSource: 'upstream',
    open: money(1600),
    high: money(1620),
    low: money(1590),
    close: money(1610),
    volume: 1_000_000,
    source: 'synthetic',
  });

  const ctx = new Context();
  new SkillRegistry(ctx);
  // ToolRuntime 依赖宿主 systemPrompt 服务（`static inject = ['systemPrompt']`），
  // 缺它时插件挂起而不是报错，`ctx.tools` 会一直是 undefined。
  const promptFiber = ctx.plugin(SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
  });
  await promptFiber.await();
  const toolFiber = ctx.plugin(ToolRuntime, { mode: 'native' });
  await toolFiber.await();

  const market = new FakeMarketAdapter({
    clock: () => new Date(NOW),
    timestampSource: 'upstream',
  });
  const domain = buildContext({
    repos: db.repos,
    adapters: { market },
    user: { id: 'skill-journeys-owner', defaultAccountId: TEST_ACCOUNT.id },
    identity: { mode: 'local', userId: 'skill-journeys-owner' },
    clock: () => new Date(NOW),
    logger: silentLogger,
    news: newsWithFailedSource as never,
  });
  await seedTestStockUniverse(domain);

  const read = createReadSurface({
    accountId: TEST_ACCOUNT.id,
    config: { allowlist: [...DEFAULT_READ_TOOL_ALLOWLIST] },
    tools: toolRegistry.all(),
    context: () => domain,
  });
  const marketSurface = createMarketSurface({
    accountId: TEST_ACCOUNT.id,
    config: {
      allowlist: [...DEFAULT_MARKET_TOOL_ALLOWLIST],
      timeoutMs: DEFAULT_MARKET_TIMEOUT_MS,
    },
    tools: toolRegistry.all(),
    context: () => domain,
  });
  const removeRead = registerReadTools(ctx.tools, read);
  const removeMarket = registerMarketTools(ctx.tools, marketSurface);

  // 真实 DSH catalog：插件随包 provider 注册到 DSH skill registry。
  const removeSkills = registerBundledSkills(ctx);
  const skillContents = new Map<string, string>();
  for (const summary of await ctx.skills.list()) {
    const definition = await ctx.skills.get(summary.name);
    if (definition !== undefined) skillContents.set(summary.name, definition.content);
  }

  // 暴露面的 policy 名单取自生产装配本身；researchJobs 只用于 policy 装配，用例结束一并 dispose。
  const researchJobs = createResearchJobs();
  const exposedSurfaces = {
    read: read.descriptors().map((descriptor) => descriptor.name),
    market: marketSurface.descriptors().map((descriptor) => descriptor.name),
    // 注意：这些是**操作目标**，不是 DSH 工具——它们经 luoome_confirmed_operation 分发，
    // 永远不该出现在 ctx.tools.schemas() 里。T24-a 层①据此分开对账。
    operations: createProductionOperationPolicies(undefined, { researchJobs }).map(
      (policy) => policy.tool.name,
    ),
  };
  const exposed = new Set<string>([
    ...exposedSurfaces.read,
    ...exposedSurfaces.market,
    ...exposedSurfaces.operations,
  ]);

  return {
    ctx,
    db,
    domain,
    exposed,
    exposedSurfaces,
    skillContents,
    async execute(call) {
      const executed = await ctx.tools.execute({
        name: call.name,
        callId: crypto.randomUUID() as never,
        arguments: call.input,
        signal: new AbortController().signal,
      });
      return {
        name: call.name,
        value: 'value' in executed ? executed.value : null,
        isError: executed.isError,
      };
    },
    async dispose() {
      removeSkills();
      removeMarket();
      removeRead();
      researchJobs.dispose();
      read.dispose();
      marketSurface.dispose();
      await toolFiber.dispose();
      await promptFiber.dispose();
      await ctx.fiber.dispose();
      db.close();
    },
  };
};

const isOk = (value: unknown): value is { ok: true; data: unknown } =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true;

let fixture: SkillJourneyFixture;

beforeAll(async () => {
  fixture = await createFixture();
}, 60_000);

afterAll(async () => {
  await fixture?.dispose();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('技能级旅程 · 技能单一真源（REQ-M1-01）', () => {
  it('随包技能目录与 BUNDLED_SKILL_NAMES 一致：八条，工作区不再有第二套', () => {
    const bundled = readBundledSkills().map((skill) => skill.name);
    expect([...bundled].sort()).toEqual([...BUNDLED_SKILL_NAMES].sort());
    expect(BUNDLED_SKILL_NAMES).toHaveLength(8);
  });

  for (const journey of JOURNEYS) {
    it(`${journey.id} ${journey.title}：catalog 命中 ${journey.skill} → 首轮工具在暴露面内 → 全部成功 → 产出带 dataAsOf 与缺口标注`, async () => {
      // ① 技能被 DSH catalog 命中：按名查得到，且正文已加载、正文点名了首轮工具。
      const content = fixture.skillContents.get(journey.skill);
      expect(content, `DSH catalog 未命中技能 ${journey.skill}`).toBeDefined();
      expect(content).toContain(`本技能版本：${journey.skill}-v1`);
      for (const call of journey.firstRound) {
        if (call.citedInSkill)
          expect(content, `${journey.skill} 正文没有写 ${call.name}`).toContain(call.name);
        else
          expect(journey.rationale, `${call.name} 既不在正文里、也没有首轮理由`).toContain(
            call.name,
          );
      }

      // ② 首轮 tool 调用名 ∈ 插件暴露集，且确实注册进了 DSH ToolRuntime。
      for (const call of journey.firstRound) {
        expect(fixture.exposed.has(call.name), `${call.name} 不在插件暴露集内`).toBe(true);
        expect(fixture.ctx.tools.get(call.name), `${call.name} 未注册到工具运行时`).toBeDefined();
      }

      // ③ 首轮调用成功率 100%。
      const executed: ExecutedCall[] = [];
      for (const call of journey.firstRound) executed.push(await fixture.execute(call));
      const failures = executed.filter((result) => result.isError || !isOk(result.value));
      expect(
        failures.map((result) => `${result.name}: ${JSON.stringify(result.value)}`),
        `${journey.id} 首轮调用失败`,
      ).toEqual([]);
      expect(executed.filter((result) => isOk(result.value))).toHaveLength(
        journey.firstRound.length,
      );

      // ④ 产出含**时间字段**，且至少含 1 条 missingFacts 或显式 unavailable 标注。
      //    task-31：`get_decision_loop_review` 的 `dataAsOf` 已改名 `evaluatedAt`
      //    （它一直是求值时刻、不是数据边界）。断言本意是「产出带时点」，所以两者都接受，
      //    但**仍要求至少一个真实时间字段**——不是放宽成「有没有都行」。
      const payload = JSON.stringify(executed.map((result) => result.value));
      expect(
        payload.includes('dataAsOf') || payload.includes('evaluatedAt') || payload.includes('asOf'),
        `${journey.id} 产出缺少时间字段（dataAsOf / evaluatedAt / asOf）`,
      ).toBe(true);
      expect(
        payload.includes('missingFacts') || payload.includes('unavailable'),
        `${journey.id} 产出缺少缺口标注（missingFacts / unavailable）`,
      ).toBe(true);
    });
  }
});

// T24-a / H5=B 层①②：插件暴露面 ↔ DSH **实际可见集**对账。
//
// 与 `exposure-reconciliation.test.ts` 的区别：那是「插件面 ↔ 共享判定」，本块是「插件面 ↔
// DSH 运行时真正吐给模型的 schemas()」。两者不重叠，不能互相当证明。
//
// 陷阱（骨架 T1/T6）：
//   - `schemas()` 是**同步**方法，不加 await；
//   - native 模式下 `run_code` 不进 schemas()，且本 fixture 没挂任何 DSH 自带工具 →
//     `dshVisible \ exposed` **必然为空**，所以层②绝不能写「差额非空」。
const HOST_OWNED_TOOLS = new Set(['run_code']);

/** 差额里的每一条都必须有名字级理由；不认识的直接红（'unknown'）。 */
const explainExtra = (name: string): 'host-tool' | 'unknown' =>
  HOST_OWNED_TOOLS.has(name) ? 'host-tool' : 'unknown';

describe('暴露面对账 · 插件面 ↔ DSH 可见集（H5=B 层①②）', () => {
  it('层①：注册进 ctx.tools 的暴露面（read ∪ market）逐工具都在 DSH 全局可见集里', () => {
    const dshVisible = new Set(fixture.ctx.tools.schemas().map((schema) => schema.name));
    const registered = [...fixture.exposedSurfaces.read, ...fixture.exposedSurfaces.market];
    const missing = registered.filter((name) => !dshVisible.has(name));
    expect(missing).toEqual([]);
    // 防空转：注册面不能是空集，否则"全部都在"毫无意义。
    expect(registered.length).toBeGreaterThan(0);
    expect(dshVisible.size).toBeGreaterThan(0);
  });

  it('层①-b：operation policy 名是「操作目标」而不是 DSH 工具，绝不进 schemas()', () => {
    // 这条钉住一个结构性事实：`exposed` 混了两类名字。
    //   - read / market：真 DSH 工具，走 ctx.tools.register；
    //   - operation policy：**操作目标**，经 luoome_confirmed_operation 分发（见 dsh-authority.ts:322），
    //     永远不该作为独立工具出现在 schemas() 里。
    // 若哪天有人把它们逐个注册成 DSH 工具，这条会红——那正是要发现的。
    const dshVisible = new Set(fixture.ctx.tools.schemas().map((schema) => schema.name));
    expect(fixture.exposedSurfaces.operations.length).toBeGreaterThan(0);
    // 少数名字**同时**是 read 工具与 operation policy（如 trial_strategy_version、
    // run_strategy_research_comparison，见 production-config.ts:113-114）。它们经 read 面注册，
    // 出现在 schemas() 里是合法的；要钉的是「只作操作目标、没有注册成 DSH 工具」的那批。
    //
    // 判据是**名字重叠推断**，已知误判条件：若将来某个 operation policy 名与某个 DSH 自带工具
    // 重名，它会被当成"已注册"而漏检。要消除这个盲点，得让 operation policy 带显式类别标记。
    const registered = new Set([
      ...fixture.exposedSurfaces.read,
      ...fixture.exposedSurfaces.market,
    ]);
    const operationOnly = fixture.exposedSurfaces.operations.filter(
      (name) => !registered.has(name),
    );
    expect(operationOnly.length).toBeGreaterThan(0);
    const leaked = operationOnly.filter((name) => dshVisible.has(name));
    expect(leaked).toEqual([]);
    // 权威层包装工具本身也不在本 fixture（本 fixture 只挂 read + market）。
    expect(dshVisible.has('luoome_confirmed_operation')).toBe(false);
  });

  // ⚠️ 本 fixture 下 `extra` **必然为空**（native 模式 + 没挂任何 DSH 自带工具，骨架 T1），
  // 所以这条只证明两件事：① 差额的归因逻辑本身（有差额就会逐条检查）；② 两条 run_code 反向硬事实。
  // 它**没有**验证"差额可枚举"——那需要 PTC 变体（骨架 §2.3，本轮不做）。
  it('层②：差额逐条可归因，且 run_code 恒不属插件暴露面', () => {
    const dshVisible = new Set(fixture.ctx.tools.schemas().map((schema) => schema.name));
    const extra = [...dshVisible].filter((name) => !fixture.exposed.has(name));

    // 每一条差额都必须能归因到 DSH 自带工具；归因不了的立刻红。
    for (const name of extra) expect(explainExtra(name), `未归因的差额：${name}`).toBe('host-tool');

    // 反向硬事实 1：DSH 保留传输 run_code 永远不属于插件暴露面。
    expect(fixture.exposed.has('run_code')).toBe(false);
    // 反向硬事实 2：native 模式下 run_code 也不在 schemas() 里（骨架 T1）。
    // 若哪天 DSH 改了这条，本断言会红——那正是我们要知道的。
    expect(dshVisible.has('run_code')).toBe(false);

    // ⚠️ 刻意不写 expect(extra.length).toBeGreaterThan(0)：native 最小 fixture 下必然为空（T1）。
  });
});
