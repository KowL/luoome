import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import {
  type ContextFormed,
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
  ToolCallId,
} from '@deepseek-ai/dsh-llm';
import { money, type PluginAutomationGrant } from '@luoome/core';
import {
  decisionReviewOperation,
  enqueueAnalysisJobTool,
  pluginInputHash,
  pluginInputJson,
  toolRegistry,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { z } from 'zod';
import { MANUAL_OPERATION_TOOL } from '../host/dsh-authority.js';
import { dshScheduleHash } from '../host/dsh-identity.js';
import { createMarketSurface } from '../host/market-surface.js';
import { installQueueProbe, installWorkerPreflight } from '../host/preflight.js';
import { createReadSurface } from '../host/read-surface.js';
import { mountDshWebProfile } from '../host/web-profile.js';
import { scheduledOperationFixture } from './dsh-host.js';

// The pinned SDK barrel omits its runtime-context MessageSourceMap augmentation.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': { kind: 'runtime-context' } & ContextFormed;
  }
}

class BrowserFixtureModel extends LlmAdapter {
  requests = 0;
  override async listModels(provider: string) {
    return [
      {
        provider,
        id: 'scripted',
        name: '隔离验收模型（无网络）',
        inputModalities: ['text' as const],
      },
    ];
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++;
    const last = options.messages
      .filter(
        (message) =>
          message.role !== 'system' &&
          message.role !== 'developer' &&
          !('source' in message && message.source?.kind === 'runtime-context'),
      )
      .at(-1);
    const text =
      last?.role === 'user'
        ? last.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
        : '';
    const parsed = z
      .union([
        z.object({ id: z.uuid(), tool: z.string(), input: z.unknown() }).strict(),
        z.object({ readTool: z.string(), input: z.unknown() }).strict(),
      ])
      .safeParse(
        (() => {
          try {
            return JSON.parse(text);
          } catch {
            return null;
          }
        })(),
      );
    if (parsed.success) {
      const id = ToolCallId(randomUUID());
      const name = 'readTool' in parsed.data ? parsed.data.readTool : MANUAL_OPERATION_TOOL;
      const args = JSON.stringify('readTool' in parsed.data ? parsed.data.input : parsed.data);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index: 0,
        id,
        name,
        argumentsDelta: args,
      };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name, arguments: args },
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '隔离验收已结束，请核对操作回执。' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '隔离验收已结束，请核对操作回执。' },
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}

export const inject = [
  'connection',
  'webServer',
  'sessionController',
  'approval',
  'schedule',
  'llm',
  'tools',
  'agents',
  'sessions',
];
export async function apply(ctx: Context) {
  const domain = await buildTestContext({ clock: () => new Date() });
  const principal = { userId: 'acceptance-owner', accountId: domain.user.defaultAccountId };
  const model = new BrowserFixtureModel();
  const { batch, policy } = scheduledOperationFixture();
  ctx.llm.registerAdapter(['luoome-fixture'], model);
  mountDshWebProfile(ctx, {
    repository: domain.repos.pluginAuthority,
    policies: [decisionReviewOperation, policy],
    capabilities: ['write', 'external'],
    policyVersion: 1,
    now: Date.now,
    context: () => domain,
    profile: 'luoome-acceptance',
    principalForOwner: () => principal,
    principalForSession: () => principal,
    automationsEnabled: false,
    read: createReadSurface({
      config: { allowlist: ['get_advice', 'get_decision_review_context'] },
      tools: toolRegistry.all(),
      context: () => domain,
    }),
    // 该 fixture 只验证审批/操作协议，不提供 market external 面。
    market: createMarketSurface({
      config: { allowlist: [] },
      tools: toolRegistry.all(),
      context: () => domain,
    }),
  });
  let readCalls = 0;
  ctx.on('tools/result', (execution, result) => {
    if (
      execution.name === 'get_advice' &&
      'value' in result &&
      z.object({ ok: z.literal(true) }).safeParse(result.value).success
    )
      readCalls++;
  });
  const unscopedRead = await ctx.tools.execute({
    name: 'get_advice',
    callId: ToolCallId(randomUUID()),
    arguments: {},
    signal: new AbortController().signal,
  });
  const session = await ctx.sessionController.create({ cwd: process.cwd() });
  const task = await ctx.schedule.create(session.sessionId, {
    title: '隔离授权验收',
    prompt: 'Synthetic approval fixture; production execution is disabled.',
    every_seconds: 3600,
  });
  const input = { accountId: principal.accountId, label: 'browser-grant-fixture' };
  const grantTime = Date.now();
  const grantCandidate: PluginAutomationGrant = {
    id: 'browser-acceptance-grant',
    identity: {
      userId: principal.userId,
      profile: 'luoome-acceptance',
      sessionId: session.sessionId,
      taskId: task.id,
    },
    scheduleHash: dshScheduleHash(task),
    version: 1,
    policyVersion: 1,
    enabled: true,
    allowedCalls: [
      {
        tool: batch.name,
        accountId: principal.accountId,
        inputHash: pluginInputHash(input),
        inputJson: pluginInputJson(input),
        capabilities: ['write', 'external'],
      },
    ],
    createdAt: grantTime,
    updatedAt: grantTime,
    expiresAt: grantTime + 3_600_000,
  };
  ctx.connection.fetch.register({
    path: '/api/luoome-acceptance',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () =>
      Response.json({
        requests: model.requests,
        readCalls,
        unscopedReadDenied: unscopedRead.isError,
        adviceIds: (await domain.repos.advice.query({ includeExpired: true })).map((a) => a.id),
        grantCandidate,
        configuredGrantVersion:
          (await domain.repos.pluginAuthority.findGrant(grantCandidate.id, principal.userId))
            ?.version ?? null,
      }),
  });
}

