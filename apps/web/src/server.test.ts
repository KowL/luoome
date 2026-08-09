// apps/web 闸口矩阵测试（bun runner：server.ts 顶层 import @luoome/db → bun:sqlite，
// node/vitest 无法解析，已在 vitest.config.ts exclude；由 `bun run test:web` 执行）。
// ctx 用 buildTestContext（in-memory repos）注入 createWebApp，不走真实 SQLite 文件。

import { Database } from 'bun:sqlite';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TEST_ACCOUNT } from '@luoome/adapters/testing';
import type { AgentCallableTool, ToolContext } from '@luoome/core';
import { saveReportTool, saveWatchTriggerTool } from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import type { Hono } from 'hono';

import { AISettingsStore } from './ai-settings.js';
import type { ChatStreamRuntime } from './chat.js';
import { MarketSettingsStore } from './market-settings.js';
import { buildWebContext, createWebApp, resolveWebToken } from './server.js';

let app: Hono;
let appCtx: ToolContext;
const WEB_TOKEN = 'test-web-token';

beforeAll(async () => {
  appCtx = await buildTestContext();
  app = createWebApp(appCtx, {
    webToken: WEB_TOKEN,
    exposeWrite: true,
    exposeExternal: true,
  });
});

const callTool = async (name: string, input: unknown): Promise<Response> =>
  app.fetch(
    new Request(`http://test/api/tools/${name}/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WEB_TOKEN}`,
      },
      body: JSON.stringify({ input }),
    }),
  );

const json = async (r: Response): Promise<{ ok: boolean; data?: never; error?: never }> =>
  (await r.json()) as { ok: boolean; data?: never; error?: never };

describe('Web 信息架构', () => {
  it('一级产品语言统一为 Strategy / Watchlist / AlertPlan', async () => {
    const response = await app.fetch(new Request('http://test/'));
    const html = await response.text();
    expect(html).not.toContain('data-route="watch"');
    expect(html).not.toContain('href="#watch"');
    expect(html).not.toContain('data-route="groups"');
    expect(html).not.toContain('data-route="tactics"');
    expect(html).toContain('data-route="strategies"');
    expect(html).toContain('data-route="watchlists"');
    expect(html).toContain('data-route="alerts"');
    expect(html).toContain('id="btn-dashboard-watch-run"');
  });
});

describe('研究 Vault API', () => {
  it('按主题和显式股票 SubjectLink 查询可重建索引', async () => {
    const now = new Date('2026-08-01T00:00:00.000Z');
    await appCtx.repos.researchIndex.applyIndexBatch({
      vaultId: 'vault-web',
      completeness: 'complete',
      topics: [
        {
          id: 'topic_web_industry',
          title: '白酒库存周期',
          kind: 'industry',
          tags: ['白酒'],
          vaultId: 'vault-web',
          relativePath: 'Research/Topics/白酒库存周期.md',
          contentHash: 'a'.repeat(64),
          fileModifiedAt: now,
          indexedAt: now,
          availability: 'available',
        },
      ],
      documents: [],
      topicDocuments: [],
      subjectLinks: [
        {
          ownerKind: 'topic',
          ownerId: 'topic_web_industry',
          subjectKind: 'stock',
          subjectKey: '600519.SH',
          relation: 'related',
        },
      ],
      chunks: [],
      seenTopicIds: new Set(['topic_web_industry']),
      seenDocumentIds: new Set(),
      indexedAt: now,
    });

    const topics = (await (
      await app.fetch(new Request('http://test/api/research/topics'))
    ).json()) as { ok: boolean; data?: { topics: Array<{ id: string }> } };
    expect(topics.ok).toBe(true);
    expect(topics.data?.topics.some((topic) => topic.id === 'topic_web_industry')).toBe(true);

    const stockView = (await (
      await app.fetch(new Request('http://test/api/research/stocks/600519.SH'))
    ).json()) as { ok: boolean; data?: { topics: Array<{ id: string }> } };
    expect(stockView.ok).toBe(true);
    expect(stockView.data?.topics.map((topic) => topic.id)).toContain('topic_web_industry');
  });
});

describe('报告 API', () => {
  it('保存报告后可通过历史、详情和 Markdown 导出端点读取', async () => {
    const now = '2026-07-29T10:00:00.000Z';
    const report = {
      id: 'web-report-1',
      kind: 'closing',
      scope: { kind: 'all-accounts' },
      periodStart: '2026-07-29',
      periodEnd: '2026-07-29',
      title: 'Web 收盘复盘',
      generatedAt: now,
      dataAsOf: '2026-07-29T08:00:00.000Z',
      status: 'complete',
      sections: [
        {
          key: 'market-pulse',
          title: '市场脉搏',
          required: true,
          status: 'complete',
          blocks: [{ kind: 'text', text: '市场平稳', tone: 'factual' }],
          evidenceIds: [],
          missingDimensions: [],
        },
      ],
      evidence: [],
      missingDimensions: [],
      deliveryStatus: 'not-requested',
      workflowRunId: 'web-workflow-1',
      createdAt: now,
      updatedAt: now,
    };
    const saved = await saveReportTool.execute({ report }, appCtx);
    expect(saved.ok).toBe(true);

    const history = await app.fetch(new Request('http://test/api/reports?kind=closing&limit=30'));
    const historyBody = (await history.json()) as {
      ok: boolean;
      data?: { reports: Array<{ id: string }> };
    };
    expect(historyBody.data?.reports.some((item) => item.id === report.id)).toBe(true);

    const detail = await app.fetch(new Request(`http://test/api/reports/${report.id}`));
    const detailBody = (await detail.json()) as {
      ok: boolean;
      data?: { report: { title: string } };
    };
    expect(detailBody.data?.report.title).toBe('Web 收盘复盘');

    const rendered = await app.fetch(
      new Request(`http://test/api/reports/${report.id}/render?format=markdown`),
    );
    const renderedBody = (await rendered.json()) as {
      ok: boolean;
      data?: { content: string };
    };
    expect(renderedBody.data?.content).toContain('# Web 收盘复盘');
  });

  it('手动生成端点要求 mutation token，并保存可查询的开盘简报', async () => {
    const denied = await app.fetch(
      new Request('http://test/api/reports/run/opening', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: '2026-07-29', notify: false }),
      }),
    );
    expect(denied.status).toBe(403);

    const generated = await app.fetch(
      new Request('http://test/api/reports/run/opening', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
          origin: 'http://test',
        },
        body: JSON.stringify({ date: '2026-07-29', notify: false }),
      }),
    );
    const body = (await generated.json()) as {
      ok: boolean;
      data?: { report: { id: string; kind: string } };
    };
    expect(generated.status).toBe(200);
    expect(body.data?.report.kind).toBe('opening');

    const detail = await app.fetch(
      new Request(`http://test/api/reports/${body.data?.report.id ?? ''}`),
    );
    expect(detail.status).toBe(200);
  });
});

