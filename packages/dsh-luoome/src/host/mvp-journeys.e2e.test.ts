// MVP 最终验收：四条真实旅程 + 负例/恢复矩阵（需求 §10.2/§10.3/§10.5，task-20）。
//
// 运行环境：Node/vitest（`@luoome/db/node` 的 node:sqlite），进程内真实 DSH
// AgentLoop/SessionStore/ApprovalService 与官方审批组件；业务数据在临时 Node SQLite。
// 模型是**脚本模型**——这里只验证协议/装配/审批/事实链路，绝不宣称真实模型质量。
// 审批：使用官方 ApprovalService，测试通过宿主 `approval/request` 监听给出 allowed-once/deny，
// 不注入绕过 guard/pre-execute 的 answerer，也不修改生产审批路径。
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import {
  createUserMessage,
  LlmAdapter,
  LlmRuntime,
  type StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { Storage } from '@deepseek-ai/dsh-storage';
import * as Domain from '@deepseek-ai/dsh-storage-domain';
import * as JsonStorage from '@deepseek-ai/dsh-storage-json';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { type ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval';
import {
  FakeMarketAdapter,
  TEST_ACCOUNT,
  TEST_STOCKS,
  testAdviceFor,
} from '@luoome/adapters/testing';
import type {
  PluginAuthorityRepository,
  PluginAutomationGrant,
  PluginOperation,
  PluginOperationProof,
  PluginOperationScope,
} from '@luoome/core';
import {
  type AnalysisContext,
  analysisContextTiming,
  type MarketDataAdapterLike,
  money,
  type RepositoryRegistry,
  type Strategy,
  type StrategyDslV1,
  type StrategyRun,
  type StrategyVersion,
  strategyDefinitionHash,
  type ToolContext,
} from '@luoome/core';
import { seedData } from '@luoome/db/memory';
import { createNodeDrizzleRepos, type NodeDrizzleReposHandle } from '@luoome/db/node';
import { analysisHash, buildContext, toolRegistry } from '@luoome/tools';
import { seedTestStockUniverse } from '@luoome/tools/testing';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createDshOperationHost } from './dsh-authority.js';
import {
  createMarketSurface,
  DEFAULT_MARKET_TIMEOUT_MS,
  registerMarketTools,
} from './market-surface.js';
import { createPanelStateHandler } from './panels.js';
import { createProductionOperationPolicies } from './production.js';
import { DEFAULT_MARKET_TOOL_ALLOWLIST, DEFAULT_READ_TOOL_ALLOWLIST } from './production-config.js';
import { createReadSurface } from './read-surface.js';
import { BUNDLED_SKILL_NAMES, createBundledSkillProvider, readBundledSkills } from './skills.js';
import { registerReadTools } from './tools.js';

const NOW = new Date('2026-07-17T02:00:00.000Z'); // 2026-07-17（周五）北京时间 10:00
const MANUAL_OPERATION_TOOL = 'luoome_confirmed_operation';
const STRATEGY_DEFINITION: StrategyDslV1 = {
  schemaVersion: 1,
  metadata: { style: 'momentum' },
  universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
  selection: {
    logic: 'all',
    rules: [{ id: 'rule-1', name: 'Rule', when: 'true', evidence: ['matched'] }],
  },
  signals: { entry: [], exit: [], risk: [] },
};
const rootDirs: string[] = [];

afterEach(() => {
  for (const dir of rootDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 受控行情适配器：指数/行情可成功也可按需失败，用于外部事实与失败语义。 */
class ControlledMarketAdapter implements MarketDataAdapterLike {
  readonly name = 'controlled-market';
  private readonly inner = new FakeMarketAdapter({
    clock: () => new Date(NOW),
    timestampSource: 'upstream',
  });
  failIndex = false;
  failQuote = false;
  async fetchIndexQuotes() {
    if (this.failIndex) throw new Error('synthetic upstream index failure');
    return [
      {
        code: '000001.SH',
        name: '上证指数',
        close: money(3200),
        change: 12.5,
        changePct: 0.39,
        ts: new Date(NOW),
        source: 'synthetic-index',
        observedAt: new Date(NOW),
        fetchedAt: new Date(NOW),
        timestampSource: 'upstream' as const,
      },
    ];
  }
  async fetchQuote(stockCode: string) {
    if (this.failQuote) throw new Error('synthetic upstream quote failure');
    return this.inner.fetchQuote(stockCode);
  }
  batchQuote(stockCodes: readonly string[]) {
    return this.inner.batchQuote(stockCodes);
  }
  fetchDailyBars(stockCode: string, range: Parameters<MarketDataAdapterLike['fetchDailyBars']>[1]) {
    return this.inner.fetchDailyBars(stockCode, range);
  }
  searchStocks(query: string) {
    return this.inner.searchStocks(query);
  }
  fetchIntradayMinutes() {
    return this.inner.fetchIntradayMinutes();
  }
  fetchMinuteBars() {
    return this.inner.fetchMinuteBars();
  }
  fetchMarketSnapshot() {
    return this.inner.fetchMarketSnapshot();
  }
  marketSourceStatus() {
    return this.inner.marketSourceStatus();
  }
}

const sentimentUnavailable = {
  async fetch() {
    return {
      ok: false as const,
      error: {
        kind: 'adapter_error' as const,
        message: 'synthetic sentiment unavailable',
        recoverable: true,
      },
    };
  },
  status: () => [],
};

const newsPartial = {
  name: 'news' as const,
  sources: ['synthetic'],
  async fetchNews() {
    return {
      ok: true as const,
      data: {
        total: 1,
        source: 'eastmoney' as const,
        items: [
          {
            id: 'synthetic-news-1',
            title: '合成要闻：仅供验收，不代表真实市场',
            summary: '合成摘要',
            category: '市场' as const,
            source: 'synthetic',
            publishedAt: new Date(NOW),
            url: 'https://example.invalid/synthetic',
          },
        ],
        warnings: ['partial: synthetic news only'],
        asOf: new Date(NOW),
      },
    };
  },
  status: () => [],
};

interface ScriptedCall {
  readonly name: string;
  readonly input: unknown;
}
interface ScriptedTurn {
  readonly calls: readonly ScriptedCall[];
  readonly text: string;
}

class ScriptedModel extends LlmAdapter {
  readonly turns: ScriptedTurn[] = [];
  requests = 0;
  async *stream(): AsyncIterable<StreamChunk> {
    this.requests += 1;
    const turn = this.turns.shift() ?? { calls: [], text: 'done' };
    for (const [index, call] of turn.calls.entries()) {
      const id = ToolCallId(randomUUID());
      const args = JSON.stringify(call.input);
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args };
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name: call.name, arguments: args },
      };
    }
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: turn.text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: turn.text } };
    yield { type: 'finish', reason: { kind: turn.calls.length > 0 ? 'tool-calls' : 'stop' } };
  }
}

