import { randomUUID } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, {
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { AnalysisContext } from '@luoome/core';
import { analysisHash, createPluginOperationService } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it, vi } from 'vitest';
import { createTriangleAnalysisOperation } from './analysis-operations.js';
import { createDshTriangleRoleRunner } from './triangle-role-runner.js';

const FACT = 'quote:600519.SH';
const NOW = new Date('2026-07-29T12:00:00Z');
const roles = {
  bull: {
    role: 'bull',
    factIds: [FACT],
    thesis: '支持',
    falsifiable: [1, 2, 3].map((n) => ({ statement: `条件${n}`, factIds: [FACT] })),
  },
  bear: { role: 'bear', factIds: [FACT], thesis: '反证', refutations: [] },
  judge: {
    role: 'judge',
    status: 'concluded',
    disagreementPoints: [],
    agreements: [],
    blockers: [],
  },
  'risk-officer': { role: 'risk-officer', status: 'veto', reason: '风险仍未排除', factIds: [FACT] },
} as const;
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  riskPass = false;
  constructor(
    private readonly mode:
      | 'normal'
      | 'unknown-usage'
      | 'fabricated-evidence'
      | 'truncated' = 'normal',
  ) {
    super();
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request);
    let output: unknown = roles[request.model as keyof typeof roles];
    if (this.riskPass && request.model === 'risk-officer')
      output = { role: 'risk-officer', status: 'pass' };
    if (this.mode === 'fabricated-evidence') output = { ...roles.bull, factIds: ['invented'] };
    yield { type: 'text-delta', index: 0, text: JSON.stringify(output) };
    if (this.mode !== 'unknown-usage')
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } };
    yield { type: 'finish', reason: { kind: this.mode === 'truncated' ? 'max-tokens' : 'stop' } };
  }
}
const setup = async (mode: ConstructorParameters<typeof ScriptedAdapter>[0] = 'normal') => {
  const host = new Context();
  const fiber = host.plugin(LlmRuntime);
  await fiber.await();
  const adapter = new ScriptedAdapter(mode);
  const unregister = host.llm.registerAdapter(['scripted'], adapter);
  const base = await buildTestContext({ clock: () => NOW, advices: [] });
  vi.spyOn(base.adapters.market, 'marketSourceStatus').mockReturnValue([
    {
      dataset: 'quote',
      source: 'test',
      coverage: ['CN_A_SHARES_SH_SZ'],
      capabilityEnabled: true,
      configurationReady: true,
      dataAsOf: NOW,
    },
  ]);
  const facts = [{ id: FACT, label: '行情', value: { close: 100 }, evidenceIds: [] }];
  const context: AnalysisContext = {
    id: 'triangle-context',
    jobId: null,
    kind: 'advice_stock',
    accountId: base.user.defaultAccountId,
    subject: { kind: 'stock', id: '600519.SH' },
    facts,
    factIds: [FACT],
    dataAsOf: NOW,
    missingFacts: [],
    limitations: [],
    contextHash: analysisHash({ facts, dataAsOf: NOW }),
    createdAt: NOW,
    writeUntil: new Date(NOW.getTime() + 3600000),
    expiresAt: new Date(NOW.getTime() + 86400000),
  };
  await base.repos.analysis.saveContext(context);
  const ctx = { ...base, triangleRoleRunner: createDshTriangleRoleRunner(host) };
  const principal = { userId: ctx.user.id, accountId: ctx.user.defaultAccountId };
  const service = createPluginOperationService({
    repository: ctx.repos.pluginAuthority,
    policies: [createTriangleAnalysisOperation()],
    capabilities: ['read', 'external', 'queue'],
    policyVersion: 1,
    now: () => NOW.getTime(),
    context: () => ctx,
  });
  const input = {
    contextId: context.id,
    models: Object.fromEntries(
      Object.keys(roles).map((role) => [role, { provider: 'scripted', model: role }]),
    ),
    estimate: {
      estimatedTokenRange: { min: 10, max: 100 },
      estimatedDurationMs: { min: 1, max: 1000 },
    },
    confirmed: true,
  };
  const run = async (overrides: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const prepared = await service.prepare(principal, {
      id,
      tool: 'run_triangle_analysis',
      input: { ...input, ...overrides },
    });
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const token = (prepared.data as { confirmationToken?: string }).confirmationToken;
    if (!token) throw new Error('missing confirmation token');
    return service.confirm(principal, { id, token }, new AbortController().signal);
  };
  return {
    ctx,
    context,
    adapter,
    run,
    close: async () => {
      unregister();
      await fiber.dispose();
    },
  };
};
const resultData = (
  value: unknown,
): { roles: unknown[]; tokenUsed: number | null; blocked: { code: string } | null } => {
  const result = value as { ok: boolean; data: { result: { ok: boolean; data: unknown } } };
  expect(result.ok).toBe(true);
  expect(result.data.result.ok).toBe(true);
  return result.data.result.data as ReturnType<typeof resultData>;
};
describe('production four-role Operation with real LlmRuntime', () => {
  it('dispatches four separate tool-free model requests and persists their veto', async () => {
    const env = await setup();
    try {
      const output = resultData(await env.run());
      expect(output.roles).toHaveLength(4);
      expect(output.tokenUsed).toBe(12);
      expect(output.blocked?.code).toBe('risk_officer_veto');
      expect(env.adapter.requests.map((request) => request.model)).toEqual(Object.keys(roles));
      for (const [index, request] of env.adapter.requests.entries()) {
        expect(request.tools).toEqual([]);
        const message = request.messages[0];
        if (!message || typeof message.content === 'string')
          throw new Error('missing structured message');
        const block = message.content[0];
        if (block?.type !== 'text') throw new Error('missing text');
        const payload = JSON.parse(block.text);
        expect(payload.contextId).toBe(env.context.id);
        expect(payload.factIds).toEqual([FACT]);
        expect(payload.priorOutputs).toHaveLength(index);
        expect(payload).not.toHaveProperty('repos');
      }
      expect(
        (
          await env.ctx.repos.riskVeto.findActiveBySubject({
            accountId: env.context.accountId,
            subject: env.context.subject,
          })
        )?.veto.reason,
      ).toBe('风险仍未排除');
      expect(await env.ctx.repos.advice.query({ includeExpired: true })).toEqual([]);
    } finally {
      await env.close();
    }
  });
  it('keeps an existing veto when a later real risk-officer request passes', async () => {
    const env = await setup();
    try {
      resultData(await env.run());
      env.adapter.riskPass = true;
      const output = resultData(await env.run());
      expect(output.roles).toHaveLength(4);
      expect(output.blocked?.code).toBe('risk_officer_veto');
      expect(
        (
          await env.ctx.repos.riskVeto.findActiveBySubject({
            accountId: env.context.accountId,
            subject: env.context.subject,
          })
        )?.veto.reason,
      ).toBe('风险仍未排除');
    } finally {
      await env.close();
    }
  });
  it('treats provider truncation as failure even when text looks like valid JSON', async () => {
    const env = await setup('truncated');
    try {
      const result = await env.run();
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('missing operation result');
      expect((result.data as { result: { ok: boolean } }).result.ok).toBe(false);
      expect(env.adapter.requests).toHaveLength(1);
      expect(
        await env.ctx.repos.riskVeto.findActiveBySubject({
          accountId: env.context.accountId,
          subject: env.context.subject,
        }),
      ).toBeNull();
    } finally {
      await env.close();
    }
  });
  it('does not dispatch any model before cost confirmation', async () => {
    const env = await setup();
    try {
      expect(resultData(await env.run({ confirmed: false })).blocked?.code).toBe(
        'cost-not-confirmed',
      );
      expect(env.adapter.requests).toHaveLength(0);
    } finally {
      await env.close();
    }
  });
  it('keeps real usage unknown when the provider has no usage report', async () => {
    const env = await setup('unknown-usage');
    try {
      expect(resultData(await env.run()).tokenUsed).toBeNull();
    } finally {
      await env.close();
    }
  });
  it('blocks fabricated evidence before dispatching the next role', async () => {
    const env = await setup('fabricated-evidence');
    try {
      expect(resultData(await env.run()).blocked?.code).toBe('invalid-role-output');
      expect(env.adapter.requests).toHaveLength(1);
      expect(
        await env.ctx.repos.riskVeto.findActiveBySubject({
          accountId: env.context.accountId,
          subject: env.context.subject,
        }),
      ).toBeNull();
    } finally {
      await env.close();
    }
  });
});