describe('Web token bootstrap', () => {
  it('无 env 时生成并复用数据库同目录的 0600 token 文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-web-token-'));
    const previous = process.env.LUOOME_WEB_TOKEN;
    delete process.env.LUOOME_WEB_TOKEN;
    try {
      const first = resolveWebToken(join(dir, 'luoome.db'));
      const second = resolveWebToken(join(dir, 'luoome.db'));
      expect(first.filePath).toBe(join(dir, 'web-token'));
      expect(second.token).toBe(first.token);
      expect(readFileSync(first.filePath ?? '', 'utf8').trim()).toBe(first.token);
      expect(statSync(first.filePath ?? '').mode & 0o777).toBe(0o600);
    } finally {
      if (previous === undefined) delete process.env.LUOOME_WEB_TOKEN;
      else process.env.LUOOME_WEB_TOKEN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Web runtime bootstrap', () => {
  it('starts with an empty database and never inserts sample records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-empty-runtime-'));
    try {
      const aiConfig = join(dir, 'ai-models.json');
      writeFileSync(
        aiConfig,
        JSON.stringify({
          version: 1,
          providers: {
            test: {
              type: 'openai-compatible',
              baseURL: 'https://example.test/v1',
              apiKeyEnv: 'TEST_AI_KEY',
            },
          },
          profiles: {
            generation: { model: 'test:model' },
            agent: { model: 'test:model' },
          },
        }),
      );
      const ctx = await buildWebContext(join(dir, 'luoome.db'), {
        LUOOME_MARKET_PROVIDER: 'real',
        LUOOME_AI_CONFIG: aiConfig,
        TEST_AI_KEY: 'test-key-not-used',
      });
      expect(await ctx.repos.account.list()).toEqual([]);
      expect(await ctx.repos.stock.search('')).toEqual([]);
      expect(await ctx.repos.holding.listByAccount('')).toEqual([]);
      expect(await ctx.repos.trade.listByAccount('')).toEqual([]);
      // legacy repo 层已下掉；fresh DB 不再创建旧模型表（raw SQL 验证）
      const sqlite = new Database(join(dir, 'luoome.db'), { readonly: true });
      try {
        const legacyTables = sqlite
          .query<{ readonly name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tactics', 'tactic_signals', 'stock_groups', 'group_member_snapshots', 'stock_pools')",
          )
          .all();
        expect(legacyTables).toEqual([]);
      } finally {
        sqlite.close();
      }
      expect(
        (await ctx.repos.strategy.list({ owner: 'builtin' })).map((strategy) => strategy.id),
      ).toEqual(expect.arrayContaining(['early-breakout', 'bollinger-band']));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('LLM 设置 API', () => {
  it('读取不返回密钥；保存要求 token，并立即替换运行时 AI stack', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-ai-settings-api-'));
    try {
      const store = new AISettingsStore(
        { LUOOME_HOME: dir },
        {
          configPath: join(dir, 'ai-models.json'),
          secretPath: join(dir, '.env'),
        },
      );
      const settingsApp = createWebApp(await buildTestContext(), {
        webToken: WEB_TOKEN,
        aiSettingsStore: store,
      });
      const initial = await settingsApp.fetch(new Request('http://test/api/settings/ai'));
      expect(initial.status).toBe(200);
      const initialBody = (await initial.json()) as {
        readonly data: { readonly providers: unknown };
      };
      expect(initialBody).toMatchObject({
        ok: true,
        data: { provider: 'minimax', apiKeyConfigured: false },
      });
      expect(initialBody.data.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'kimi', defaultModel: 'kimi-k3' }),
          expect.objectContaining({ id: 'deepseek', defaultModel: 'deepseek-v4-pro' }),
        ]),
      );

      const input = {
        provider: 'minimax',
        model: 'MiniMax-M3',
        baseURL: 'https://api.minimaxi.com/v1',
        apiKey: 'api-test-secret',
        clearApiKey: false,
        temperature: 0.1,
        timeoutSeconds: 120,
        maxRetries: 2,
        reasoningEffort: 'off',
      };
      const denied = await settingsApp.fetch(
        new Request('http://test/api/settings/ai', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      );
      expect(denied.status).toBe(403);

      const saved = await settingsApp.fetch(
        new Request('http://test/api/settings/ai', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${WEB_TOKEN}`,
          },
          body: JSON.stringify(input),
        }),
      );
      expect(saved.status).toBe(200);
      const payload = await saved.json();
      expect(payload).toMatchObject({
        ok: true,
        data: { apiKeyConfigured: true, applied: true },
      });
      expect(JSON.stringify(payload)).not.toContain('api-test-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('行情源设置 API', () => {
  it('读取不暴露密钥；保存要求 token，并立即应用新顺序', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-market-settings-api-'));
    try {
      const store = new MarketSettingsStore(
        {
          LUOOME_HOME: dir,
          LUOOME_MARKET_PROVIDER: 'real',
          TUSHARE_TOKEN: 'secret-market-key',
        },
        { secretPath: join(dir, '.env') },
      );
      const settingsApp = createWebApp(await buildTestContext(), {
        webToken: WEB_TOKEN,
        marketSettingsStore: store,
      });
      const initial = await settingsApp.fetch(new Request('http://test/api/settings/market'));
      expect(initial.status).toBe(200);
      const initialPayload = await initial.json();
      expect(initialPayload).toMatchObject({
        ok: true,
        data: { activeOrder: ['eastmoney', 'tencent'] },
      });
      expect(JSON.stringify(initialPayload)).not.toContain('secret-market-key');

      const denied = await settingsApp.fetch(
        new Request('http://test/api/settings/market', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sources: ['tencent'] }),
        }),
      );
      expect(denied.status).toBe(403);

      const saved = await settingsApp.fetch(
        new Request('http://test/api/settings/market', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${WEB_TOKEN}`,
          },
          body: JSON.stringify({ sources: ['tencent', 'eastmoney'] }),
        }),
      );
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        ok: true,
        data: { activeOrder: ['tencent', 'eastmoney'], applied: true },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('非 loopback API 鉴权模式', () => {
  it('read API 也要求 Bearer token', async () => {
    const protectedApp = createWebApp(await buildTestContext(), {
      webToken: WEB_TOKEN,
      requireApiToken: true,
    });
    const denied = await protectedApp.fetch(new Request('http://lan/api/holdings'));
    expect(denied.status).toBe(403);
    const allowed = await protectedApp.fetch(
      new Request('http://lan/api/holdings', {
        headers: { authorization: `Bearer ${WEB_TOKEN}` },
      }),
    );
    expect(allowed.status).toBe(200);
  });
});

describe('Strategy / Watchlist / AlertPlan API', () => {
  const targetRequest = (path: string, body: unknown, token = WEB_TOKEN): Request =>
    new Request(`http://test${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        origin: 'http://test',
      },
      body: JSON.stringify(body),
    });

  it('四个 surface 的 Web 路由复用目标 tool contract', async () => {
    const strategyId = 'web-target-strategy';
    const watchlistId = 'web-target-watchlist';
    const alertPlanId = 'web-target-alert';

    expect(
      (
        await app.fetch(
          targetRequest('/api/strategies', {
            id: strategyId,
            name: 'Web Strategy',
            description: 'W5 target API',
          }),
        )
      ).status,
    ).toBe(200);
    expect((await app.fetch(new Request(`http://test/api/strategies/${strategyId}`))).status).toBe(
      200,
    );

    expect(
      (
        await app.fetch(
          targetRequest('/api/watchlists', {
            id: watchlistId,
            name: 'Web Watchlist',
            kind: 'personal',
            membershipPolicy: 'mixed',
          }),
        )
      ).status,
    ).toBe(200);
    expect((await app.fetch(new Request(`http://test/api/watchlists/${watchlistId}`))).status).toBe(
      200,
    );

    expect(
      (
        await app.fetch(
          targetRequest('/api/alert-plans', {
            id: alertPlanId,
            name: 'Web AlertPlan',
            watchlistId,
            rules: [
              {
                id: 'price-rule',
                kind: 'price-level',
                side: 'above',
                level: 10,
              },
            ],
          }),
        )
      ).status,
    ).toBe(200);
    const alerts = (await (await app.fetch(new Request('http://test/api/alert-plans'))).json()) as {
      data?: { plans?: Array<{ id: string }> };
    };
    expect(alerts.data?.plans?.some((plan) => plan.id === alertPlanId)).toBe(true);
  });

  it('GET /api/strategy-templates 返回内置模板目录', async () => {
    const res = await app.fetch(new Request('http://test/api/strategy-templates'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data?: {
        templates?: Array<{
          id: string;
          name: string;
          description: string;
          definition: { schemaVersion: number };
        }>;
      };
    };
    expect(body.ok).toBe(true);
    const templates = body.data?.templates;
    expect(templates?.length).toBe(7);
    expect(templates?.every((template) => template.definition?.schemaVersion === 1)).toBe(true);
    expect(templates?.some((template) => template.name === '布林带均值回复')).toBe(true);
  });

  it('策略工作台 read routes 复用 workspace/result-view/diff tool contract', async () => {
    const strategyId = 'web-strategy-workspace-routes';
    const created = await app.fetch(
      targetRequest('/api/strategies', {
        id: strategyId,
        name: 'Web Workspace Strategy',
        description: '验证策略工作台路由',
      }),
    );
    expect(created.status).toBe(200);

    const workspace = await app.fetch(
      new Request(`http://test/api/strategies/${strategyId}/workspace`),
    );
    expect(workspace.status).toBe(200);
    expect(await workspace.json()).toMatchObject({
      ok: true,
      data: { strategy: { id: strategyId }, overview: { health: 'never-run' } },
    });

    const insights = await app.fetch(
      new Request(`http://test/api/strategies/${strategyId}/insights`),
    );
    expect(insights.status).toBe(200);
    expect(await insights.json()).toMatchObject({
      ok: true,
      data: { strategy: { id: strategyId }, runs: { total: 0, usable: 0 } },
    });

    const schedule = await app.fetch(
      new Request(`http://test/api/strategies/${strategyId}/schedule`),
    );
    expect(schedule.status).toBe(200);
    expect(await schedule.json()).toMatchObject({ ok: true, data: { schedule: null } });

    const results = await app.fetch(
      new Request(`http://test/api/strategies/${strategyId}/results?view=selected`),
    );
    expect(results.status).toBe(404);

    const diff = await app.fetch(
      new Request(`http://test/api/strategy-runs/compare?strategyId=${strategyId}`),
    );
    expect(diff.status).toBe(404);

    const definitionDiff = await app.fetch(
      new Request(`http://test/api/strategies/${strategyId}/definition-diff`),
    );
    expect(definitionDiff.status).toBe(400);
  });

  it('策略工作台 pause/resume routes 复用生命周期 tool 并保留 mutation 防护', async () => {
    const strategyId = 'web-strategy-lifecycle-routes';
    expect(
      (
        await app.fetch(
          targetRequest('/api/strategies', {
            id: strategyId,
            name: 'Web Lifecycle Strategy',
            description: '验证暂停和恢复路由',
          }),
        )
      ).status,
    ).toBe(200);

    const versionResponse = await app.fetch(
      targetRequest(`/api/strategies/${strategyId}/versions`, {
        definition: {
          schemaVersion: 1,
          metadata: { horizon: 'short' },
          universe: { coverage: 'CN_A_SHARES_SH_SZ', excludeStockIds: [] },
          selection: {
            logic: 'all',
            rules: [
              {
                id: 'positive-price',
                name: '价格有效',
                when: 'quote.close > 0',
                evidence: ['价格有效'],
              },
            ],
          },
          signals: { entry: [], exit: [], risk: [] },
        },
      }),
    );
    expect(versionResponse.status).toBe(200);
    const versionBody = (await versionResponse.json()) as {
      data?: { version?: { id: string } };
    };
    const versionId = versionBody.data?.version?.id;
    expect(versionId).toBeString();
    if (versionId === undefined) return;
    expect(
      (await app.fetch(targetRequest(`/api/strategies/${strategyId}/validate`, { versionId })))
        .status,
    ).toBe(200);
    expect(
      (await app.fetch(targetRequest(`/api/strategies/${strategyId}/publish`, { versionId })))
        .status,
    ).toBe(200);

    const schedule = await app.fetch(
      targetRequest(`/api/strategies/${strategyId}/schedule`, {
        cron: '0 18 * * 1-5',
        timezone: 'Asia/Shanghai',
        enabled: true,
      }),
    );
    expect(schedule.status).toBe(200);
    expect(await schedule.json()).toMatchObject({
      ok: true,
      data: { schedule: { strategyId, cron: '0 18 * * 1-5', enabled: true } },
    });

    const paused = await app.fetch(targetRequest(`/api/strategies/${strategyId}/pause`, {}));
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({
      ok: true,
      data: { strategy: { id: strategyId, status: 'paused' } },
    });

    const resumed = await app.fetch(targetRequest(`/api/strategies/${strategyId}/resume`, {}));
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      ok: true,
      data: { strategy: { id: strategyId, status: 'active' } },
    });

    const insight = await app.fetch(
      targetRequest(`/api/strategies/${strategyId}/insights/generate`, {}),
    );
    expect(insight.status).toBe(200);
    expect(await insight.json()).toMatchObject({
      ok: true,
      data: { provider: 'fake-llm', insight: { findings: [{ factRefs: ['runs:window'] }] } },
    });
  });

  it('目标 mutation 同时要求显式 opt-in、token 与同源 Origin', async () => {
    const guarded = createWebApp(await buildTestContext(), {
      webToken: WEB_TOKEN,
      exposeWrite: false,
      exposeExternal: false,
    });
    const disabled = await guarded.fetch(
      targetRequest('/api/watchlists', {
        id: 'disabled-write',
        name: 'disabled',
        kind: 'personal',
        membershipPolicy: 'manual',
      }),
    );
    expect(disabled.status).toBe(403);

    const missingToken = await app.fetch(
      targetRequest(
        '/api/watchlists',
        {
          id: 'missing-token',
          name: 'missing',
          kind: 'personal',
          membershipPolicy: 'manual',
        },
        '',
      ),
    );
    expect(missingToken.status).toBe(403);

    const crossOrigin = await app.fetch(
      new Request('http://test/api/watchlists', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
          origin: 'https://evil.example',
        },
        body: JSON.stringify({
          id: 'cross-origin',
          name: 'cross',
          kind: 'personal',
          membershipPolicy: 'manual',
        }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
  });
});

