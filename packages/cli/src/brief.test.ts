import { TEST_ACCOUNT } from '@luoome/adapters/testing';
import { dateInShanghai, type StockBrief, StockBriefSchema } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  loadProjectEnv: vi.fn(),
  createCliContext: vi.fn(),
  overrides: new Map<string, unknown>(),
}));

vi.mock('./env.js', () => ({ loadProjectEnv: mocked.loadProjectEnv }));
vi.mock('./context.js', () => ({
  MARKET_PROVIDER_HINT: '需要行情数据',
  luoomeHome: () => '/tmp/luoome-test',
  createCliContext: mocked.createCliContext,
}));
vi.mock('./app-service.js', async () => {
  const actual = await vi.importActual<typeof import('./app-service.js')>('./app-service.js');
  return {
    resolveTool: (name: string) =>
      mocked.overrides.get(name) ??
      actual.resolveTool(name as Parameters<typeof actual.resolveTool>[0]),
  };
});

import { runCli } from './index.js';

const FIXED_NOW = new Date('2026-11-24T09:30:00Z');
const TRADING_DATE = dateInShanghai(FIXED_NOW);

const briefRow = (overrides: Record<string, unknown> = {}): StockBrief =>
  StockBriefSchema.parse({
    id: 'brief-1',
    tradingDate: TRADING_DATE,
    phase: 'post-market',
    accountId: TEST_ACCOUNT.id,
    stockId: '002594.SZ',
    source: 'scheduled',
    decision: 'buy',
    confidence: 64,
    horizon: 'short',
    quality: 'partial',
    factDigest: 'digest-abcdef0123456789',
    factsAsOf: FIXED_NOW,
    missing: [{ dimension: 'intraday', reason: '分时拉取失败：timeout' }],
    dataSources: ['eastmoney'],
    llmHttpCalls: 1,
    llmPromptTokens: 1200,
    llmCompletionTokens: 600,
    llmReasoningTokens: 200,
    llmCostUsd: 0,
    validUntil: new Date('2026-11-30T09:00:00Z'),
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    ...overrides,
  });

const seed = async (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  await ctx.repos.stockBrief.upsert(briefRow({ id: 'brief-a' }));
  await ctx.repos.stockBrief.upsert(
    briefRow({
      id: 'brief-b',
      stockId: '600519.SH',
      decision: 'watch',
      confidence: 30,
      quality: 'rule-only',
      adviceId: undefined,
      missing: [],
      dataSources: [],
    }),
  );
};

