// REQ-M3-18 主路径补丁的验收：DSH 对话通道的回填必须由 harness 提问背书成 `origin=user`。
//
// 这里用**真实**的 `ctx.userQuestions`（`@deepseek-ai/dsh-user-questions`）+ 真实
// `ctx.on('user-questions/request')` 回答者（与 Web 客户端同一个瀑布位）跑通：
// 插件在 policy 的 bind 冻结输入之前提问 → 答案决定通道值 → 落库 revision 盖 `origin=user`
// → `get_advice_stats` 的分母真的长起来。
//
// 负例同样必须成立：宿主没有提问服务时仍是 `model`（模型自报不算用户回填）；用户选
// 「不知道」、超时、没有 answerer 一律**不写入**，且原因可见。
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { LlmAdapter, LlmRuntime, type StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import UserQuestionService from '@deepseek-ai/dsh-user-questions';
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
  PluginOperationNonTerminal,
  PluginOperationProof,
  PluginOperationScope,
  RepositoryRegistry,
  ToolContext,
} from '@luoome/core';
import { seedData } from '@luoome/db/memory';
import { createNodeDrizzleRepos, type NodeDrizzleReposHandle } from '@luoome/db/node';
import { buildContext, toolRegistry } from '@luoome/tools';
import { seedTestStockUniverse } from '@luoome/tools/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adviceOutcomeAskerOf } from './advice-outcome-ask.js';
import { createDshOperationHost, OPERATION_STATUS_TOOL } from './dsh-authority.js';
import { createProductionOperationPolicies } from './production.js';
import { DEFAULT_READ_TOOL_ALLOWLIST } from './production-config.js';
import { createReadSurface } from './read-surface.js';
import { registerReadTools } from './tools.js';

const NOW = new Date('2026-07-17T02:00:00.000Z');
const MANUAL_OPERATION_TOOL = 'luoome_confirmed_operation';
const ADVICE_OUTCOME_QUESTION_ID = 'luoome-advice-outcome';
const rootDirs: string[] = [];