describe('Watchlist 页增强 API（PRD §10）', () => {
  const watchMutation = (path: string, body: unknown, method = 'POST'): Request =>
    new Request(`http://test${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${WEB_TOKEN}`,
        origin: 'http://test',
      },
      body: JSON.stringify(body),
    });

  it('编辑 / 成员 stage+priority / 归档成员 / 归档列表 全链路', async () => {
    const wid = 'web-watchlist-prd10';
    expect(
      (
        await app.fetch(
          watchMutation('/api/watchlists', {
            id: wid,
            name: 'PRD10 测试',
            kind: 'personal',
            membershipPolicy: 'mixed',
          }),
        )
      ).status,
    ).toBe(200);

    const patched = await app.fetch(
      watchMutation(`/api/watchlists/${wid}`, { name: 'PRD10 改名', enabled: true }, 'PATCH'),
    );
    expect(patched.status).toBe(200);
    const detail = (await (
      await app.fetch(new Request(`http://test/api/watchlists/${wid}`))
    ).json()) as { data?: { watchlist: { name: string } } };
    expect(detail.data?.watchlist.name).toBe('PRD10 改名');

    expect(
      (
        await app.fetch(
          watchMutation(`/api/watchlists/${wid}/members`, {
            stockId: '002594.SZ',
            reason: '测试加入',
            stage: 'discovered',
          }),
        )
      ).status,
    ).toBe(200);
    const memberPatched = await app.fetch(
      watchMutation(
        `/api/watchlists/${wid}/members/002594.SZ`,
        { stage: 'researching', priority: 'urgent' },
        'PATCH',
      ),
    );
    expect(memberPatched.status).toBe(200);
    const memberBody = (await memberPatched.json()) as {
      data?: { member: { stage: string; priority: string } };
    };
    expect(memberBody.data?.member).toMatchObject({ stage: 'researching', priority: 'urgent' });

    expect(
      (
        await app.fetch(
          watchMutation(`/api/watchlists/${wid}/members`, {
            stockId: '600519.SH',
            reason: '待归档',
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await app.fetch(watchMutation(`/api/watchlists/${wid}/members/600519.SH/archive`, {})))
        .status,
    ).toBe(200);
    expect((await app.fetch(watchMutation(`/api/watchlists/${wid}/archive`, {}))).status).toBe(200);

    // 归档结果经 overview 验证：列表停用进入已归档列表，成员进入已归档成员
    const overview = (await (
      await app.fetch(new Request('http://test/api/watchlists/overview'))
    ).json()) as {
      data?: {
        archived: {
          lists: Array<{ id: string; enabled: boolean }>;
          members: Array<{ watchlistId: string; member: { stockId: string } }>;
        };
      };
    };
    const archivedList = overview.data?.archived.lists.find((list) => list.id === wid);
    expect(archivedList?.enabled).toBe(false);
    expect(
      overview.data?.archived.members.some(
        (item) => item.watchlistId === wid && item.member.stockId === '600519.SH',
      ),
    ).toBe(true);
  });

  it('GET /api/watchlist-changes 缺 watchlistId → 400；合法参数 → 200', async () => {
    const missing = await app.fetch(new Request('http://test/api/watchlist-changes'));
    expect(missing.status).toBe(400);
    const body = (await missing.json()) as { error?: { kind: string } };
    expect(body.error?.kind).toBe('invalid_input');

    const ok = await app.fetch(
      new Request('http://test/api/watchlist-changes?watchlistId=web-watchlist-prd10&limit=10'),
    );
    expect(ok.status).toBe(200);
  });

  it('GET /api/watchlists/overview 聚合 discovered/holding/今日变化/触发摘要', async () => {
    const wid = 'web-overview-list';
    expect(
      (
        await app.fetch(
          watchMutation('/api/watchlists', {
            id: wid,
            name: '总览测试',
            kind: 'personal',
            membershipPolicy: 'mixed',
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.fetch(
          watchMutation(`/api/watchlists/${wid}/members`, {
            stockId: '002594.SZ',
            stage: 'discovered',
            reason: '总览测试',
          }),
        )
      ).status,
    ).toBe(200);

    // 持仓来源成员 + 今日策略同步 + 一条 urgent 触发，直接播种 in-memory repos
    const now = appCtx.clock();
    await appCtx.repos.watchlistMember.saveMember({
      id: `${wid}:600519.SH`,
      watchlistId: wid,
      stockId: '600519.SH',
      stage: 'watching',
      priority: 'normal',
      firstAddedAt: now,
      lastActivityAt: now,
    });
    await appCtx.repos.watchlistMember.saveSource({
      id: 'web-overview-src-portfolio',
      memberId: `${wid}:600519.SH`,
      kind: 'portfolio',
      sourceKey: 'portfolio:test-account',
      reason: '持仓同步',
      status: 'active',
      evidence: [],
      validFrom: now,
    });
    await appCtx.repos.watchlistMember.commitWatchlistSync({
      run: {
        id: 'web-overview-run-1',
        watchlistId: wid,
        sourceKind: 'strategy',
        sourceKey: 'strategy:test-strategy',
        status: 'complete',
        startedAt: now,
        finishedAt: now,
        enteredCount: 1,
        exitedCount: 0,
        unchangedCount: 0,
        missingDimensions: [],
      },
      candidates: [{ stockId: '002594.SZ', reason: '策略入选', evidence: [] }],
    });
    await appCtx.repos.watchTrigger.save({
      id: 'web-overview-trigger-1',
      poolId: wid,
      stockId: '002594.SZ',
      ruleKind: 'price-level',
      ruleId: 'r1',
      direction: 'buy',
      triggerType: 'triggered',
      reason: '价格上穿',
      evidence: ['收盘价上穿阈值'],
      priority: 'urgent',
      deliveryStatus: 'not-requested',
      evalSnapshot: { ruleId: 'r1' },
      notified: false,
      createdAt: now,
    });

    const response = await app.fetch(new Request('http://test/api/watchlists/overview'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      data?: {
        lists: Array<{
          watchlist: { id: string };
          discoveredCount: number;
          todayEntered: number;
        }>;
        stocks: Array<{
          stockId: string;
          name: string;
          quote: { close: number } | null;
          changePct: number | null;
          memberships: Array<{ watchlistId: string; holding: boolean }>;
        }>;
        todayChanges: Array<{ watchlistId: string; stockId: string; direction: string }>;
        archived: { lists: unknown[]; members: unknown[] };
        triggers: {
          urgentImportantCount: number;
          latestByStock: Record<string, { priority: string }>;
        };
        meta: { warnings: string[] };
      };
    };
    expect(body.ok).toBe(true);
    const data = body.data;
    expect(data).toBeDefined();
    const row = data?.lists.find((list) => list.watchlist.id === wid);
    expect(row?.discoveredCount).toBe(1);
    expect(row?.todayEntered).toBeGreaterThanOrEqual(1);
    const holding = data?.stocks.find((stock) => stock.stockId === '600519.SH');
    expect(
      holding?.memberships.some(
        (membership) => membership.watchlistId === wid && membership.holding,
      ),
    ).toBe(true);
    // 行情聚合：名称/现价随股票返回（FakeMarketAdapter 覆盖全部种子 A 股）
    expect(holding?.name).toBe('贵州茅台');
    expect(typeof holding?.quote?.close).toBe('number');
    expect(
      data?.todayChanges.some(
        (change) => change.watchlistId === wid && change.direction === 'entered',
      ),
    ).toBe(true);
    expect(data?.archived.lists).toBeInstanceOf(Array);
    expect(data?.archived.members).toBeInstanceOf(Array);
    expect(data?.triggers.urgentImportantCount).toBeGreaterThanOrEqual(1);
    expect(data?.triggers.latestByStock['002594.SZ']?.priority).toBe('urgent');
    expect(data?.meta.warnings).toEqual([]);
  });

  it('归档路由走 targetMutation 三重闸口', async () => {
    const guarded = createWebApp(await buildTestContext(), {
      webToken: WEB_TOKEN,
      exposeWrite: false,
      exposeExternal: false,
    });
    expect(
      (await guarded.fetch(watchMutation('/api/watchlists/some-list/archive', {}))).status,
    ).toBe(403);
    expect(
      (
        await guarded.fetch(
          watchMutation('/api/watchlists/some-list/members/002594.SZ/archive', {}),
        )
      ).status,
    ).toBe(403);

    const noToken = await app.fetch(
      new Request('http://test/api/watchlists/some-list/archive', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(noToken.status).toBe(403);
  });
});

describe('loopback mutation 免 token', () => {
  it('无 token 可执行 write mutation，跨站 Origin 仍拒绝', async () => {
    const lax = createWebApp(await buildTestContext(), {
      webToken: WEB_TOKEN,
      exposeWrite: true,
      allowLoopbackMutation: true,
    });
    const created = await lax.fetch(
      new Request('http://test/api/watchlists', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'loopback-open',
          name: 'loopback',
          kind: 'personal',
          membershipPolicy: 'manual',
        }),
      }),
    );
    expect(created.status).toBe(200);

    const crossOrigin = await lax.fetch(
      new Request('http://test/api/watchlists', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({
          id: 'loopback-cross',
          name: 'cross',
          kind: 'personal',
          membershipPolicy: 'manual',
        }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
  });
});

describe('web tool 闸口：write 需本地 token', () => {
  it('write/external 缺 token → 403，read 仍可用', async () => {
    const write = await app.fetch(
      new Request('http://test/api/tools/add_trade/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { stockId: '601398.SH', side: 'buy', quantity: 1, price: 7.25 },
        }),
      }),
    );
    expect(write.status).toBe(403);

    const read = await app.fetch(
      new Request('http://test/api/tools/list_holdings/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: {} }),
      }),
    );
    expect(read.status).toBe(200);
  });

  it('跨站 Origin 即使 token 正确也拒绝 mutation', async () => {
    const r = await app.fetch(
      new Request('http://test/api/tools/add_trade/call', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
          origin: 'https://evil.example',
        },
        body: JSON.stringify({
          input: { stockId: '601398.SH', side: 'buy', quantity: 1, price: 7.25 },
        }),
      }),
    );
    expect(r.status).toBe(403);
  });

  it('add_trade（buy）建仓 → 200 且持仓可见', async () => {
    const r = await callTool('add_trade', {
      stockId: '601398.SH',
      side: 'buy',
      quantity: 500,
      price: 7.25,
    });
    expect(r.status).toBe(200);
    expect((await json(r)).ok).toBe(true);

    const holdings = await app.fetch(new Request('http://test/api/holdings'));
    const body = (await holdings.json()) as {
      data: { holdings: Array<{ holding: { stockId: string; quantity: number } }> };
    };
    const mine = body.data.holdings.find((h) => h.holding.stockId === '601398.SH');
    expect(mine?.holding.quantity).toBe(500);
  });

  it('create_account → 200 且可切换为空持仓账户', async () => {
    const created = await callTool('create_account', {
      id: 'web-real-account',
      name: 'Web 真实账户',
      currency: 'CNY',
      initialCapital: 100_000,
    });
    expect(created.status).toBe(200);
    const selected = await app.fetch(
      new Request('http://test/api/account/select', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ accountId: 'web-real-account' }),
      }),
    );
    expect(selected.status).toBe(200);
    const holdings = await app.fetch(new Request('http://test/api/holdings'));
    const body = (await holdings.json()) as {
      ok: boolean;
      data: { accountId: string; holdings: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.accountId).toBe('web-real-account');
    expect(body.data.holdings).toEqual([]);
    const restored = await app.fetch(
      new Request('http://test/api/account/select', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ accountId: TEST_ACCOUNT.id }),
      }),
    );
    expect(restored.status).toBe(200);
  });

  it('add_trade（buy）加仓 → 200 且数量累加', async () => {
    const r = await callTool('add_trade', {
      stockId: '601398.SH',
      side: 'buy',
      quantity: 300,
      price: 7.5,
    });
    expect(r.status).toBe(200);

    const holdings = await app.fetch(new Request('http://test/api/holdings'));
    const body = (await holdings.json()) as {
      data: { holdings: Array<{ holding: { stockId: string; quantity: number } }> };
    };
    const mine = body.data.holdings.find((h) => h.holding.stockId === '601398.SH');
    expect(mine?.holding.quantity).toBe(800);
  });

  it('add_trade（sell）超卖 → 400 invalid_input', async () => {
    const r = await callTool('add_trade', {
      stockId: '601398.SH',
      side: 'sell',
      quantity: 999_999,
      price: 7.5,
    });
    expect(r.status).toBe(400);
    const body = await json(r);
    expect(body.ok).toBe(false);
  });

  it('update_holding / close_holding → 200', async () => {
    const holdings = await app.fetch(new Request('http://test/api/holdings'));
    const body = (await holdings.json()) as {
      data: { holdings: Array<{ holding: { id: string } }> };
    };
    const id = body.data.holdings[0]?.holding.id;
    expect(id).toBeDefined();

    const u = await callTool('update_holding', { holdingId: id, avgCost: 7.1 });
    expect(u.status).toBe(200);
    expect((await json(u)).ok).toBe(true);

    const c = await callTool('close_holding', { holdingId: id });
    expect(c.status).toBe(200);
    expect((await json(c)).ok).toBe(true);

    // 平仓后默认（active）列表不再包含
    const after = await app.fetch(new Request('http://test/api/holdings'));
    const afterBody = (await after.json()) as {
      data: { holdings: Array<{ holding: { id: string } }> };
    };
    expect(afterBody.data.holdings.some((h) => h.holding.id === id)).toBe(false);
  });
});