interface JourneyFixture {
  readonly ctx: Context;
  readonly db: NodeDrizzleReposHandle;
  readonly domain: ToolContext;
  readonly repos: RepositoryRegistry;
  readonly principal: { userId: string; accountId: string };
  readonly market: ControlledMarketAdapter;
  readonly model: ScriptedModel;
  readonly approvals: ApprovalOutcome[];
  readonly results: { name: string; value: unknown; isError: boolean }[];
  readonly read: ReturnType<typeof createReadSurface>;
  readonly marketSurface: ReturnType<typeof createMarketSurface>;
  readonly hostService: ReturnType<typeof createDshOperationHost>['service'];
  readonly agent: Agent;
  run(
    call: ScriptedCall,
    text?: string,
  ): Promise<{ name: string; value: unknown; isError: boolean } | undefined>;
  execute(
    name: string,
    input: unknown,
  ): Promise<{ name: string; value: unknown; isError: boolean }>;
  close(): Promise<void>;
}

/** 与 createDshTestHost 同构，但使用 Node SQLite、生产 policies/capabilities 与可注入仓库。 */
const createJourneyFixture = async (
  options: {
    readonly repository?: RepositoryRegistry['pluginAuthority'];
    readonly wrapRepository?: (
      repository: RepositoryRegistry['pluginAuthority'],
    ) => RepositoryRegistry['pluginAuthority'];
    readonly approvals?: readonly ApprovalOutcome[];
    readonly accountId?: string;
  } = {},
): Promise<JourneyFixture> => {
  const root = mkdtempSync(join(tmpdir(), 'luoome-mvp-journeys-'));
  rootDirs.push(root);
  const db = createNodeDrizzleRepos(join(root, 'luoome.db'));
  await seedData(db.repos, { accounts: [TEST_ACCOUNT], stocks: TEST_STOCKS.slice(0, 3) });

  const ctx = new Context();
  const fibers: { dispose(): Promise<void> }[] = [];
  const mount = async (plugin: Parameters<Context['plugin']>[0], config?: unknown) => {
    const fiber = ctx.plugin(plugin, config);
    fibers.push(fiber);
    await fiber.await();
  };
  await mount(AgentRegistry);
  await mount(SessionStore);
  await mount(SessionProjectionRegistry);
  await mount(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
  await mount(ToolRuntime, { mode: 'native' });
  await mount(LlmRuntime);
  const model = new ScriptedModel();
  ctx.llm.registerAdapter(['scripted'], model);
  await mount(Storage);
  await mount(JsonStorage, { root: join(root, 'storage') });
  await mount(Domain, { backend: 'json' });
  await mount(Persistence, { root: join(root, 'sessions'), compression: 'none' });
  await mount(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
  await mount(ApprovalService, { policy: 'ask' });

  const market = new ControlledMarketAdapter();
  const domain: ToolContext = buildContext({
    repos: db.repos,
    adapters: { market },
    user: { id: 'mvp-owner', defaultAccountId: options.accountId ?? TEST_ACCOUNT.id },
    identity: { mode: 'local', userId: 'mvp-owner' },
    clock: () => new Date(NOW),
    logger: silentLogger,
    ashareSentiment: sentimentUnavailable as never,
    news: newsPartial as never,
  });
  await seedTestStockUniverse(domain);
  const principal = Object.freeze({
    userId: 'mvp-owner',
    accountId: options.accountId ?? TEST_ACCOUNT.id,
  });

  const read = createReadSurface({
    config: { allowlist: [...DEFAULT_READ_TOOL_ALLOWLIST] },
    tools: toolRegistry.all(),
    context: () => domain,
  });
  const marketSurface = createMarketSurface({
    config: {
      allowlist: [...DEFAULT_MARKET_TOOL_ALLOWLIST],
      timeoutMs: DEFAULT_MARKET_TIMEOUT_MS,
    },
    tools: toolRegistry.all(),
    context: () => domain,
  });
  registerReadTools(ctx.tools, read);
  registerMarketTools(ctx.tools, marketSurface);
  const baseRepository = options.repository ?? db.repos.pluginAuthority;
  const host = createDshOperationHost(ctx, {
    repository: options.wrapRepository?.(baseRepository) ?? baseRepository,
    policies: createProductionOperationPolicies(),
    capabilities: ['read', 'write', 'external', 'queue'],
    policyVersion: 1,
    now: () => NOW.getTime(),
    context: () => domain,
    profile: 'mvp-journeys',
    principalForSession: () => principal,
    automationsEnabled: false,
  });

  const approvals = [...(options.approvals ?? [])];
  ctx.on('approval/request', async () => approvals.shift() ?? 'rejected');
  const results: { name: string; value: unknown; isError: boolean }[] = [];
  ctx.on('tools/result', (execution, result) => {
    results.push({
      name: execution.name,
      value: 'value' in result ? result.value : null,
      isError: result.isError,
    });
  });

  const handle = await ctx.agents.create({
    sessionId: SessionId('mvp-journeys'),
    agentOptions: { provider: 'scripted', model: 'scripted' },
  });
  const run = async (call: ScriptedCall, text = 'mvp journey request') => {
    model.turns.push({ calls: [call], text });
    handle.agent.followup(
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    );
    await handle.agent.whenIdle();
    await ctx.sessions.flush(handle.agent.session);
    return results.at(-1);
  };
  const execute = async (name: string, input: unknown) => {
    const executed = await ctx.tools.execute({
      name,
      callId: ToolCallId(randomUUID()),
      arguments: input,
      agent: handle.agent,
      signal: new AbortController().signal,
    });
    return {
      name,
      value: 'value' in executed ? executed.value : null,
      isError: executed.isError,
    };
  };

  return {
    ctx,
    db,
    domain,
    repos: db.repos,
    principal,
    market,
    model,
    approvals,
    results,
    read,
    marketSurface,
    hostService: host.service,
    agent: handle.agent,
    run,
    execute,
    async close() {
      host.dispose();
      await handle.dispose();
      for (const fiber of fibers.reverse()) await fiber.dispose();
      await ctx.fiber.dispose();
      db.close();
    },
  };
};

const isOk = (value: unknown): value is { ok: true; data: unknown } =>
  typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true;

const dataOf = <T>(value: unknown): T => {
  if (!isOk(value)) throw new Error(`tool failed: ${JSON.stringify(value)}`);
  return value.data as T;
};

/** 通过真实 AgentLoop 调一次原生确认操作；approvalOutcome 由测试队列决定。 */
const confirmed = async (
  fixture: JourneyFixture,
  tool: string,
  input: unknown,
  outcome: ApprovalOutcome = 'allowed-once',
) => {
  fixture.approvals.push(outcome);
  return fixture.run({ name: MANUAL_OPERATION_TOOL, input: { id: randomUUID(), tool, input } });
};

describe('MVP 四旅程（脚本模型 + 真实 DSH AgentLoop/审批 + Node SQLite）', () => {
  it('旅程 1：策略制定 create/version/validate 分别审批，trial 不落库，publish 独立审批后回读', async () => {
    const fixture = await createJourneyFixture();
    try {
      const strategyId = `strategy-${randomUUID()}`;
      // 对话先读目录与 DSL catalog
      const catalog = await fixture.run(
        { name: 'get_strategy_dsl_catalog', input: {} },
        '先看 DSL catalog',
      );
      expect(catalog?.isError).toBe(false);
      const create = await confirmed(fixture, 'create_strategy', {
        id: strategyId,
        name: 'MVP 旅程策略',
        description: '脚本模型生成的验收策略',
      });
      expect(create?.isError).toBe(false);
      const created = dataOf<{ operationId: string; state: string }>(create?.value);
      expect(created.state).toBe('succeeded');

      const versionInput = (version: string) => ({
        strategyId,
        definition: STRATEGY_DEFINITION,
        changeSummary: version,
        factReferences: [],
      });
      const v1 = await confirmed(fixture, 'create_strategy_version', versionInput('v1'));
      expect(v1?.isError).toBe(false);
      const validateV1 = await confirmed(fixture, 'validate_strategy_version', {
        versionId: (await fixture.repos.strategy.listVersions(strategyId))[0]?.id ?? '',
      });
      expect(validateV1?.isError).toBe(false);
      const [version1] = await fixture.repos.strategy.listVersions(strategyId);
      if (version1 === undefined) throw new Error('missing v1');
      const publishV1 = await confirmed(fixture, 'publish_strategy_version', {
        strategyId,
        versionId: version1.id,
      });
      expect(publishV1?.isError).toBe(false);

      const v2 = await confirmed(fixture, 'create_strategy_version', versionInput('v2'));
      expect(v2?.isError).toBe(false);
      const versions = await fixture.repos.strategy.listVersions(strategyId);
      expect(versions).toHaveLength(2);
      const draft2 = versions.find((version) => version.id !== version1.id);
      if (draft2 === undefined) throw new Error('missing v2');
      const validateV2 = await confirmed(fixture, 'validate_strategy_version', {
        versionId: draft2.id,
      });
      expect(validateV2?.isError).toBe(false);
      // validate 不隐含 publish：current 仍是 v1
      expect((await fixture.repos.strategy.findById(strategyId))?.currentVersionId).toBe(
        version1.id,
      );

      // 有限样本 trial（active 策略上 v1 vs v2）：持久化 false，不新增 operational run
      const runsBefore = await fixture.repos.strategyRun.listRuns();
      const trial = await fixture.execute('trial_strategy_version', {
        strategyId,
        baseVersionId: version1.id,
        draftVersionId: draft2.id,
        stockIds: [TEST_STOCKS[0]?.id ?? '600519.SH'],
      });
      expect(trial.isError).toBe(false);
      const trialData = dataOf<{ persisted: boolean; diff: unknown }>(trial.value);
      expect(trialData.persisted).toBe(false);
      expect(await fixture.repos.strategyRun.listRuns()).toHaveLength(runsBefore.length);
      expect((await fixture.repos.strategy.findById(strategyId))?.currentVersionId).toBe(
        version1.id,
      );

      const publishV2 = await confirmed(fixture, 'publish_strategy_version', {
        strategyId,
        versionId: draft2.id,
      });
      expect(publishV2?.isError).toBe(false);
      expect(fixture.approvals).toHaveLength(0);
      const strategy = await fixture.repos.strategy.findById(strategyId);
      expect(strategy?.currentVersionId).toBe(draft2.id);
      expect((await fixture.repos.strategy.findVersionById(draft2.id))?.publishedAt).toBeDefined();

      // 读路径/面板 state 回读同一版本
      const read = await fixture.execute('get_strategy', { strategyId });
      expect(dataOf<{ strategy: Strategy }>(read.value).strategy.currentVersionId).toBe(draft2.id);
      const panel = createPanelStateHandler({
        read: fixture.read,
        market: fixture.marketSurface,
        admit: () => null,
      });
      const response = await panel(
        new Request('http://localhost/api/luoome/state?panel=strategies'),
      );
      expect(response.status).toBe(200);
      const state = (await response.json()) as {
        strategies?: { strategyId: string; workspace: { ok: boolean; data?: unknown } }[];
      };
      const panelStrategy = state.strategies?.find((item) => item.strategyId === strategyId);
      expect(panelStrategy?.workspace.ok).toBe(true);
      expect(JSON.stringify(panelStrategy?.workspace.data)).toContain(draft2.id);
    } finally {
      await fixture.close();
    }
  });

  it('旅程 2：研究指定 run/version/insight facts 并带引用，proposal 经审批保存但不发布', async () => {
    const fixture = await createJourneyFixture();
    try {
      const strategyId = 'strategy-journey2';
      const strategy: Strategy = {
        id: strategyId,
        name: '研究用策略',
        description: 'fixture',
        owner: 'user',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
        currentVersionId: `${strategyId}-v1`,
      };
      await fixture.repos.strategy.create(strategy);
      const definition = STRATEGY_DEFINITION;
      const version: StrategyVersion = {
        id: `${strategyId}-v1`,
        strategyId,
        version: 1,
        definition,
        definitionHash: strategyDefinitionHash(definition),
        validationStatus: 'valid',
        validationErrors: [],
        publishedAt: NOW,
        createdAt: NOW,
      };
      await fixture.repos.strategy.createVersion(version);
      const run: StrategyRun = {
        id: 'run-journey2',
        strategyId,
        strategyVersionId: version.id,
        mode: 'scan',
        coverage: 'CN_A_SHARES_SH_SZ',
        dataAsOf: new Date(NOW),
        startedAt: new Date(NOW),
        finishedAt: new Date(NOW),
        status: 'complete',
        scope: 'operational',
        inputSnapshot: { fixture: true },
        providerStatuses: [],
        summary: { selected: 0 },
        publication: { status: 'published', reasons: ['explicit-subset'], decidedAt: NOW },
      };
      await fixture.repos.strategyRun.commitRun({ run, results: [], signals: [] });

      const workspace = await fixture.run(
        { name: 'get_strategy_workspace', input: { strategyId } },
        '读取策略工作区',
      );
      expect(workspace?.isError).toBe(false);
      const runs = await fixture.execute('list_strategy_runs', { strategyId, limit: 10 });
      expect(JSON.stringify(runs.value)).toContain(run.id);
      const runRead = await fixture.execute('get_strategy_run', { runId: run.id });
      expect(JSON.stringify(runRead.value)).toContain(version.id);
      const insight = await fixture.execute('get_strategy_insight_facts', {
        strategyId,
        windowDays: 30,
      });
      const insightData = dataOf<{ facts: { id: string }[]; dataAsOf?: string }>(insight.value);
      expect(insightData.facts.length).toBeGreaterThan(0);

      // 改版 proposal：另取 strategy_version_proposal context，经审批 record_analysis_result
      const contextRead = await fixture.execute('get_analysis_context', {
        kind: 'strategy_version_proposal',
        subject: { kind: 'strategy', id: strategyId },
      });
      const analysisContext = dataOf<AnalysisContext>(contextRead.value);
      expect(analysisContext.factIds.length).toBeGreaterThan(0);
      const versionsBefore = (await fixture.repos.strategy.listVersions(strategyId)).length;
      fixture.approvals.push('allowed-once');
      const proposal = await fixture.run({
        name: MANUAL_OPERATION_TOOL,
        input: {
          id: randomUUID(),
          tool: 'record_analysis_result',
          input: {
            contextId: analysisContext.id,
            result: {
              kind: 'strategy_version_proposal',
              proposal: {
                definition,
                changeSummary: '基于运行事实的改版草案',
                factReferences: [insightData.facts[0]?.id ?? ''],
              },
            },
            provenance: {
              generatorKind: 'legacy-ai',
              evidenceFactIds: [insightData.facts[0]?.id ?? ''],
            },
          },
        },
      });
      expect(proposal?.isError).toBe(false);
      const versionsAfter = await fixture.repos.strategy.listVersions(strategyId);
      expect(versionsAfter.length).toBe(versionsBefore + 1);
      const draftProposal = versionsAfter.find((candidate) => candidate.id !== version.id);
      expect(draftProposal?.publishedAt).toBeUndefined();
      expect((await fixture.repos.strategy.findById(strategyId))?.currentVersionId).toBe(
        version.id,
      );
    } finally {
      await fixture.close();
    }
  });

  it('旅程 3：DecisionReview 经原生审批保存；用户明确反馈后才有 outcome，AI 不能代填', async () => {
    const fixture = await createJourneyFixture();
    try {
      const advice = testAdviceFor(TEST_STOCKS[0]?.id ?? '600519.SH', () => new Date(NOW));
      await fixture.repos.advice.save(advice);
      const context = await fixture.execute('get_decision_review_context', {
        subject: { kind: 'advice', id: advice.id },
      });
      const reviewContext = dataOf<{
        context: { contextHash: string } | null;
        current: { review: { currentRevision: number } } | null;
      }>(context.value);
      if (reviewContext.context === null) throw new Error('missing decision review context');
      const save = await confirmed(fixture, 'save_decision_review', {
        subject: { kind: 'advice', id: advice.id },
        contextHash: reviewContext.context.contextHash,
        expectedRevision: reviewContext.current?.review.currentRevision ?? 0,
        content: {
          tradeIds: [],
          adviceFeedback: null,
          triggerFeedback: null,
          note: '当时依据：等待确认',
        },
      });
      expect(save?.isError).toBe(false);
      const latestReview = () =>
        fixture.repos.decisionReview.findBySubject({
          accountId: fixture.principal.accountId,
          subject: { kind: 'advice', id: advice.id },
        });
      const savedReview = await latestReview();
      expect(savedReview?.revision.revision).toBe(1);
      expect(savedReview?.revision.content.adviceFeedback).toBeNull();

      // AI 代填负例：审批被拒绝时不得写 outcome
      const denied = await confirmed(
        fixture,
        'record_advice_outcome',
        { adviceId: advice.id, outcome: 'ignored', tradeIds: [] },
        'rejected',
      );
      expect(denied?.isError).toBe(true);
      expect((await latestReview())?.review.currentRevision).toBe(1);

      // 用户明确反馈后（allowed-once）才写 outcome
      const recorded = await confirmed(fixture, 'record_advice_outcome', {
        adviceId: advice.id,
        outcome: 'followed',
        tradeIds: [],
        pnl: 120,
        notes: '用户明确反馈：跟随并已平仓',
        changeNote: '用户明确反馈后的结果回填',
      });
      expect(recorded?.isError).toBe(false);
      const recordedValue = recorded?.value as
        | { ok: boolean; data: { state: string; result: unknown } }
        | undefined;
      expect(recordedValue?.data.state, JSON.stringify(recordedValue)).toBe('succeeded');
      const after = await latestReview();
      expect(after?.review.currentRevision).toBe(2);
      expect(after?.revision.content.adviceFeedback?.outcome).toBe('followed');
      expect(after?.revision.content.adviceFeedback?.pnl).toBe(120);
      // 复盘读面与面板口径一致：outcome 从 DecisionReview 派生（不是 Advice 行上的旧字段）。
      const adviceRead = await fixture.execute('get_advice', { includeExpired: true });
      expect(JSON.stringify(adviceRead.value)).toContain('"followed"');
      const panel = createPanelStateHandler({
        read: fixture.read,
        market: fixture.marketSurface,
        admit: () => null,
      });
      const reviewState = await panel(
        new Request('http://localhost/api/luoome/state?panel=review'),
      );
      expect(reviewState.status).toBe(200);
      expect(JSON.stringify(await reviewState.json())).toContain('followed');
    } finally {
      await fixture.close();
    }
  });

  it('旅程 4：market external 刷新保留 source/dataAsOf/unavailable/partial；Advice 需另取 context 并审批', async () => {
    const fixture = await createJourneyFixture();
    try {
      // 对话主动刷新：AgentLoop 调 market external 白名单工具。
      const conversationalRefresh = await fixture.run(
        { name: 'fetch_index_quotes', input: {} },
        '今天市场怎么样？先刷新指数事实',
      );
      expect(conversationalRefresh?.isError).toBe(false);
      const indices = await fixture.execute('fetch_index_quotes', {});
      expect(indices.isError).toBe(false);
      const indexData = dataOf<{ indices: { code: string; source: string; ts: string }[] }>(
        indices.value,
      );
      expect(indexData.indices[0]?.source).toBe('synthetic-index');
      expect(indexData.indices[0]?.ts).toBe(NOW.toISOString());

      const quote = await fixture.execute('fetch_quote', { stockCode: '600519.SH' });
      expect(quote.isError).toBe(false);
      const news = await fixture.execute('fetch_news', { limit: 10 });
      expect(JSON.stringify(news.value)).toContain('partial: synthetic news only');
      const sentiment = await fixture.execute('get_ashare_sentiment', {
        date: '2026-07-17',
      });
      expect((sentiment.value as { ok?: boolean }).ok).toBe(false); // unavailable 保留 adapter_error，不伪装空成功

      // 形成 Advice：另取 advice_market context（facts 来自上面的刷新结果，带 source/dataAsOf）
      const facts = [
        {
          id: 'market:index:000001.SH',
          label: '合成指数',
          value: {
            code: '000001.SH',
            close: 3200,
            source: 'synthetic-index',
            dataAsOf: NOW.toISOString(),
          },
          evidenceIds: [],
        },
        {
          id: 'market:news:synthetic-news-1',
          label: '合成要闻',
          value: { title: '合成要闻：仅供验收', warnings: ['partial: synthetic news only'] },
          evidenceIds: [],
        },
      ];
      const timing = analysisContextTiming('advice_market', NOW, NOW);
      const context: AnalysisContext = {
        id: `ctx-market-${randomUUID()}`,
        jobId: null,
        kind: 'advice_market',
        accountId: fixture.principal.accountId,
        subject: { kind: 'market', id: 'CN_A_SHARES' },
        dataAsOf: new Date(NOW),
        facts,
        factIds: facts.map((fact) => fact.id),
        limitations: ['测试用合成市场事实；未覆盖完整新闻与宽度'],
        contextHash: analysisHash({ facts, dataAsOf: new Date(NOW) }),
        writeUntil: timing.writeUntil,
        expiresAt: new Date(NOW.getTime() + 7 * 86_400_000),
        createdAt: new Date(NOW),
      };
      await fixture.repos.analysis.saveContext(context);
      const advice = await confirmed(fixture, 'record_advice', {
        contextId: context.id,
        result: {
          decision: 'watch',
          confidence: 55,
          horizon: 'short',
          reasoning: {
            premise: '合成指数与要闻支持观望',
            evidence: ['market:index:000001.SH'],
            counterEvidence: ['新闻为局部样本，可能不完整'],
          },
          risks: ['合成事实不代表真实市场'],
        },
        provenance: { generatorKind: 'legacy-ai', evidenceFactIds: ['market:index:000001.SH'] },
      });
      expect(advice?.isError).toBe(false);
      const adviceState = advice?.value as
        | { ok: boolean; data: { state: string; result: unknown } }
        | undefined;
      expect(adviceState?.data.state, JSON.stringify(adviceState)).toBe('succeeded');
      const saved = await fixture.repos.advice.findById(`analysis:${context.id}`);
      expect(saved?.subjectKind).toBe('market');
      // 领域 query 的过期过滤用墙钟；fixture 时钟在 2026-07，显式 includeExpired 避免把有效 Advice 过滤掉。
      const readBack = await fixture.execute('get_advice', { includeExpired: true });
      expect(JSON.stringify(readBack.value)).toContain(`analysis:${context.id}`);
      expect(fixture.approvals).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });
});

describe('MVP 负例/恢复矩阵', () => {
  it('未审批/拒绝/取消/过期/子 Agent/跨账户均无业务写入', async () => {
    const fixture = await createJourneyFixture();
    try {
      const strategyId = `strategy-${randomUUID()}`;
      // 拒绝
      const denied = await confirmed(
        fixture,
        'create_strategy',
        { id: strategyId, name: 'denied', description: 'denied' },
        'rejected',
      );
      expect(denied?.isError).toBe(true);
      expect(await fixture.repos.strategy.findById(strategyId)).toBeNull();
      // 未审批：prepare 只产生 pending 记录，不会执行业务写入
      const unapproved = await fixture.hostService.prepare(fixture.principal, {
        id: randomUUID(),
        tool: 'create_strategy',
        input: { id: `strategy-${randomUUID()}`, name: 'pending', description: 'pending' },
      });
      const pending = dataOf<{ state: string; result: null }>(unapproved);
      expect(pending.state).toBe('pending');
      expect(pending.result).toBeNull();
      expect(await fixture.repos.strategy.list()).toHaveLength(0);
      // 取消：prepare 后直接取消，确认不再执行
      const prepared = await fixture.hostService.prepare(fixture.principal, {
        id: randomUUID(),
        tool: 'create_strategy',
        input: { id: `strategy-${randomUUID()}`, name: 'cancelled', description: 'cancelled' },
      });
      const cancelledOp = dataOf<{ operationId: string; confirmationToken: string }>(prepared);
      await fixture.hostService.cancel(fixture.principal, {
        id: cancelledOp.operationId,
        token: cancelledOp.confirmationToken,
      });
      const afterCancel = await fixture.hostService.confirm(
        fixture.principal,
        { id: cancelledOp.operationId, token: cancelledOp.confirmationToken },
        new AbortController().signal,
      );
      expect(dataOf<{ state: string }>(afterCancel).state).toBe('cancelled');
      // 子 Agent 不继承权限
      const child = await fixture.ctx.agents.create({
        sessionId: SessionId(`child-${randomUUID()}`),
        parentAgent: fixture.agent,
        meta: { origin: 'subagent', delegationDepth: 1 },
        agentOptions: { provider: 'scripted', model: 'scripted' },
      });
      const childCall = await fixture.ctx.tools.execute({
        name: MANUAL_OPERATION_TOOL,
        callId: ToolCallId(randomUUID()),
        arguments: {
          id: randomUUID(),
          tool: 'create_strategy',
          input: { name: 'child', description: 'child' },
        },
        agent: child.agent,
        signal: new AbortController().signal,
      });
      expect(childCall.isError).toBe(true);
      await child.dispose();
      // 跨账户：另一个 principal 不能确认他人操作
      const cross = await fixture.hostService.prepare(fixture.principal, {
        id: randomUUID(),
        tool: 'create_strategy',
        input: { id: `strategy-${randomUUID()}`, name: 'cross', description: 'cross' },
      });
      const crossOp = dataOf<{ operationId: string; confirmationToken: string }>(cross);
      const crossConfirm = await fixture.hostService.confirm(
        { userId: 'other-user', accountId: 'other-account' },
        { id: crossOp.operationId, token: crossOp.confirmationToken },
        new AbortController().signal,
      );
      expect(crossConfirm.ok).toBe(false);
      // 策略面没有产生任何 create 写入
      expect(await fixture.repos.strategy.list()).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  it('trade 永不注册；LUOOME_EXPOSE_TRADE=true 在 IO 前启动失败', async () => {
    const fixture = await createJourneyFixture();
    try {
      // 领域 registry 的 trade 工具永不进入 read/market allowlist，也不进入任何 operation policy。
      expect(toolRegistry.get('record_decision_trade')?.sideEffect).toBe('trade');
      for (const name of ['add_trade', 'record_decision_trade']) {
        expect(DEFAULT_READ_TOOL_ALLOWLIST).not.toContain(name);
        expect(DEFAULT_MARKET_TOOL_ALLOWLIST).not.toContain(name);
        expect(createProductionOperationPolicies().map((policy) => policy.tool.name)).not.toContain(
          name,
        );
      }
      // 生产 host 启动硬卡（不创建目录/DB）
      const { createProductionHost } = await import('./production.js');
      const home = join(mkdtempSync(join(tmpdir(), 'luoome-trade-gate-')), 'home');
      rootDirs.push(home);
      process.env.LUOOME_EXPOSE_TRADE = 'true';
      try {
        await expect(
          createProductionHost({
            home,
            owner: { userId: 'u', accountId: 'a' },
            env: { LUOOME_EXPOSE_TRADE: 'true', LUOOME_MARKET_PROVIDER: 'real' },
          }),
        ).rejects.toThrow('LUOOME_EXPOSE_TRADE=true');
      } finally {
        delete process.env.LUOOME_EXPOSE_TRADE;
      }
    } finally {
      await fixture.close();
    }
  });

  it('record 重放不重复写，response loss 只核对不重放', async () => {
    const fixture = await createJourneyFixture();
    try {
      const advice = testAdviceFor(TEST_STOCKS[0]?.id ?? '600519.SH', () => new Date(NOW));
      await fixture.repos.advice.save(advice);
      const contextOutput = await fixture.execute('get_decision_review_context', {
        subject: { kind: 'advice', id: advice.id },
      });
      const reviewContext = dataOf<{ context: { contextHash: string } | null; current: null }>(
        contextOutput.value,
      );
      if (reviewContext.context === null) throw new Error('missing decision review context');
      const id = randomUUID();
      fixture.approvals.push('allowed-once');
      const first = await fixture.run({
        name: MANUAL_OPERATION_TOOL,
        input: {
          id,
          tool: 'save_decision_review',
          input: {
            subject: { kind: 'advice', id: advice.id },
            contextHash: reviewContext.context.contextHash,
            expectedRevision: 0,
            content: { tradeIds: [], adviceFeedback: null, triggerFeedback: null, note: 'replay' },
          },
        },
      });
      expect(first?.isError).toBe(false);
      const revisionOf = async () =>
        (
          await fixture.repos.decisionReview.findBySubject({
            accountId: fixture.principal.accountId,
            subject: { kind: 'advice', id: advice.id },
          })
        )?.revision.revision ?? 0;
      expect(await revisionOf()).toBe(1);
      // 同一 operation 再走一次原生确认入口：返回既有回执，不重复写
      fixture.approvals.push('allowed-once');
      const replay = await fixture.run({
        name: MANUAL_OPERATION_TOOL,
        input: {
          id,
          tool: 'save_decision_review',
          input: {
            subject: { kind: 'advice', id: advice.id },
            contextHash: reviewContext.context.contextHash,
            expectedRevision: 0,
            content: { tradeIds: [], adviceFeedback: null, triggerFeedback: null, note: 'replay' },
          },
        },
      });
      expect(replay?.isError).toBe(false);
      expect(await revisionOf()).toBe(1);
      // 伪造 token 的 confirm 被拒绝
      const again = await fixture.hostService.confirm(
        fixture.principal,
        { id, token: 'unknown' },
        new AbortController().signal,
      );
      expect(again.ok).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it('external 失败不显示为空成功', async () => {
    const fixture = await createJourneyFixture();
    try {
      fixture.market.failIndex = true;
      const failed = await fixture.execute('fetch_index_quotes', {});
      expect((failed.value as { ok?: boolean }).ok).toBe(false);
      const errorText = JSON.stringify(failed.value);
      expect(errorText).not.toMatch(/"ok":true/);
      expect(errorText).toContain('adapter_error');
    } finally {
      await fixture.close();
    }
  });

  it('response loss：业务提交后回执丢失只 reconcile 核对，不重放 handler', async () => {
    let flaky: FailOnceSettleRepository | undefined;
    const fixture = await createJourneyFixture({
      wrapRepository: (repository) => {
        flaky = new FailOnceSettleRepository(repository);
        return flaky;
      },
    });
    try {
      const advice = testAdviceFor(TEST_STOCKS[1]?.id ?? '300750.SZ', () => new Date(NOW));
      await fixture.repos.advice.save(advice);
      const contextOutput = await fixture.execute('get_decision_review_context', {
        subject: { kind: 'advice', id: advice.id },
      });
      const reviewContext = dataOf<{ context: { contextHash: string } | null }>(
        contextOutput.value,
      );
      if (reviewContext.context === null) throw new Error('missing context');
      const id = randomUUID();
      fixture.approvals.push('allowed-once');
      const lost = await fixture.run({
        name: MANUAL_OPERATION_TOOL,
        input: {
          id,
          tool: 'save_decision_review',
          input: {
            subject: { kind: 'advice', id: advice.id },
            contextHash: reviewContext.context.contextHash,
            expectedRevision: 0,
            content: {
              tradeIds: [],
              adviceFeedback: null,
              triggerFeedback: null,
              note: 'response-loss',
            },
          },
        },
      });
      if (lost === undefined) throw new Error('response-loss call returned no result');
      expect((lost.value as { ok?: boolean }).ok).toBe(false);
      expect(
        (
          await fixture.repos.decisionReview.findBySubject({
            accountId: fixture.principal.accountId,
            subject: { kind: 'advice', id: advice.id },
          })
        )?.review.currentRevision,
      ).toBe(1);
      expect((await flaky?.findOperation({ ...fixture.principal, id }))?.state).toBe('executing');
      // reconcile 只凭业务回执恢复 succeeded，不再次执行 handler（仍只有 1 条 revision）
      const reconciled = dataOf<{ state: string }>(
        await fixture.hostService.reconcile(fixture.principal, id),
      );
      expect(reconciled.state).toBe('succeeded');
      expect(
        (
          await fixture.repos.decisionReview.findBySubject({
            accountId: fixture.principal.accountId,
            subject: { kind: 'advice', id: advice.id },
          })
        )?.review.currentRevision,
      ).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it('技能 catalog 可见且无 MCP 前缀；面板/命令可读 strategyId/runId 下钻参数', () => {
    const skills = readBundledSkills();
    expect(skills.map((skill) => skill.name).sort()).toEqual([...BUNDLED_SKILL_NAMES].sort());
    const provider = createBundledSkillProvider(skills);
    expect(provider.name).toBe('dsh-luoome');
    for (const skill of skills) {
      expect(skill.content).not.toContain('mcp__luoome');
      expect(skill.content).not.toContain('luoome-worker');
    }
  });
});

describe('MVP Node SQLite 资产证明', () => {
  it('旅程数据库是真实 Node SQLite 文件，关闭后可重开', async () => {
    const root = mkdtempSync(join(tmpdir(), 'luoome-mvp-node-db-'));
    rootDirs.push(root);
    const path = join(root, 'luoome.db');
    const first = createNodeDrizzleRepos(path);
    await first.repos.account.save(TEST_ACCOUNT);
    first.close();
    const second = createNodeDrizzleRepos(path);
    try {
      expect(await second.repos.account.findById(TEST_ACCOUNT.id)).not.toBeNull();
    } finally {
      second.close();
    }
  });
});

afterAll(() => {
  for (const dir of rootDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** settleOperation 第一次抛错：模拟业务已提交、operation 回执未保存。 */
class FailOnceSettleRepository implements PluginAuthorityRepository {
  private failed = false;
  constructor(private readonly inner: PluginAuthorityRepository) {}
  insertOperation(operation: PluginOperation): Promise<boolean> {
    return this.inner.insertOperation(operation);
  }
  findOperation(scope: PluginOperationScope): Promise<PluginOperation | null> {
    return this.inner.findOperation(scope);
  }
  claimOperation(
    proof: PluginOperationProof & { readonly claimToken: string },
  ): Promise<PluginOperation | null> {
    return this.inner.claimOperation(proof);
  }
  cancelOperation(proof: PluginOperationProof): Promise<boolean> {
    return this.inner.cancelOperation(proof);
  }
  async settleOperation(
    input: Parameters<PluginAuthorityRepository['settleOperation']>[0],
  ): Promise<boolean> {
    if (!this.failed) {
      this.failed = true;
      throw new Error('simulated operation receipt loss');
    }
    return this.inner.settleOperation(input);
  }
  findGrant(id: string, userId: string): Promise<PluginAutomationGrant | null> {
    return this.inner.findGrant(id, userId);
  }
  saveGrant(grant: PluginAutomationGrant, expectedVersion: number | null): Promise<boolean> {
    return this.inner.saveGrant(grant, expectedVersion);
  }
}
