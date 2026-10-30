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
  const exposed = new Set<string>([
    ...read.descriptors().map((descriptor) => descriptor.name),
    ...marketSurface.descriptors().map((descriptor) => descriptor.name),
    ...createProductionOperationPolicies(undefined, { researchJobs }).map(
      (policy) => policy.tool.name,
    ),
  ]);

  return {
    ctx,
    db,
    domain,
    exposed,
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

      // ④ 产出含 dataAsOf，且至少含 1 条 missingFacts 或显式 unavailable 标注。
      //    M3-02 之前事实包用 `limitations` / `freshness: 'unavailable'` 表达缺口，
      //    因此两者都算「显式缺口标注」，`missingFacts` 一旦落地同样满足。
      const payload = JSON.stringify(executed.map((result) => result.value));
      expect(payload, `${journey.id} 产出缺少 dataAsOf`).toContain('dataAsOf');
      expect(
        payload.includes('missingFacts') || payload.includes('unavailable'),
        `${journey.id} 产出缺少缺口标注（missingFacts / unavailable）`,
      ).toBe(true);
    });
  }
});