describe('web tool 闸口：external 白名单与拒绝面', () => {
  it('远程研究导入在仅开启 external、未开启 write 时拒绝', async () => {
    const guarded = createWebApp(await buildTestContext(), {
      webToken: WEB_TOKEN,
      exposeWrite: false,
      exposeExternal: true,
    });
    const response = await guarded.fetch(
      new Request('http://test/api/tools/import_remote_research_document/call', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ input: { url: 'https://example.test/research' } }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { kind: 'permission_denied' },
    });
  });

  it('agent_run 进入 external 白名单，但仍要求 token 与 runtime', async () => {
    const withoutToken = await app.fetch(
      new Request('http://test/api/tools/agent_run/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { message: '检查持仓' } }),
      }),
    );
    expect(withoutToken.status).toBe(403);

    const withoutRuntime = await callTool('agent_run', { message: '检查持仓' });
    expect(withoutRuntime.status).toBe(403);
    const body = (await json(withoutRuntime)) as {
      error?: { kind: string; required?: string };
    };
    expect(body.error).toEqual({
      kind: 'permission_denied',
      required: 'agent runtime 未配置',
    });
  });

  it('fetch_quote（白名单）→ 200', async () => {
    const r = await callTool('fetch_quote', { stockId: '002594.SZ' });
    expect(r.status).toBe(200);
    expect((await json(r)).ok).toBe(true);
  });

  it('batch_quote（白名单）→ 200', async () => {
    const r = await callTool('batch_quote', { stockIds: ['002594.SZ'] });
    expect(r.status).toBe(200);
    expect((await json(r)).ok).toBe(true);
  });

  it('fetch_index_quotes（白名单）→ 200；数据源不支持时 unsupported 降级', async () => {
    const r = await callTool('fetch_index_quotes', {});
    expect(r.status).toBe(200);
    const body = (await json(r)) as {
      ok: boolean;
      data?: { indices: unknown[]; unsupported?: boolean };
    };
    expect(body.ok).toBe(true);
    // FakeMarketAdapter 未实现 fetchIndexQuotes → 合法降级而非报错
    expect(body.data?.indices).toEqual([]);
    expect(body.data?.unsupported).toBe(true);
  });

  it('get_stock_market_view（白名单）→ 200；缺 token → 403', async () => {
    const r = await callTool('get_stock_market_view', { stockId: '002594.SZ' });
    expect(r.status).toBe(200);
    const body = (await json(r)) as {
      ok: boolean;
      data?: { candles?: unknown[]; dataStatus?: { freshness?: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.candles?.length).toBeGreaterThan(0);

    const withoutToken = await app.fetch(
      new Request('http://test/api/tools/get_stock_market_view/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { stockId: '002594.SZ' } }),
      }),
    );
    expect(withoutToken.status).toBe(403);
  });

  it('get_stock_market_view 全源失败且无本地数据 → adapter_error 转 502', async () => {
    const base = await buildTestContext();
    const failingMarket = {
      ...base.adapters.market,
      name: 'failing-market',
      fetchQuote: () => Promise.reject(new Error('quote upstream down')),
      batchQuote: () => Promise.resolve(new Map()),
      fetchDailyBars: () => Promise.reject(new Error('kline upstream down')),
    };
    const testApp = createWebApp(
      { ...base, adapters: { ...base.adapters, market: failingMarket } },
      { webToken: WEB_TOKEN, exposeExternal: true },
    );
    const r = await testApp.fetch(
      new Request('http://test/api/tools/get_stock_market_view/call', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ input: { stockId: '002594.SZ' } }),
      }),
    );
    expect(r.status).toBe(502);
    const body = (await r.json()) as { ok: boolean; error?: { kind: string } };
    expect(body.error?.kind).toBe('adapter_error');
  });

  it('sync_quotes / send_notification（external 非白名单）→ 403', async () => {
    for (const name of ['sync_quotes', 'send_notification']) {
      const r = await callTool(name, {});
      expect(r.status).toBe(403);
      const body = (await json(r)) as { ok: boolean; error?: { kind: string } };
      expect(body.error?.kind).toBe('permission_denied');
    }
  });

  it('place_order（trade，契约未实现）→ 403 permission_denied', async () => {
    const r = await callTool('place_order', {});
    expect(r.status).toBe(403);
  });

  it('不存在的 tool → 404 not_found', async () => {
    const r = await callTool('no_such_tool', {});
    expect(r.status).toBe(404);
  });

  it('请求体非 JSON → 400 invalid_input', async () => {
    const r = await app.fetch(
      new Request('http://test/api/tools/add_trade/call', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: 'not-json',
      }),
    );
    expect(r.status).toBe(400);
  });
});