/** 计数型适配器：证明只读子命令不触发行情 / LLM。 */
const withCounters = (ctx: Awaited<ReturnType<typeof buildTestContext>>) => {
  const calls = { llm: 0, market: 0 };
  const llm = {
    name: ctx.adapters.llm.name,
    generate: async () => {
      calls.llm += 1;
      throw new Error('read-only command must not call llm');
    },
  };
  const market = new Proxy(ctx.adapters.market, {
    get: (target, prop) => {
      const value = Reflect.get(target, prop);
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          calls.market += 1;
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { ctx: { ...ctx, adapters: { ...ctx.adapters, llm, market } } as typeof ctx, calls };
};

describe('CLI brief list/show/run', () => {
  let testCtx: Awaited<ReturnType<typeof buildTestContext>>;
  let logged: string[];

  const installContext = () => {
    mocked.createCliContext.mockImplementation(async () => ({
      ctx: testCtx,
      dbPath: ':memory:',
      close: () => {},
    }));
  };

  const jsonPayload = (): { ok: boolean; data: Record<string, unknown> } => {
    const raw = logged[logged.length - 1];
    expect(raw).toBeDefined();
    return JSON.parse(raw ?? '{}') as { ok: boolean; data: Record<string, unknown> };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocked.overrides.clear();
    installContext();
    logged = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    testCtx = await buildTestContext({ advices: [], clock: () => FIXED_NOW });
    await seed(testCtx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LUOOME_EXPOSE_EXTERNAL;
  });

  it('brief list --json 输出与 Web 同形的 StockBriefView 列表（含免责声明与预算）', async () => {
    const code = await runCli(['brief', 'list', '--json']);
    expect(code).toBe(0);
    const payload = jsonPayload();
    expect(payload.ok).toBe(true);
    const data = payload.data as {
      date: string;
      items: Array<{
        stockId: string;
        wording: { label: string; disclaimer: string };
        disclaimer: string;
        evidence: unknown[];
        missing: unknown[];
        budget: { limit: { maxHttpCalls: number } };
        isRuleOnly: boolean;
      }>;
      budget: { date: string };
      coverage: { byQuality: { partial: number; ruleOnly: number } };
    };
    expect(data.date).toBe(TRADING_DATE);
    expect(data.items).toHaveLength(2);
    const item = data.items.find((entry) => entry.stockId === '002594.SZ');
    expect(item?.wording.label).toBe('偏多信号');
    expect(item?.disclaimer).toContain('不构成投资建议');
    expect(item?.isRuleOnly).toBe(false);
    expect(item?.evidence.length).toBeGreaterThan(0);
    expect(item?.missing).toHaveLength(1);
    expect(item?.budget.limit.maxHttpCalls).toBe(16);
    expect(data.coverage.byQuality).toMatchObject({ partial: 1, ruleOnly: 1 });
  });

  it('brief show --json 与 Web 详情 view 同形，缺外部能力仍可读', async () => {
    delete process.env.LUOOME_EXPOSE_EXTERNAL;
    const code = await runCli(['brief', 'show', '--stock', '002594.SZ', '--json']);
    expect(code).toBe(0);
    const payload = jsonPayload();
    expect(payload.ok).toBe(true);
    const view = payload.data as {
      stockId: string;
      wording: { label: string };
      disclaimer: string;
      evidence: Array<{ label: string; value: string | null; missing: boolean }>;
      missing: Array<{ dimension: string }>;
      budget: { date: string };
      isRuleOnly: boolean;
    };
    expect(view.stockId).toBe('002594.SZ');
    expect(view.wording.label).toBe('偏多信号');
    expect(view.disclaimer).toContain('不构成投资建议');
    expect(view.evidence.some((row) => row.label === '数据来源')).toBe(true);
    expect(view.missing).toEqual([{ dimension: 'intraday', reason: '分时拉取失败：timeout' }]);
    expect(view.budget.date).toBe(TRADING_DATE);
  });

  it('brief list / show 只读本地：0 次行情、0 次 LLM，文本含免责声明且无操作动词', async () => {
    const counter = withCounters(testCtx);
    testCtx = counter.ctx;
    installContext();

    expect(await runCli(['brief', 'list'])).toBe(0);
    expect(await runCli(['brief', 'show', '--stock', '002594.SZ'])).toBe(0);
    expect(counter.calls.market).toBe(0);
    expect(counter.calls.llm).toBe(0);
    const text = logged.join('\n');
    expect(text).toContain('不构成投资建议');
    expect(text).toContain('偏多信号');
    expect(text).not.toMatch(/建仓|加仓|减仓|清仓|买入|卖出|满仓/);
  });

  it('未设 LUOOME_EXPOSE_EXTERNAL 时 brief run exit 1，且不建立行情上下文', async () => {
    delete process.env.LUOOME_EXPOSE_EXTERNAL;
    mocked.createCliContext.mockClear();
    const code = await runCli(['brief', 'run', '--scope', 'stock', '--stock', '002594.SZ']);
    expect(code).toBe(1);
    expect(mocked.createCliContext).not.toHaveBeenCalled();
    expect(logged.join('\n')).toContain('LUOOME_EXPOSE_EXTERNAL=true');
  });

  it('brief run 在开启外部能力后调用生成工具，--json 输出与 POST generate 同形', async () => {
    process.env.LUOOME_EXPOSE_EXTERNAL = 'true';
    const generateInputs: unknown[] = [];
    mocked.overrides.set('generate_stock_briefs', {
      execute: async (input: unknown) => {
        generateInputs.push(input);
        return {
          ok: true,
          data: {
            tradingDate: TRADING_DATE,
            phase: 'post-market',
            items: [{ stockId: '002594.SZ', action: 'budget-stopped', missing: [] }],
            summary: {
              llmHttpCalls: 16,
              tokens: 90_000,
              llmBriefs: 0,
              ruleOnlyBriefs: 1,
              unavailableBriefs: 0,
              skippedByDigest: 0,
              budgetStopped: 1,
              degraded: true,
            },
            coverage: { holdings: 1, watchlist: 0, signals: 0, candidates: 1 },
            budget: {
              date: TRADING_DATE,
              httpCalls: 16,
              tokens: 90_000,
              costUsd: 0,
              limit: { maxBriefs: 8, maxHttpCalls: 16, maxTokens: 90_000 },
            },
            degradation: {
              reason: 'rate_limited',
              message: '今日 AI 分析预算已用尽',
            },
          },
        };
      },
    });

    const code = await runCli([
      'brief',
      'run',
      '--scope',
      'stock',
      '--stock',
      '002594.SZ',
      '--json',
    ]);
    expect(code).toBe(0);
    expect(generateInputs[0]).toMatchObject({
      scope: 'stock',
      stockIds: ['002594.SZ'],
      source: 'cli',
    });
    const payload = jsonPayload();
    expect(payload.ok).toBe(true);
    const data = payload.data as {
      items: unknown[];
      budget: { httpCalls: number };
      degradation: { reason: string };
    };
    expect(data.items).toHaveLength(1);
    expect(data.budget.httpCalls).toBe(16);
    expect(data.degradation.reason).toBe('rate_limited');
  });
});