// 隔离验收的队列 fixture 必须用固定交易日时钟：盘中行动类 context 的写回窗口是
// min(now+30min, 当日 15:00 Asia/Shanghai)，真实墙钟在收盘后/周末会让 enqueue 直接
// context_expired。固定 2026-10-22 10:00（周四）后，任何运行时刻都能稳定种出 ready 队列。
const FIXTURE_NOW = new Date('2026-10-22T02:00:00.000Z');
const fixtureClock = (): Date => new Date(FIXTURE_NOW.getTime());

// These entry points are bundled only into temporary acceptance profiles.
export async function applyProbe(ctx: Context, options: { state: 'ready' | 'empty' | 'error' }) {
  const domain = await buildTestContext({ clock: fixtureClock });
  if (options.state === 'ready') {
    await domain.repos.quote.save({
      stockId: '600519.SH',
      ts: domain.clock(),
      observedAt: domain.clock(),
      fetchedAt: domain.clock(),
      timestampSource: 'upstream',
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 1000,
      source: 'acceptance',
    });
    const queued = await enqueueAnalysisJobTool.execute(
      { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' }, source: 'schedule' },
      domain,
    );
    if (!queued.ok) throw new Error('Cannot seed acceptance queue');
  }
  const context = () => {
    if (options.state === 'error') throw new Error('Synthetic unavailable facts');
    return domain;
  };
  installQueueProbe(ctx, {
    context,
    report: (result) => process.stdout.write(`${result.state}\n`),
  });
}

export async function applyWorker(ctx: Context, options: { state: 'ready' | 'empty' | 'error' }) {
  const domain = await buildTestContext({ clock: fixtureClock });
  if (options.state === 'ready') {
    await domain.repos.quote.save({
      stockId: '600519.SH',
      ts: domain.clock(),
      observedAt: domain.clock(),
      fetchedAt: domain.clock(),
      timestampSource: 'upstream',
      open: money(100),
      high: money(101),
      low: money(99),
      close: money(100),
      volume: 1000,
      source: 'acceptance',
    });
    const queued = await enqueueAnalysisJobTool.execute(
      { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' }, source: 'schedule' },
      domain,
    );
    if (!queued.ok) throw new Error('Cannot seed acceptance queue');
  }
  const model = new BrowserFixtureModel();
  ctx.llm.registerAdapter(['luoome-fixture'], model);
  installWorkerPreflight(ctx, {
    context: () => {
      if (options.state === 'error') throw new Error('Synthetic unavailable facts');
      return domain;
    },
    ownsAgent: () => true,
    report: (result) => process.stdout.write(`preflight:${result.state}\n`),
  });
  ctx.on('agent/status', ({ status }) => {
    if (status === 'idle') process.stdout.write(`model-requests:${model.requests}\n`);
  });
}