describe('/api/advice 查询参数', () => {
  it('透传 subjectKind / limit 给 get_advice：结果全部匹配过滤条件且不超上限', async () => {
    const r = await app.fetch(new Request('http://test/api/advice?subjectKind=stock&limit=1'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      data?: { advices: Array<{ subjectKind: string }>; total: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.advices.length).toBeLessThanOrEqual(1);
    for (const advice of body.data?.advices ?? []) {
      expect(advice.subjectKind).toBe('stock');
    }
  });

  it('非法 subjectKind 由 get_advice schema 拒绝为 invalid_input', async () => {
    const r = await app.fetch(new Request('http://test/api/advice?subjectKind=bogus'));
    const body = (await r.json()) as { ok: boolean; error?: { kind: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.kind).toBe('invalid_input');
  });
});

describe('MVP dashboard / watch API', () => {
  it('dashboard 聚合持仓、Watchlist、AlertPlan、watch 状态与最近触发', async () => {
    const r = await app.fetch(new Request('http://test/api/dashboard'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      data?: {
        holdings: { holdings: unknown[] };
        watchlists: { items: unknown[] };
        alertPlans: { plans: unknown[] };
        watch: { state: string };
        triggers: { triggers: unknown[] };
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.holdings.holdings.length).toBeGreaterThan(0);
    expect(body.data?.watch.state).toBe('never');
  });

  it('dashboard 含指数条 / 实时看板 / 今日预警；指数不支持时仍 200 且 indices 为空', async () => {
    const r = await app.fetch(new Request('http://test/api/dashboard'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      data?: {
        indices: { indices: unknown[]; unsupported?: boolean };
        board: Array<{
          stockId: string;
          name: string;
          quote: { close: number; ts: string } | null;
          changePct: number | null;
          holding: { quantity: number; marketValue: number } | null;
          watchlists: string[];
          todayTrigger: { count: number; maxPriority: string } | null;
        }>;
        todayTriggers: unknown[];
        meta: { warnings: string[] };
      };
    };
    expect(body.ok).toBe(true);
    // FakeMarketAdapter 未实现 fetchIndexQuotes → 降级为空而不是拖垮 dashboard
    expect(body.data?.indices.indices).toEqual([]);
    expect(body.data?.indices.unsupported).toBe(true);
    expect(body.data?.meta.warnings).toEqual([]);
    expect(body.data?.todayTriggers).toBeInstanceOf(Array);
    const board = body.data?.board ?? [];
    expect(board.length).toBeGreaterThan(0);
    const held = board.find((item) => item.holding !== null);
    expect(held).toBeDefined();
    expect(typeof held?.stockId).toBe('string');
    expect(typeof held?.name).toBe('string');
    expect(held?.quote?.close).toBeGreaterThan(0);
    expect(held?.watchlists).toBeInstanceOf(Array);
  });

  it('run-once 需要 token；成功后 watch status 可见', async () => {
    const denied = await app.fetch(
      new Request('http://test/api/watch/run-once', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notify: false }),
      }),
    );
    expect(denied.status).toBe(403);

    const run = await app.fetch(
      new Request('http://test/api/watch/run-once', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ notify: false }),
      }),
    );
    expect(run.status).toBe(200);

    const status = await app.fetch(new Request('http://test/api/watch/status'));
    const body = (await status.json()) as { data?: { state: string; latest: { mode: string } } };
    expect(body.data?.state).toBe('healthy');
    expect(body.data?.latest.mode).toBe('once');
  });
});

