import { describe, expect, it } from 'bun:test';
import {
  type AShareSentimentSnapshot,
  investmentMarketEvidenceValidUntil,
  STANDARD_DISCLAIMERS,
  type ToolContext,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { createWebApp } from './server.js';
import { createWorkspaceDraft, workspaceSnapshot } from './workspace.js';

const setup = async (options?: Parameters<typeof buildTestContext>[0]) => {
  const ctx = await buildTestContext(options);
  await ctx.repos.chat.saveSession({
    id: 'workspace-chat',
    accountId: ctx.user.defaultAccountId,
    title: '讨论',
    createdAt: ctx.clock(),
    updatedAt: ctx.clock(),
  });
  return { ctx };
};

// 内置 AI 研究方向工具已下线；测试直接落库一条等效的市场方向研究记录。
const MARKET_OBSERVED_AT = new Date('2026-10-16T07:00:00Z');
const marketSnapshot = (): AShareSentimentSnapshot => {
  const provenance = [
    {
      provider: 'injected-market-source',
      observedAt: MARKET_OBSERVED_AT,
      fetchedAt: new Date('2026-10-16T08:00:00Z'),
      freshness: 'fresh' as const,
    },
  ];
  const missing = {
    status: 'unavailable' as const,
    provenance: [
      {
        provider: 'unconfigured',
        observedAt: new Date('2026-10-16T08:00:00Z'),
        fetchedAt: new Date('2026-10-16T08:00:00Z'),
        freshness: 'unavailable' as const,
      },
    ],
    warnings: ['not-configured'],
  };
  return {
    date: '2026-10-16',
    coverage: 'CN_A_SHARES_SH_SZ',
    dataAsOf: MARKET_OBSERVED_AT,
    indexes: missing,
    breadth: {
      status: 'complete',
      provenance,
      warnings: [],
      value: { advancing: 3000, declining: 1700, unchanged: 300, total: 5000 },
    },
    limitUp: {
      status: 'complete',
      provenance,
      warnings: [],
      value: {
        sealedCount: 30,
        brokenCount: 10,
        brokenRate: 0.25,
        maxLadderLevel: 4,
        totalSealAmount: 1000000,
        boardDistribution: { main: 30 },
        leaders: [],
      },
    },
    themes: {
      status: 'partial',
      provenance,
      warnings: ['only-provider-pool-industries'],
      value: { industries: [{ name: '软件开发', count: 10 }], concepts: [] },
    },
  };
};

const seedMarketResearch = async (ctx: ToolContext, createdAt: Date) => {
  const snapshotId = 'snapshot-market-1';
  const source = { kind: 'market-snapshot' as const, snapshotId, subject: 'cn-equity-indexes' };
  const evidence = [
    {
      id: 'market:indexes',
      source,
      dataAsOf: MARKET_OBSERVED_AT,
      kind: 'market-indexes' as const,
      text: '上证指数收 3600 点，涨 0.33%；仅描述指数事实。',
      value: { close: 3600, changePct: 0.33 },
      provenance: [
        {
          provider: 'injected-market-source',
          observedAt: MARKET_OBSERVED_AT,
          fetchedAt: createdAt,
          freshness: 'fresh' as const,
        },
      ],
    },
  ];
  const research = {
    id: 'market-research-1',
    ownerUserId: ctx.user.id,
    accountId: ctx.user.defaultAccountId,
    requestId: 'market-http',
    requestHash: 'hash-market-http',
    question: '没有预设策略，先研究什么？',
    status: 'complete' as const,
    source: { userText: '没有预设策略，先研究什么？' },
    directions: [
      {
        id: 'direction-market-1',
        name: '指数层面观察',
        rank: 1,
        stance: 'observe' as const,
        rationale: '仅讨论已取得的指数事实',
        comparisonReason: '只有指数可用，个股机会未知',
        evidenceIds: ['market:indexes'],
        objections: [
          {
            kind: 'known-risk' as const,
            conclusion: '指数不能作为个股买入理由',
            evidenceIds: ['market:indexes'],
            risks: ['市场可能反转'],
            unknowns: ['公司事件未知'],
            reconsiderWhen: ['补充个股证据'],
            alternatives: ['等待'],
          },
        ],
        risks: ['波动风险'],
        waitFor: ['具体证据'],
        abandonWhen: ['事实到期'],
        reviewWhen: ['下次开盘'],
        horizon: 'short' as const,
        accountFit: 'research-only' as const,
        dataAsOf: MARKET_OBSERVED_AT,
        validUntil: investmentMarketEvidenceValidUntil(MARKET_OBSERVED_AT),
        opportunityType: 'market-participation' as const,
        source,
        coverage: {
          kind: 'market-facts' as const,
          scope: 'cn-equity-indexes' as const,
          observedCount: 1,
          unit: 'indexes' as const,
          dataHealth: 'partial' as const,
          description: '仅覆盖注入的指数事实，不代表全市场。',
        },
        tracking: { eligible: false as const, reason: '市场方向没有真实策略映射，不能跟踪个股。' },
      },
    ],
    evidence,
    limitations: ['只有指数事实可用。'],
    disclaimers: [...STANDARD_DISCLAIMERS],
    createdAt,
    marketSnapshot: { id: snapshotId, snapshot: marketSnapshot() },
  };
  await ctx.repos.investmentWorkspace.createResearch(research);
  return research;
};

describe('投资协作首页与主体信任', () => {
  it('无策略用户基于已有研究保存共识，跨请求恢复并明确不能跟踪个股', async () => {
    const now = new Date('2026-10-16T08:00:00Z');
    const { ctx } = await setup({ clock: () => now });
    const app = createWebApp(ctx, { exposeWrite: true, exposeExternal: true });
    const stage = async (tool: string, input: unknown, userText: string) => {
      const response = await app.fetch(
        new Request('http://test/api/workspace/drafts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: 'workspace-chat', tool, input, userText }),
        }),
      );
      expect(await response.json()).toMatchObject({ ok: true });
      expect(response.status).toBe(200);
      const messages = await ctx.repos.chat.listMessages('workspace-chat');
      const assistant = messages.filter((message) => message.role === 'assistant').at(-1);
      const part = assistant?.parts.find((part) => part.type === `tool-${tool}`);
      return `http://test/api/chat/sessions/workspace-chat/drafts/${assistant?.id}/${part?.toolCallId}`;
    };
    const confirm = async (url: string) => {
      const response = await app.fetch(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ approved: true }),
        }),
      );
      return response.json();
    };
    // 已删除的 AI 研究工具不能再生成草案
    expect(
      (
        await app.fetch(
          new Request('http://test/api/workspace/drafts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: 'workspace-chat',
              tool: 'research_investment_directions',
              input: { requestId: 'removed', question: '还能研究吗？' },
              userText: '还能研究吗？',
            }),
          }),
        )
      ).status,
    ).toBe(400);
    const seeded = await seedMarketResearch(ctx, now);
    const research = (
      await ctx.repos.investmentWorkspace.listResearch({
        ownerUserId: ctx.user.id,
        accountId: ctx.user.defaultAccountId,
        limit: 1,
      })
    )[0];
    expect(research?.directions[0]).toMatchObject({ opportunityType: 'market-participation' });
    if (!research?.directions[0]) throw new Error('fixture research missing');
    expect(research.id).toBe(seeded.id);
    const direction = research.directions[0];
    const consensusDraft = await stage(
      'save_investment_consensus',
      {
        requestId: 'market-consensus-http',
        expectedVersion: 0,
        changes: {
          selections: [
            {
              researchId: research.id,
              directionId: direction.id,
              role: 'observe',
              userReason: '保留反对，继续观察',
            },
          ],
        },
        changeNote: '先保存方向',
        reviewAt: '2026-10-19T01:00:00Z',
        validUntil: '2026-10-20T08:00:00Z',
      },
      '保留反对，继续观察',
    );
    expect(await confirm(consensusDraft)).toMatchObject({
      ok: true,
      data: { status: 'succeeded' },
    });
    const page = await app.fetch(new Request('http://test/api/workspace'));
    expect(await page.json()).toMatchObject({
      data: {
        investment: {
          ok: true,
          data: {
            consensus: { version: 1 },
            tracking: null,
            trackingEligibility: { eligible: false },
          },
        },
        candidates: { ok: true, data: { candidates: [] } },
      },
    });
    expect(await ctx.repos.strategy.list()).toEqual([]);
    expect(await ctx.repos.watchlist.list()).toEqual([]);
  });

  it('共识草案按确切版本确认，并发旧版本失败而不覆盖最新共识', async () => {
    const { ctx } = await setup();
    const app = createWebApp(ctx, { exposeWrite: true, exposeExternal: true });
    const input = {
      expectedVersion: 0,
      changes: { constraints: ['不放宽持仓退出条件'] },
      changeNote: '先管理持仓',
      reviewAt: new Date(ctx.clock().getTime() + 86400_000),
      validUntil: new Date(ctx.clock().getTime() + 2 * 86400_000),
    };
    for (const id of ['first', 'second'])
      expect(
        (
          await createWorkspaceDraft(
            {
              sessionId: 'workspace-chat',
              tool: 'save_investment_consensus',
              userText: '先管理持仓',
              input: { ...input, requestId: id },
            },
            ctx,
          )
        ).ok,
      ).toBe(true);
    const stored = (await ctx.repos.chat.listMessages('workspace-chat')).filter(
      (message) => message.role === 'assistant',
    );
    const results = [];
    for (const message of stored) {
      const part = message.parts.find((part) => part.type === 'tool-save_investment_consensus');
      const response = await app.fetch(
        new Request(
          `http://test/api/chat/sessions/workspace-chat/drafts/${message.id}/${part?.toolCallId}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ approved: true }),
          },
        ),
      );
      results.push(await response.json());
    }
    expect(results[0]).toMatchObject({
      ok: true,
      data: { status: 'succeeded', result: { data: { consensus: { version: 1 } } } },
    });
    expect(results[1]).toMatchObject({
      ok: true,
      data: { status: 'failed', result: { error: { kind: 'invariant_violation' } } },
    });
    expect((await workspaceSnapshot(ctx)).data.investment).toMatchObject({
      ok: true,
      data: { consensus: { version: 1, constraints: ['不放宽持仓退出条件'] } },
    });
  });

  it('首页草案端点沿用权限、Origin和会话归属，不接受客户端执行结果', async () => {
    const { ctx } = await setup();
    const request = (body: unknown, origin = 'http://test') =>
      new Request('http://test/api/workspace/drafts', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const body = {
      sessionId: 'workspace-chat',
      tool: 'set_investment_tracking',
      userText: '暂停方向同步',
      input: { requestId: 'pause', expectedVersion: 1, action: 'pause' },
    };
    expect(
      (await createWebApp(ctx, { exposeWrite: false, exposeExternal: false }).fetch(request(body)))
        .status,
    ).toBe(403);
    const app = createWebApp(ctx, { exposeWrite: true, exposeExternal: true });
    expect((await app.fetch(request(body, 'https://other.invalid'))).status).toBe(403);
    expect((await app.fetch(request({ ...body, sessionId: 'foreign-session' }))).status).toBe(404);
    expect((await app.fetch(request({ ...body, output: { ok: true } }))).status).toBe(400);
  });
  it('首页独立返回已有事实，不因没有研究结果伪造 AI 判断', async () => {
    const { ctx } = await setup();
    const app = createWebApp(ctx);
    const response = await app.fetch(new Request('http://test/api/workspace'));
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      data: {
        aiSummary?: unknown;
        holdings: { data: { holdings: { discussionVersion: string }[] } };
      };
    };
    expect(result).toMatchObject({
      ok: true,
      data: {
        summaryKind: 'facts',
        accountId: ctx.user.defaultAccountId,
        account: { ok: true },
        holdings: { ok: true },
        plans: { ok: true },
      },
    });
    expect(result.data.aiSummary).toBeUndefined();
    expect(result.data.holdings.data.holdings[0]?.discussionVersion).toBeString();
  });

  it('持仓读取失败时账户与报告仍可读取，失败不伪装成空持仓', async () => {
    const { ctx } = await setup();
    const broken = {
      ...ctx,
      repos: {
        ...ctx.repos,
        holding: {
          ...ctx.repos.holding,
          listByAccount: async () => {
            throw new Error('fixture-unavailable');
          },
        },
      },
    };
    const result = await workspaceSnapshot(broken);
    expect(result.data.holdings.ok).toBe(false);
    expect(result.data.account.ok).toBe(true);
    expect(result.data.reports.ok).toBe(true);
  });
});