afterEach(() => {
  for (const dir of rootDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** 不驱动对话的适配器：这里直接调 `ctx.tools.execute`，模型只负责让 Agent 可创建。 */
class IdleModel extends LlmAdapter {
  // biome-ignore lint/correctness/useYield: 本文件不驱动对话轮次
  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error('the acceptance tests drive tools directly, not the model');
  }
}

/** 回答者：模拟用户在 harness 问题卡片上选一项。 */
type Answerer = (request: {
  readonly questions: readonly { readonly id: string }[];
}) => Promise<{ answers: { id: string; selected: string[]; custom?: string }[] }>;

interface Fixture {
  readonly ctx: Context;
  readonly dbPath: string;
  readonly db: NodeDrizzleReposHandle;
  readonly repos: RepositoryRegistry;
  readonly principal: { userId: string; accountId: string };
  readonly hostService: ReturnType<typeof createDshOperationHost>['service'];
  /** 通过真实 `ctx.tools.execute` 调一次 `luoome_confirmed_operation`。 */
  confirm(tool: string, input: unknown): Promise<unknown>;
  /** 任意工具调用（`luoome_operation_status`、`get_advice_stats` 等）。 */
  call(name: string, input: unknown): Promise<unknown>;
  close(): Promise<void>;
}

const createFixture = async (
  options: {
    /** 重启时复用已有数据库，不重复 seed。 */
    readonly dbPath?: string;
    /** `false` 时宿主不挂 `userQuestions`：对应「没有 harness 提问通道」的降级路径。 */
    readonly withUserQuestions?: boolean;
    readonly answerer?: Answerer;
    readonly askTimeoutMs?: number;
    readonly wrapRepository?: (repository: PluginAuthorityRepository) => PluginAuthorityRepository;
  } = {},
): Promise<Fixture> => {
  let dbPath = options.dbPath;
  if (dbPath === undefined) {
    const root = mkdtempSync(join(tmpdir(), 'luoome-outcome-origin-'));
    rootDirs.push(root);
    dbPath = join(root, 'luoome.db');
  }
  const db = createNodeDrizzleRepos(dbPath);
  if (options.dbPath === undefined)
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
  ctx.llm.registerAdapter(['idle'], new IdleModel());
  await mount(AgentLoop, { agents: [], maxParallelToolCalls: 1 });
  if (options.withUserQuestions !== false) await mount(UserQuestionService);
  const answerer = options.answerer;
  if (answerer !== undefined)
    ctx.on('user-questions/request', async (request) => answerer(request));

  const domain: ToolContext = buildContext({
    repos: db.repos,
    adapters: {
      market: new FakeMarketAdapter({ clock: () => new Date(NOW), timestampSource: 'upstream' }),
    },
    user: { id: 'origin-owner', defaultAccountId: TEST_ACCOUNT.id },
    identity: { mode: 'local', userId: 'origin-owner' },
    clock: () => new Date(NOW),
    logger: silentLogger,
  });
  if (options.dbPath === undefined) await seedTestStockUniverse(domain);
  const principal = Object.freeze({ userId: 'origin-owner', accountId: TEST_ACCOUNT.id });
  const read = createReadSurface({
    config: { allowlist: [...DEFAULT_READ_TOOL_ALLOWLIST] },
    tools: toolRegistry.all(),
    context: () => domain,
  });
  registerReadTools(ctx.tools, read);

  const baseRepository = db.repos.pluginAuthority;
  const host = createDshOperationHost(ctx, {
    repository: options.wrapRepository?.(baseRepository) ?? baseRepository,
    policies: createProductionOperationPolicies(),
    capabilities: ['read', 'write', 'external', 'queue'],
    policyVersion: 1,
    now: () => NOW.getTime(),
    context: () => domain,
    profile: 'advice-outcome-origin',
    principalForSession: () => principal,
    automationsEnabled: false,
    // 默认走真实 `ctx.userQuestions`；只有显式给 timeout 时换成同一条 asker 的短上限。
    ...(options.askTimeoutMs === undefined
      ? {}
      : (() => {
          const asker = adviceOutcomeAskerOf(ctx, { timeoutMs: options.askTimeoutMs });
          return asker === undefined ? {} : { askAdviceOutcome: asker };
        })()),
  });

  const handle = await ctx.agents.create({
    sessionId: SessionId('advice-outcome-origin'),
    agentOptions: { provider: 'idle', model: 'idle' },
  });
  const call = (name: string, input: unknown) =>
    ctx.tools.execute({
      name,
      callId: ToolCallId(randomUUID()),
      arguments: input,
      agent: handle.agent,
      signal: new AbortController().signal,
    });
  return {
    ctx,
    dbPath,
    db,
    repos: db.repos,
    principal,
    hostService: host.service,
    call,
    confirm: (tool, input) => call(MANUAL_OPERATION_TOOL, { id: randomUUID(), tool, input }),
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

/** 工具执行结果里的业务值（pre-execute 拒绝时没有 `value`，只有 `error`/`content`）。 */
const toolValue = (executed: unknown): unknown =>
  typeof executed === 'object' && executed !== null && 'value' in executed
    ? (executed as { value: unknown }).value
    : null;

const dataOf = <T>(value: unknown): T => {
  if (!isOk(value)) throw new Error(`tool failed: ${JSON.stringify(value)}`);
  return value.data as T;
};

/** 一次执行的完整可见输出：业务失败、pre-execute 拒绝、取消都能读到原因。 */
const executedText = (executed: unknown): string => JSON.stringify(executed);

const executedIsError = (executed: unknown): boolean =>
  typeof executed === 'object' &&
  executed !== null &&
  (executed as { isError?: unknown }).isError === true;

/** 四项固定选项的回答者：按用户点的那一项作答。 */
const picking =
  (label: string): Answerer =>
  async () => ({
    answers: [{ id: ADVICE_OUTCOME_QUESTION_ID, selected: [label] }],
  });

const seedAdvice = async (fixture: Fixture, index = 0) => {
  const advice = testAdviceFor(TEST_STOCKS[index]?.id ?? '600519.SH', () => new Date(NOW));
  await fixture.repos.advice.save(advice);
  return advice;
};

const outcomeOf = async (fixture: Fixture, adviceId: string) =>
  (
    await fixture.repos.decisionReview.findBySubject({
      accountId: fixture.principal.accountId,
      subject: { kind: 'advice', id: adviceId },
    })
  )?.revision.content.adviceFeedback ?? null;

const statsOf = async (fixture: Fixture) =>
  dataOf<{
    denominator: number;
    originCounts: { user: number; model: number };
    excluded: { nonUserOrigin: number };
  }>(toolValue(await fixture.call('get_advice_stats', {})));

describe('DSH 回填来源：harness 提问背书 origin=user（REQ-M3-18 主路径）', () => {
  it('用户亲自选「兑现」→ 落库 origin=user，且默认统计分母增长', async () => {
    const fixture = await createFixture({ answerer: picking('兑现') });
    try {
      const advice = await seedAdvice(fixture);
      const before = await statsOf(fixture);
      expect(before.denominator).toBe(0);
      expect(before.originCounts.user).toBe(0);

      const result = await fixture.confirm('record_advice_outcome', {
        adviceId: advice.id,
        outcome: 'followed',
        tradeIds: [],
        pnl: 120,
      });
      expect(executedIsError(result), executedText(result)).toBe(false);
      expect(dataOf<{ state: string }>(toolValue(result)).state).toBe('succeeded');

      const feedback = await outcomeOf(fixture, advice.id);
      expect(feedback?.outcome).toBe('followed');
      expect(feedback?.origin).toBe('user');

      const after = await statsOf(fixture);
      expect(after.denominator).toBe(1);
      expect(after.originCounts.user).toBe(1);
      expect(after.originCounts.model).toBe(0);
      expect(after.excluded.nonUserOrigin).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('宿主没有 userQuestions → 不提问，origin 仍是 model，默认分母不变', async () => {
    const fixture = await createFixture({ withUserQuestions: false });
    try {
      const advice = await seedAdvice(fixture);
      const result = await fixture.confirm('record_advice_outcome', {
        adviceId: advice.id,
        outcome: 'followed',
        tradeIds: [],
      });
      expect(executedIsError(result), executedText(result)).toBe(false);
      const feedback = await outcomeOf(fixture, advice.id);
      expect(feedback?.outcome).toBe('followed');
      expect(feedback?.origin).toBe('model');

      const stats = await statsOf(fixture);
      expect(stats.denominator).toBe(0);
      expect(stats.originCounts.model).toBe(1);
      expect(stats.excluded.nonUserOrigin).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it('用户选「不知道」→ 不写入：没有新修订，分母不变，原因可见', async () => {
    const fixture = await createFixture({ answerer: picking('不知道') });
    try {
      const advice = await seedAdvice(fixture);
      const result = await fixture.confirm('record_advice_outcome', {
        adviceId: advice.id,
        outcome: 'followed',
        tradeIds: [],
      });
      expect(executedIsError(result), executedText(result)).toBe(true);
      expect(executedText(result)).toContain('不知道');
      expect(await outcomeOf(fixture, advice.id)).toBeNull();
      expect(
        await fixture.repos.decisionReview.findBySubject({
          accountId: fixture.principal.accountId,
          subject: { kind: 'advice', id: advice.id },
        }),
      ).toBeNull();
      expect((await statsOf(fixture)).denominator).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('用户选了别的结论 → 不写入，并把用户选择回给模型', async () => {
    const fixture = await createFixture({ answerer: picking('忽略') });
    try {
      const advice = await seedAdvice(fixture);
      const result = await fixture.confirm('record_advice_outcome', {
        adviceId: advice.id,
        outcome: 'followed',
        tradeIds: [],
      });
      expect(executedIsError(result), executedText(result)).toBe(true);
      const text = executedText(result);
      expect(text).toContain('忽略');
      expect(text).toContain('ignored');
      expect(await outcomeOf(fixture, advice.id)).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it('没有 answerer（NO_PROVIDER）→ 明确降级，不写入也不记成 user', async () => {
    const fixture = await createFixture();
    try {
      const advice = await seedAdvice(fixture);
      const result = await fixture.confirm('record_advice_outcome', {
        adviceId: advice.id,
        outcome: 'followed',
        tradeIds: [],
      });
      expect(executedIsError(result), executedText(result)).toBe(true);
      expect(executedText(result)).toContain('NO_PROVIDER');
      expect(await outcomeOf(fixture, advice.id)).toBeNull();
      expect((await statsOf(fixture)).denominator).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it('提问超时 → 明确降级，不写入', async () => {
    const fixture = await createFixture({
      answerer: () => new Promise(() => {}),
      askTimeoutMs: 30,
    });
    try {
      const advice = await seedAdvice(fixture);
      const result = await fixture.confirm('record_advice_outcome', {
        adviceId: advice.id,
        outcome: 'followed',
        tradeIds: [],
      });
      expect(executedIsError(result), executedText(result)).toBe(true);
      expect(executedText(result)).toContain('超时');
      expect(await outcomeOf(fixture, advice.id)).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it('response loss：用户背书的写入按同一 origin 核对回执，reconcile 恢复 succeeded 且不重放', async () => {
    let flaky: FailOnceSettleRepository | undefined;
    const fixture = await createFixture({
      answerer: picking('兑现'),
      wrapRepository: (repository) => {
        flaky = new FailOnceSettleRepository(repository);
        return flaky;
      },
    });
    try {
      const advice = await seedAdvice(fixture);
      const id = randomUUID();
      const lost = await fixture.call(MANUAL_OPERATION_TOOL, {
        id,
        tool: 'record_advice_outcome',
        input: { adviceId: advice.id, outcome: 'followed', tradeIds: [], pnl: 66 },
      });
      expect(isOk(toolValue(lost))).toBe(false);
      // 业务已提交：revision 已带 user 戳，但 settle 丢了。
      expect((await outcomeOf(fixture, advice.id))?.origin).toBe('user');
      expect((await flaky?.findOperation({ ...fixture.principal, id }))?.state).toBe('executing');

      const reconciled = dataOf<{ state: string }>(
        await fixture.hostService.reconcile(fixture.principal, id),
      );
      expect(reconciled.state).toBe('succeeded');
      // reconcile 只核对回执，不重放 handler：仍只有一条修订。
      const review = await fixture.repos.decisionReview.findBySubject({
        accountId: fixture.principal.accountId,
        subject: { kind: 'advice', id: advice.id },
      });
      expect(review?.review.currentRevision).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it('跨重启：用户回填已提交但 settle 丢失，status reconcile 保留 user 来源且不重复写入', async () => {
    const answerer = vi.fn(picking('兑现'));
    const fixture = await createFixture({
      answerer,
      wrapRepository: (repository) => new FailOnceSettleRepository(repository),
    });
    const operationId = randomUUID();
    const scope = { accountId: fixture.principal.accountId, requestId: operationId };
    const feedback = { outcome: 'followed', origin: 'user', pnl: 66 };
    let committed: Awaited<ReturnType<RepositoryRegistry['decisionReview']['findWriteReceipt']>>;
    try {
      const advice = await seedAdvice(fixture);
      const commit = vi.spyOn(fixture.repos.decisionReview, 'commit');
      const lost = await fixture.call(MANUAL_OPERATION_TOOL, {
        id: operationId,
        tool: 'record_advice_outcome',
        input: { adviceId: advice.id, outcome: 'followed', tradeIds: [], pnl: 66 },
      });
      expect(toolValue(lost)).toMatchObject({ ok: false, error: { kind: 'internal' } });
      expect(answerer).toHaveBeenCalledTimes(1);
      expect(answerer).toHaveBeenCalledWith(
        expect.objectContaining({
          questions: [expect.objectContaining({ id: ADVICE_OUTCOME_QUESTION_ID })],
        }),
      );
      expect(commit).toHaveBeenCalledTimes(1);
      committed = await fixture.repos.decisionReview.findWriteReceipt(scope);
      expect(committed).toMatchObject({
        result: {
          review: { currentRevision: 1, subject: { kind: 'advice', id: advice.id } },
          revision: { revision: 1, content: { adviceFeedback: feedback } },
        },
      });
      expect(toolValue(await fixture.call(OPERATION_STATUS_TOOL, { operationId }))).toMatchObject({
        ok: true,
        data: { operationId, state: 'executing', result: null },
      });
    } finally {
      await fixture.close();
    }

    expect(() => fixture.db.sqlite.prepare('SELECT 1')).toThrow();
    const restartedAnswerer = vi.fn(picking('兑现'));
    const restarted = await createFixture({
      dbPath: fixture.dbPath,
      answerer: restartedAnswerer,
    });
    try {
      expect(restarted.ctx).not.toBe(fixture.ctx);
      expect(restarted.db.sqlite === fixture.db.sqlite).toBe(false);
      expect(restarted.hostService).not.toBe(fixture.hostService);
      expect(await restarted.repos.decisionReview.findWriteReceipt(scope)).toEqual(committed);
      expect(toolValue(await restarted.call(OPERATION_STATUS_TOOL, { operationId }))).toMatchObject(
        { ok: true, data: { operationId, state: 'executing', result: null } },
      );

      const commit = vi.spyOn(restarted.repos.decisionReview, 'commit');
      const reconciled = toolValue(
        await restarted.call(OPERATION_STATUS_TOOL, { operationId, reconcile: true }),
      );
      expect(reconciled).toMatchObject({
        ok: true,
        data: {
          operationId,
          state: 'succeeded',
          result: { ok: true, data: { replayed: true, outcome: feedback } },
        },
      });
      expect(toolValue(await restarted.call(OPERATION_STATUS_TOOL, { operationId }))).toEqual(
        reconciled,
      );
      expect(
        toolValue(await restarted.call(OPERATION_STATUS_TOOL, { operationId, reconcile: true })),
      ).toEqual(reconciled);
      const reviews = await restarted.repos.decisionReview.list({ accountId: scope.accountId });
      expect(reviews).toEqual([committed?.result]);
      const [review] = reviews;
      expect(review?.review.currentRevision).toBe(1);
      expect(review?.revision.content.adviceFeedback).toEqual(feedback);
      expect(await restarted.repos.decisionReview.findWriteReceipt(scope)).toEqual(committed);
      expect(commit).not.toHaveBeenCalled();
      expect(restartedAnswerer).not.toHaveBeenCalled();
    } finally {
      await restarted.close();
    }
  });
});

/** settle 丢一次：模拟业务已提交、回执未落库的 response loss。 */
class FailOnceSettleRepository implements PluginAuthorityRepository {
  private failed = false;
  constructor(private readonly inner: PluginAuthorityRepository) {}
  insertOperation(operation: PluginOperation): Promise<boolean> {
    return this.inner.insertOperation(operation);
  }
  findOperation(scope: PluginOperationScope): Promise<PluginOperation | null> {
    return this.inner.findOperation(scope);
  }
  listNonTerminalOperationsByAccount(
    accountId: string,
  ): Promise<readonly PluginOperationNonTerminal[]> {
    return this.inner.listNonTerminalOperationsByAccount(accountId);
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