/* ============ /api/chat：AI SDK UI Message Stream ============ */

const chat = async (target: Hono, body: unknown): Promise<Response> =>
  await target.fetch(
    new Request('http://test/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('/api/chat：对话助手', () => {
  let chatApp: Hono;
  let chatCtx: Awaited<ReturnType<typeof buildTestContext>>;
  let captured:
    | {
        instructions: string;
        uiMessages: readonly unknown[];
        tools: readonly AgentCallableTool[];
      }
    | undefined;
  const runtime: ChatStreamRuntime = {
    createUIMessageStreamResponse: async (request) => {
      captured = request;
      await request.onFinish?.({
        id: '',
        parts: [{ type: 'text', text: '你好' }],
      });
      return new Response(
        [
          'data: {"type":"start","messageId":"assistant-1"}',
          'data: {"type":"text-start","id":"text-1"}',
          'data: {"type":"text-delta","id":"text-1","delta":"你好"}',
          'data: {"type":"text-end","id":"text-1"}',
          'data: {"type":"finish"}',
          'data: [DONE]',
          '',
        ].join('\n\n'),
        {
          headers: {
            'content-type': 'text/event-stream',
            'x-vercel-ai-ui-message-stream': 'v1',
          },
        },
      );
    },
  };

  beforeAll(async () => {
    chatCtx = await buildTestContext();
    chatApp = createWebApp(chatCtx, {
      chatStreamRuntime: runtime,
      webToken: WEB_TOKEN,
      exposeWrite: true,
      exposeExternal: true,
    });
  });

  const createSession = async (id: string): Promise<void> => {
    const now = new Date('2026-07-26T00:00:00.000Z');
    await chatCtx.repos.chat.saveSession({
      id,
      accountId: chatCtx.user.defaultAccountId,
      title: '新会话',
      createdAt: now,
      updatedAt: now,
    });
  };

  it('返回标准 AI SDK UI Message SSE，并传入 canonical tools', async () => {
    await createSession('stream-contract');
    const response = await chat(chatApp, {
      sessionId: 'stream-contract',
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '你好' }] }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(await response.text()).toContain('"type":"text-delta"');
    expect(captured?.tools.map((item) => item.name)).toContain('fetch_quote');
    expect(captured?.tools.map((item) => item.name)).not.toContain('get_quote');
    expect(captured?.instructions).toContain('不得自动交易');
    expect(await chatCtx.repos.chat.listMessages('stream-contract')).toHaveLength(2);
  });

  it('非法 UIMessage 与非 user 结尾 → 400 invalid_input', async () => {
    expect((await chat(chatApp, { messages: [] })).status).toBe(400);
    await createSession('invalid-message');
    expect(
      (
        await chat(chatApp, {
          sessionId: 'invalid-message',
          messages: [
            { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'x' }] },
          ],
        })
      ).status,
    ).toBe(400);
  });

  it('从服务端会话加载最近 20 条消息，不信任客户端历史', async () => {
    await createSession('server-history');
    for (let index = 0; index < 21; index += 1) {
      await chatCtx.repos.chat.saveMessage({
        id: `history-${index}`,
        sessionId: 'server-history',
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `server-turn-${index}` }],
        createdAt: new Date(Date.UTC(2026, 6, 26, 0, 0, index)),
      });
    }
    expect(
      (
        await chat(chatApp, {
          sessionId: 'server-history',
          messages: [
            {
              id: 'latest-user',
              role: 'user',
              parts: [{ type: 'text', text: '客户端输入' }],
            },
          ],
        })
      ).status,
    ).toBe(200);
    expect(captured?.uiMessages).toHaveLength(20);
    expect(JSON.stringify(captured?.uiMessages)).not.toContain('client-fake-history');
  });

  it('目标模型 write 工具只生成已校验草案，不执行 DB 写入', async () => {
    await createSession('draft-tool');
    await chat(chatApp, {
      sessionId: 'draft-tool',
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '创建 Strategy' }] }],
    });
    const draftTool = captured?.tools.find((item) => item.name === 'create_strategy');
    const result = await draftTool?.execute({
      id: 'chat-draft-strategy',
      name: '对话草案 Strategy',
      description: '仅用于验证目标模型草案',
    });
    expect(result?.ok).toBe(true);
    expect(result?.output).toMatchObject({
      __luoomeDraft: true,
      draft: { kind: 'strategy', tool: 'create_strategy' },
    });
    expect(await chatCtx.repos.strategy.findById('chat-draft-strategy')).toBeNull();
  });

  it('read 工具仍经 registry 执行，未批准的 external/trade 不暴露', async () => {
    await createSession('read-tools');
    await chat(chatApp, {
      sessionId: 'read-tools',
      messages: [{ id: 'user-1', role: 'user', parts: [{ type: 'text', text: '查持仓' }] }],
    });
    const names = captured?.tools.map((item) => item.name) ?? [];
    expect(names).toContain('list_holdings');
    expect(names).toContain('list_strategies');
    expect(names).toContain('list_watchlists');
    expect(names).toContain('list_alert_plans');
    expect(names).not.toContain('list_tactics');
    expect(names).not.toContain('list_stock_groups');
    expect(names).not.toContain('list_stock_pools');
    expect(names).not.toContain('sync_quotes');
    expect(names).not.toContain('send_notification');
    expect(names).not.toContain('place_order');
  });

  it('会话 API 支持创建、重命名、读取与删除，并要求 mutation token', async () => {
    const denied = await chatApp.fetch(
      new Request('http://test/api/chat/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(denied.status).toBe(403);

    const created = await chatApp.fetch(
      new Request('http://test/api/chat/sessions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ title: '策略研究' }),
      }),
    );
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { data: { session: { id: string } } };
    const sessionId = createdBody.data.session.id;

    const renamed = await chatApp.fetch(
      new Request(`http://test/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ title: '长期价值研究' }),
      }),
    );
    expect(renamed.status).toBe(200);

    const detail = await chatApp.fetch(new Request(`http://test/api/chat/sessions/${sessionId}`));
    expect(detail.status).toBe(200);
    expect((await detail.text()).includes('长期价值研究')).toBe(true);

    const removed = await chatApp.fetch(
      new Request(`http://test/api/chat/sessions/${sessionId}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${WEB_TOKEN}` },
      }),
    );
    expect(removed.status).toBe(200);
    expect(
      (await chatApp.fetch(new Request(`http://test/api/chat/sessions/${sessionId}`))).status,
    ).toBe(404);
  });
});

describe('GET /api/stocks/search', () => {
  const originalTushareToken = process.env.TUSHARE_TOKEN;
  const originalTushareUrl = process.env.TUSHARE_URL;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalTushareToken === undefined) delete process.env.TUSHARE_TOKEN;
    else process.env.TUSHARE_TOKEN = originalTushareToken;
    if (originalTushareUrl === undefined) delete process.env.TUSHARE_URL;
    else process.env.TUSHARE_URL = originalTushareUrl;
    globalThis.fetch = originalFetch;
  });

  it('q 为空 → 400 invalid_input', async () => {
    const r = await app.fetch(new Request('http://test/api/stocks/search?q='));
    expect(r.status).toBe(400);
    const body = (await r.json()) as { ok: boolean; error?: { kind: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.kind).toBe('invalid_input');
  });

  it('未配置 TUSHARE_TOKEN 时回退到本地 search_stocks', async () => {
    delete process.env.TUSHARE_TOKEN;
    const testApp = createWebApp(await buildTestContext());
    const r = await testApp.fetch(new Request('http://test/api/stocks/search?q=%E8%8C%85'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; data?: { stocks: unknown[]; source: string } };
    expect(body.ok).toBe(true);
    expect(body.data?.source).not.toBe('tushare');
    expect(body.data?.stocks.length).toBeGreaterThan(0);
  });

  it('配置 TUSHARE_TOKEN 也只通过 search_stocks 的 adapter registry 搜索', async () => {
    process.env.TUSHARE_TOKEN = 'test-tushare-token';
    let directFetchCalls = 0;
    globalThis.fetch = (async () => {
      directFetchCalls += 1;
      throw new Error('Web route must not call Tushare directly');
    }) as unknown as typeof fetch;
    const testApp = createWebApp(await buildTestContext());
    const r = await testApp.fetch(
      new Request('http://test/api/stocks/search?q=%E8%B4%B5%E5%B7%9E%E8%8C%85%E5%8F%B0'),
    );

    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      data?: { stocks: Array<{ id: string }>; source: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.source).toBe('external');
    expect(body.data?.stocks[0]?.id).toBe('600519.SH');
    expect(directFetchCalls).toBe(0);
  });
});

/* ============ v0.7 策略预警（docs/.../§10）Web 端点 ============ */

describe('Web 策略预警：模板与反馈（v0.7 §10）', () => {
  it('POST /api/watch/triggers/:id/feedback：triggerId 不存在 → 404；feedback 非法 → 400；happy path → 200 + 回写', async () => {
    const missing = await app.fetch(
      new Request('http://test/api/watch/triggers/nonexistent/feedback', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ feedback: 'useful' }),
      }),
    );
    expect(missing.status).toBe(404);

    const watchlistId = 'feedback-watchlist';
    const alertPlanId = 'feedback-alert';
    expect(
      (
        await callTool('create_watchlist', {
          id: watchlistId,
          name: '反馈 Watchlist',
          kind: 'personal',
          membershipPolicy: 'manual',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await callTool('create_alert_plan', {
          id: alertPlanId,
          name: '反馈 AlertPlan',
          watchlistId,
          rules: [{ id: 'feedback-rule', kind: 'price-level', side: 'above', level: 15 }],
        })
      ).status,
    ).toBe(200);
    const saved = await saveWatchTriggerTool.execute(
      {
        id: 'fb-test',
        alertPlanId,
        poolId: alertPlanId,
        stockId: '002594.SZ',
        ruleKind: 'price-level',
        ruleId: 'feedback-rule',
        triggerType: 'triggered',
        direction: 'watch',
        priority: 'important',
        deliveryStatus: 'sent',
        evalSnapshot: { ruleId: 'feedback-rule', kind: 'price-level' },
        reason: '单元测试触发',
        evidence: ['close=15.2'],
        quote: { close: 15.2, ts: new Date() },
        notified: true,
        createdAt: new Date(),
      },
      appCtx,
    );
    expect(saved.ok).toBe(true);
    const triggerId = 'fb-test';
    const ok = await app.fetch(
      new Request(`http://test/api/watch/triggers/${triggerId}/feedback`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ feedback: 'useful' }),
      }),
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as {
      ok: boolean;
      data?: { triggerId: string; feedback: string };
    };
    expect(okBody.ok).toBe(true);
    expect(okBody.data?.triggerId).toBe(triggerId);
    expect(okBody.data?.feedback).toBe('useful');

    // 非法 feedback
    const bad2 = await app.fetch(
      new Request(`http://test/api/watch/triggers/${triggerId}/feedback`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${WEB_TOKEN}`,
        },
        body: JSON.stringify({ feedback: 'maybe' }),
      }),
    );
    expect(bad2.status).toBe(400);
  });

  it('GET /api/watch/triggers 转发 priority / deliveryStatus / feedback / triggerType 过滤参数', async () => {
    const url =
      'http://test/api/watch/triggers?priority=urgent&deliveryStatus=sent&feedback=useful&triggerType=triggered';
    const r = await app.fetch(new Request(url));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; data?: { triggers: unknown[]; total: number } };
    expect(body.ok).toBe(true);
    expect(body.data?.total).toBeGreaterThanOrEqual(0);
  });

  it('dashboard metrics 字段齐全（priorityCounts / deliveryStatusCounts / feedbackCounts / latestRun.notifyFailed / suppressedByDailyLimit / noiseRate）', async () => {
    const r = await app.fetch(new Request('http://test/api/dashboard'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      data?: {
        metrics?: Record<string, unknown>;
      };
    };
    expect(body.ok).toBe(true);
    const m = body.data?.metrics ?? {};
    expect(m).toHaveProperty('todayTotal');
    expect(m).toHaveProperty('priorityCounts');
    expect(m).toHaveProperty('deliveryStatusCounts');
    expect(m).toHaveProperty('feedbackCounts');
    expect(m).toHaveProperty('noiseRate');
    const latestRun = m.latestRun as null | Record<string, unknown>;
    if (latestRun !== null) {
      expect(latestRun).toHaveProperty('notifyFailed');
      expect(latestRun).toHaveProperty('suppressedByDailyLimit');
    }
  });
});

/**
 * 连板天梯 Web API（Phase 2，docs/ddd/limit-up-ladder-detailed-design.md §11）。
 * 用 stub manager 隔离 eastmoney 实链，避免本地 SQLite / 网络依赖。
 */
import type {
  LimitUpLadder,
  LimitUpLadderCompareResultLike,
  LimitUpLadderManagerLike,
  LimitUpLadderResultLike,
} from '@luoome/core';

const stubLadderManager = (opts: {
  readonly ladder?: LimitUpLadder;
  readonly compare?: LimitUpLadderCompareResultLike;
  readonly fail?: boolean;
}): LimitUpLadderManagerLike => ({
  name: 'limit-up-ladder',
  sources: ['eastmoney'],
  fetchLadder: async (): Promise<LimitUpLadderResultLike> => {
    if (opts.fail === true) {
      return {
        ok: false,
        error: {
          kind: 'adapter_error',
          adapter: 'limit-up-ladder',
          message: 'eastmoney forced fail',
          recoverable: false,
        },
      };
    }
    const ladder = opts.ladder ?? {
      date: '2026-07-25',
      total: 1,
      maxLevel: 1,
      source: 'eastmoney' as const,
      levels: [
        {
          level: 1,
          name: '首板',
          count: 1,
          stocks: [
            {
              code: '600519',
              name: '贵州茅台',
              industry: '白酒',
              ladderLevel: 1,
              uncategorized: false,
              firstTime: '10:00:00',
              finalTime: '10:00:00',
              reason: '涨价',
              price: 1850,
              rawClose: 1850,
              corrected: false,
              changePct: 0.1,
              limitUpDate: '2026-07-25',
              board: 'main_board' as const,
            },
          ],
        },
      ],
      warnings: [],
      asOf: new Date('2026-07-25T12:00:00Z'),
    };
    return { ok: true, data: ladder };
  },
  compareLadder: async (): Promise<LimitUpLadderCompareResultLike> => {
    if (opts.compare !== undefined) return opts.compare;
    return {
      ok: false,
      error: {
        kind: 'adapter_error',
        adapter: 'limit-up-ladder',
        message: 'no stub',
        recoverable: false,
      },
    };
  },
});

describe('Web 连板天梯 API', () => {
  it('缺少 date 必填参数 → invalid_input', async () => {
    const testApp = createWebApp(await buildTestContext({ limitUpLadder: stubLadderManager({}) }));
    const r = await testApp.fetch(new Request('http://test/api/market/limit-up'));
    expect(r.status).toBe(400);
    const body = (await r.json()) as { ok: boolean; error?: { kind: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.kind).toBe('invalid_input');
  });

  it('date 非法格式 → invalid_input', async () => {
    const testApp = createWebApp(await buildTestContext({ limitUpLadder: stubLadderManager({}) }));
    const r = await testApp.fetch(new Request('http://test/api/market/limit-up?date=2026/07/25'));
    expect(r.status).toBe(400);
  });

  it('正常请求 → 200 + 与 stub 一致 ladder', async () => {
    const testApp = createWebApp(await buildTestContext({ limitUpLadder: stubLadderManager({}) }));
    const r = await testApp.fetch(new Request('http://test/api/market/limit-up?date=2026-07-25'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      data?: { date: string; total: number; source: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data?.date).toBe('2026-07-25');
    expect(body.data?.source).toBe('eastmoney');
  });

  it('上游不可达 → 502', async () => {
    const testApp = createWebApp(
      await buildTestContext({ limitUpLadder: stubLadderManager({ fail: true }) }),
    );
    const r = await testApp.fetch(new Request('http://test/api/market/limit-up?date=2026-07-25'));
    expect(r.status).toBe(502);
  });

  it('HTML 路由 /market/limit-up 返回 index.html', async () => {
    const testApp = createWebApp(await buildTestContext());
    const r = await testApp.fetch(new Request('http://test/market/limit-up'));
    expect(r.status).toBe(200);
    const ct = r.headers.get('content-type') ?? '';
    expect(ct).toContain('text/html');
  });

  it('compare 端点:date 缺失 → 400', async () => {
    const testApp = createWebApp(await buildTestContext({ limitUpLadder: stubLadderManager({}) }));
    const r = await testApp.fetch(
      new Request('http://test/api/market/limit-up/compare?prevDate=2026-07-24'),
    );
    expect(r.status).toBe(400);
  });

  it('compare 端点:正常 → 200 + diff 字段', async () => {
    const stubCompare: LimitUpLadderCompareResultLike = {
      ok: true,
      data: {
        curr: {
          date: '2026-07-25',
          total: 2,
          maxLevel: 1,
          source: 'eastmoney',
          levels: [],
          warnings: [],
          asOf: new Date(),
        },
        prev: {
          date: '2026-07-24',
          total: 1,
          maxLevel: 1,
          source: 'eastmoney',
          levels: [],
          warnings: [],
          asOf: new Date(),
        },
        diff: {
          totalDelta: 1,
          maxLevelDelta: 0,
          topLevelAdded: ['600519'],
          topLevelRemoved: [],
          topLevelRetained: ['000001'],
        },
      },
    };
    const testApp = createWebApp(
      await buildTestContext({ limitUpLadder: stubLadderManager({ compare: stubCompare }) }),
    );
    const r = await testApp.fetch(
      new Request('http://test/api/market/limit-up/compare?date=2026-07-25&prevDate=2026-07-24'),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; data?: { diff: { totalDelta: number } } };
    expect(body.ok).toBe(true);
    expect(body.data?.diff.totalDelta).toBe(1);
  });
});

describe('行情页 vendor 与 SPA 路由（stock-market-view §12.1 / §14.3）', () => {
  it('vendor ESM 路由返回正确 content-type 与长缓存', async () => {
    const r = await app.fetch(new Request('http://test/vendor/lightweight-charts-5.2.0.mjs'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/javascript');
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const body = await r.text();
    expect(body).toContain('createChart');
  });

  it('/vendor 下其它路径与目录遍历不可访问', async () => {
    for (const path of [
      '/vendor/',
      '/vendor/other.mjs',
      '/vendor/../src/server.ts',
      '/vendor/%2e%2e/package.json',
    ]) {
      const r = await app.fetch(new Request(`http://test${path}`));
      expect(r.status).toBe(404);
    }
  });

  it('/market SPA 路由返回 index.html（含行情路由 section）', async () => {
    const r = await app.fetch(new Request('http://test/market'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toContain('text/html');
    const html = await r.text();
    expect(html).toContain('data-route="market"');
    // 行情不再有侧栏菜单项，入口在持仓 / 分组 / 仪表盘搜索；深链接 section 保留。
    expect(html).toContain('id="route-market"');
    expect(html).not.toContain('href="#market" data-route="market"');
  });

  it('股票搜索只接受 q：旧 query= 视为缺参 → 400', async () => {
    const r = await app.fetch(new Request('http://test/api/stocks/search?query=002594'));
    expect(r.status).toBe(400);
    const body = (await json(r)) as { ok: boolean; error?: { kind: string } };
    expect(body.error?.kind).toBe('invalid_input');
  });
});

describe('dashboard 看板 Watchlist 合并路径', () => {
  interface BoardItem {
    stockId: string;
    quote: { close: number } | null;
    changePct: number | null;
    holding: unknown;
    watchlists: string[];
  }
  interface DashboardBody {
    ok: boolean;
    data?: { board: BoardItem[]; meta: { warnings: string[] } };
  }

  const BOARD_RULES = [{ id: 'board-rule', kind: 'price-level', side: 'above', level: 15 }];

  it('plan.enabled / watchlist.enabled 过滤、成员去重与 changePct 补全', async () => {
    // 两个启用 Watchlist 引用同一成员（去重合并）；一个停用方案引用启用池
    // （plan.enabled 过滤）；一个启用方案引用停用池（watchlist.enabled 过滤）。
    for (const [id, name, enabled] of [
      ['board-wl-a', '看板 A', true],
      ['board-wl-b', '看板 B', true],
      ['board-wl-c', '看板 C', true],
      ['board-wl-off', '看板停用', false],
    ] as const) {
      expect(
        (
          await callTool('create_watchlist', {
            id,
            name,
            kind: 'personal',
            membershipPolicy: 'manual',
            enabled,
          })
        ).status,
      ).toBe(200);
    }
    for (const [watchlistId, stockId] of [
      ['board-wl-a', '000063.SZ'],
      ['board-wl-b', '000063.SZ'],
      ['board-wl-a', '002415.SZ'],
      ['board-wl-c', '688981.SH'],
      ['board-wl-off', '600900.SH'],
    ] as const) {
      expect((await callTool('add_watchlist_member', { watchlistId, stockId })).status).toBe(200);
    }
    for (const [id, watchlistId, enabled] of [
      ['board-plan-a', 'board-wl-a', true],
      ['board-plan-b', 'board-wl-b', true],
      ['board-plan-off', 'board-wl-c', false],
      ['board-plan-wl-off', 'board-wl-off', true],
    ] as const) {
      expect(
        (
          await callTool('create_alert_plan', {
            id,
            name: `方案 ${id}`,
            watchlistId,
            rules: BOARD_RULES,
            enabled,
          })
        ).status,
      ).toBe(200);
    }

    const r = await app.fetch(new Request('http://test/api/dashboard'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as DashboardBody;
    const board = body.data?.board ?? [];
    const byStock = (stockId: string) => board.filter((item) => item.stockId === stockId);

    // 同一成员被两个启用 Watchlist 引用 → 仅一行，名单合并
    const merged = byStock('000063.SZ');
    expect(merged).toHaveLength(1);
    const mergedItem = merged[0];
    expect(mergedItem).toBeDefined();
    expect([...(mergedItem?.watchlists ?? [])].sort()).toEqual(['看板 A', '看板 B']);
    // changePct 由 batch_quote 昨收基准补全（FakeMarketAdapter prevClose > 0）
    expect(mergedItem?.quote).not.toBeNull();
    expect(typeof mergedItem?.changePct).toBe('number');
    // 非持仓成员不占 holding 槽
    expect(mergedItem?.holding).toBeNull();

    expect(byStock('002415.SZ').map((item) => item.watchlists)).toEqual([['看板 A']]);
    // 停用方案引用的成员不进看板（plan.enabled 过滤）
    expect(byStock('688981.SH')).toHaveLength(0);
    // 停用 Watchlist 的成员不进看板（watchlist.enabled 过滤）
    expect(byStock('600900.SH')).toHaveLength(0);
  });

  it('get_watchlist 失败降级为 warning，看板跳过该 Watchlist', async () => {
    // findById 只被 get_watchlist 使用；list_watchlists 走 list，不受影响的
    // Watchlist 行仍会通过 enabled 过滤进入待拉详情列表。
    // repo 是类实例，不能用展开（丢原型方法）；用原型保持的包装覆写 findById。
    const watchlistRepo = Object.create(
      Object.getPrototypeOf(appCtx.repos.watchlist),
      Object.getOwnPropertyDescriptors(appCtx.repos.watchlist),
    ) as typeof appCtx.repos.watchlist;
    watchlistRepo.findById = async (id: string) => {
      if (id.startsWith('board-wl-')) {
        throw new Error('forced findById failure');
      }
      return appCtx.repos.watchlist.findById(id);
    };
    const brokenCtx: ToolContext = {
      ...appCtx,
      repos: { ...appCtx.repos, watchlist: watchlistRepo },
    };
    const brokenApp = createWebApp(brokenCtx, {
      webToken: WEB_TOKEN,
      exposeWrite: true,
      exposeExternal: true,
    });
    const r = await brokenApp.fetch(new Request('http://test/api/dashboard'));
    expect(r.status).toBe(200);
    const body = (await r.json()) as DashboardBody;
    expect(body.ok).toBe(true);
    const warnings = body.data?.meta.warnings ?? [];
    expect(warnings.some((w) => w.includes('get_watchlist(board-wl-a)'))).toBe(true);
    const board = body.data?.board ?? [];
    expect(board.some((item) => item.stockId === '000063.SZ')).toBe(false);
  });
});
