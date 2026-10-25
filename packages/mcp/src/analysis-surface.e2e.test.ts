// @luoome/mcp —— DSH 交互分析面隔离端到端验收（bun:test，非 vitest）。
//
// 验收口径：docs/ddd/dsh-interactive-analysis-surface-and-worker-retirement.md §7.1、§7.2。
// 两层设计：
//   A. 真实 MCP stdio 协议：spawn 子进程 `bun --no-env-file packages/cli/src/index.ts mcp serve`，
//      NDJSON JSON-RPC 握手，验证各实例 discovery 与「按名字调用未暴露工具被拒绝」。
//   B. 同一临时 SQLite，进程内 buildContext + 固定交易日 10:00 Asia/Shanghai 的注入 clock，
//      走完 get_analysis_context → record_advice / record_analysis_result 的领域写回链路。
//
// 这样分层的原因：生产 MCP server 时钟不可注入，收盘后真实时钟下 record 必然 context_expired
// （设计文档 §8 已列为已知限制）；A 段不依赖写回窗口，B 段用注入 clock 验证领域校验与幂等。
//
// 边界：本文件只证明「DSH 协议与领域链路验收」，不验证、也不声称真实模型质量；
// 不联网、不读真实 ~/.luoome，所有账户/股票/行情均为合成数据，临时目录在 afterAll 清理。
//
// 运行：bun --no-env-file test packages/mcp/src/analysis-surface.e2e.test.ts

import { afterAll, beforeAll, describe, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FakeMarketAdapter } from '@luoome/adapters/testing';
import {
  AnalysisContextSchema,
  createDefaultAccount,
  type Logger,
  money,
  StockSchema,
  type ToolContext,
  type ToolError,
  type ToolResult,
} from '@luoome/core';
import { createDrizzleRepos } from '@luoome/db';
import {
  analysisHash,
  buildContext,
  getAnalysisContextTool,
  recordAdviceTool,
  recordAnalysisResultTool,
  toolRegistry,
} from '@luoome/tools';

import { BATCH_TOOL_NAMES } from '../../../deploy/dsh/batch-tools.js';
import { SETTINGS_TOOL_NAMES } from '../../../deploy/dsh/settings-tools.js';
import { asRecord, McpStdioClient, REPO_ROOT } from './testing/mcp-stdio-client.js';

/** 合成交易日 2026-10-22（周四）10:00 Asia/Shanghai；Quote.ts 与注入 clock 同值。 */
const FIXED_NOW = new Date('2026-10-22T02:00:00.000Z');
const STOCK_ID = '600519.SH';
const ANALYSIS_SURFACE_TOOL_NAMES = [
  'get_analysis_context',
  'record_advice',
  'record_analysis_result',
] as const;
/** §7.1 / §7.2-8：analysis 实例不得按名字调用的 worker 管理、报告、复盘工具。 */
const WORKER_AND_SETTINGS_TOOL_NAMES = [
  'claim_analysis_jobs',
  'complete_analysis_job',
  'fail_analysis_job',
  'get_analysis_metrics',
  'list_analysis_jobs',
  'get_analysis_job',
  'record_advice_outcome',
  'save_report',
  'save_decision_review',
] as const;
/** settings / batch 实例里不得出现的分析写回与队列管理工具。 */
const QUEUE_ANALYSIS_TOOL_NAMES = [
  'get_analysis_context',
  'record_advice',
  'record_analysis_result',
  'claim_analysis_jobs',
  'complete_analysis_job',
  'fail_analysis_job',
  'get_analysis_metrics',
  'list_analysis_jobs',
  'get_analysis_job',
  'record_advice_outcome',
  'save_report',
] as const;
/**
 * read 实例允许 get_analysis_context 与队列只读查询（list/get/metrics 的 sideEffect 是 read），
 * 但不得出现 record 写回与 claim/complete/fail/requeue/cancel 这类队列写操作。
 */
const READ_FORBIDDEN_TOOL_NAMES = [
  'record_advice',
  'record_analysis_result',
  'claim_analysis_jobs',
  'complete_analysis_job',
  'fail_analysis_job',
  'requeue_analysis_job',
  'cancel_analysis_job',
  'record_advice_outcome',
  'save_report',
] as const;
const EXPOSURE_KEYS = [
  'LUOOME_EXPOSE_WRITE',
  'LUOOME_EXPOSE_EXTERNAL',
  'LUOOME_EXPOSE_QUEUE',
  'LUOOME_EXPOSE_RESEARCH',
  'LUOOME_EXPOSE_TRADE',
  'LUOOME_EXPOSE_DENY',
] as const;

const noop = (): void => {};
const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

// ---------- 断言：失败信息直接对应 §7 条目编号 ----------

const fail = (item: string, detail: string): never => {
  throw new Error(`验收未通过 ${item}：${detail}`);
};

const assertItem = (item: string, condition: boolean, detail = ''): void => {
  if (!condition) fail(item, detail);
};

const unwrap = <T>(result: ToolResult<T>, item: string): T => {
  if (result.ok) return result.data;
  throw new Error(`验收未通过 ${item}：${JSON.stringify(result.error)}`);
};

const requireValue = <T>(value: T | null, item: string, detail: string): T => {
  if (value === null) throw new Error(`验收未通过 ${item}：${detail}`);
  return value;
};

const requireArray = (value: unknown, item: string, detail: string): unknown[] => {
  if (!Array.isArray(value)) throw new Error(`验收未通过 ${item}：${detail}`);
  return value;
};

/** ToolError.message 只存在于部分 kind；断言领域错误文本时统一取值。 */
const toolErrorMessage = (error: ToolError): string =>
  'message' in error ? error.message : error.kind;

const assertNamesEqual = (
  item: string,
  actual: readonly string[],
  expected: readonly string[],
): void => {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  assertItem(
    item,
    actualSorted.length === expectedSorted.length &&
      actualSorted.every((name, index) => name === expectedSorted[index]),
    `实际 [${actualSorted.join(', ')}]，预期 [${expectedSorted.join(', ')}]`,
  );
};

const assertNoQueueWriteback = (item: string, names: readonly string[]): void => {
  const forbidden = names.filter((name) =>
    (QUEUE_ANALYSIS_TOOL_NAMES as readonly string[]).includes(name),
  );
  assertItem(item, forbidden.length === 0, `出现禁止工具 [${forbidden.join(', ')}]`);
};

/** 合成行情与账户来自隔离临时库，不含任何真实个人数据。 */
const stockFixture = StockSchema.parse({
  id: STOCK_ID,
  code: '600519',
  exchange: 'SH',
  name: '隔离验收标的（合成数据）',
});

const adviceResult = () => ({
  decision: 'watch' as const,
  confidence: 50,
  horizon: 'short' as const,
  reasoning: {
    premise: '等待确认',
    evidence: ['已保存行情'],
    counterEvidence: ['缺少量能'],
  },
  risks: ['信息有限'],
});

const adviceProvenance = (evidenceFactIds: string[] = [`quote:${STOCK_ID}`]) => ({
  generatorKind: 'dsh-chat' as const,
  model: 'e2e:scripted-model',
  skillVersion: 'e2e',
  evidenceFactIds,
});

// ---------- 临时环境 ----------

const tempRoot = (): string => mkdtempSync(join(tmpdir(), 'luoome-analysis-surface-e2e-'));
let home = '';
let accountId = '';
let store: ReturnType<typeof createDrizzleRepos>;
let domain: ToolContext;

/**
 * 隔离子进程 env：剔除全部 LUOOME_*（不继承真实配置/个人库），只注入临时 LUOOME_HOME。
 * CLI 还会读取仓库根 .env 并只填「未设置」的键，所以这里把暴露开关显式置空，
 * 阻断本机 .env 反向抬高实例权限；具体实例再覆盖需要的开关。
 */
const isolatedEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('LUOOME_') || key === 'HOSTED_DATA_ROOT') continue;
    env[key] = value;
  }
  for (const key of EXPOSURE_KEYS) env[key] = '';
  env.LUOOME_HOME = home;
  // MCP 启动时必须显式配置行情 provider；这里只用它构造惰性 adapter，
  // 本验收的调用只读已保存的合成行情，不会触达任何外部数据源。
  env.LUOOME_MARKET_PROVIDER = 'real';
  return env;
};

const analysisEnv = (): Record<string, string> => ({
  ...isolatedEnv(),
  LUOOME_MCP_SERVER_NAME: 'luoome-analysis',
  LUOOME_EXPOSE_QUEUE: 'true',
  LUOOME_EXPOSE_TOOLS: ANALYSIS_SURFACE_TOOL_NAMES.join(','),
});

const readEnv = (): Record<string, string> => isolatedEnv();

const settingsEnv = (): Record<string, string> => ({
  ...isolatedEnv(),
  LUOOME_MCP_SERVER_NAME: 'luoome-settings',
  LUOOME_EXPOSE_WRITE: 'true',
  // 与 deploy/dsh/standalone-profile 的设置面一致：研究结构写工具在其白名单内。
  LUOOME_EXPOSE_RESEARCH: 'true',
  LUOOME_EXPOSE_TOOLS: SETTINGS_TOOL_NAMES.join(','),
});

const batchEnv = (): Record<string, string> => ({
  ...isolatedEnv(),
  LUOOME_MCP_SERVER_NAME: 'luoome-batch',
  LUOOME_EXPOSE_WRITE: 'true',
  LUOOME_EXPOSE_EXTERNAL: 'true',
  LUOOME_EXPOSE_TOOLS: BATCH_TOOL_NAMES.join(','),
});

const withClient = async <T>(
  env: Record<string, string>,
  body: (client: McpStdioClient, init: Record<string, unknown>) => Promise<T>,
): Promise<T> => {
  const client = McpStdioClient.spawn(env);
  try {
    const init = await client.initialize();
    return await body(client, init);
  } finally {
    await client.close();
  }
};

beforeAll(async () => {
  home = tempRoot();
  store = createDrizzleRepos(join(home, 'luoome.db'));
  const account = createDefaultAccount(FIXED_NOW);
  accountId = account.id;
  await store.repos.account.save(account);
  await store.repos.stock.save({
    id: stockFixture.id,
    code: stockFixture.code,
    exchange: stockFixture.exchange,
    name: stockFixture.name,
    ...(stockFixture.industry === undefined ? {} : { industry: stockFixture.industry }),
  });
  await store.repos.quote.save({
    stockId: STOCK_ID,
    ts: FIXED_NOW,
    observedAt: FIXED_NOW,
    fetchedAt: FIXED_NOW,
    timestampSource: 'upstream',
    open: money(100),
    high: money(101),
    low: money(99),
    close: money(100),
    volume: 1000,
    source: 'isolated-e2e-fixture',
  });
  domain = buildContext({
    repos: store.repos,
    adapters: { market: new FakeMarketAdapter({ clock: () => FIXED_NOW }) },
    user: { id: 'e2e-user', defaultAccountId: account.id },
    clock: () => FIXED_NOW,
    logger: silentLogger,
  });
});

afterAll(() => {
  try {
    store?.close();
  } finally {
    if (home !== '') rmSync(home, { recursive: true, force: true });
  }
});

describe('DSH 交互分析面隔离验收（§7.1 协议 + §7.2 领域链路）', () => {
  it('A1 · analysis 只暴露三工具并持久化 context，read 实例可按 id 读回但不能 record（§7.2-1/2）', async () => {
    let contextId = '';
    let contextHash = '';

    await withClient(analysisEnv(), async (client, init) => {
      const serverInfo = asRecord(init.serverInfo);
      assertItem(
        '§7.1 analysis 实例 server name 必须显式写死为 luoome-analysis',
        serverInfo.name === 'luoome-analysis',
        String(serverInfo.name),
      );
      const names = await client.listTools();
      assertNamesEqual(
        '§7.1 analysis discovery 恰好为 get_analysis_context/record_advice/record_analysis_result',
        names,
        ANALYSIS_SURFACE_TOOL_NAMES,
      );

      const created = asRecord(
        await client.callToolOk('get_analysis_context', {
          kind: 'advice_stock',
          subject: { kind: 'stock', id: STOCK_ID },
        }),
      );
      contextId = String(created.id);
      contextHash = String(created.contextHash);
      assertItem(
        '§7.2-2 analysis 实例创建 context 并写入临时库',
        created.kind === 'advice_stock' &&
          created.accountId === accountId &&
          (created.factIds as unknown[]).includes(`quote:${STOCK_ID}`),
        JSON.stringify(created),
      );
      const dataAsOfValue = created.dataAsOf;
      const dataAsOfMs =
        dataAsOfValue instanceof Date
          ? dataAsOfValue.getTime()
          : new Date(String(dataAsOfValue)).getTime();
      assertItem(
        '§7.2-2 context 使用已保存的合成行情作为 dataAsOf',
        dataAsOfMs === FIXED_NOW.getTime(),
        JSON.stringify(created.dataAsOf),
      );
    });

    const persisted = requireValue(
      await store.repos.analysis.findContext(accountId, contextId),
      '§7.2-2 context 必须在 analysis 子进程退出后仍持久化',
      contextId,
    );
    assertItem(
      '§7.2-2 持久化 context 的 contextHash 与协议返回一致',
      persisted.contextHash === contextHash,
      `${persisted.contextHash} != ${contextHash}`,
    );

    await withClient(readEnv(), async (client, init) => {
      const serverInfo = asRecord(init.serverInfo);
      assertItem(
        '§7.1 read 实例 server name 为 luoome',
        serverInfo.name === 'luoome',
        String(serverInfo.name),
      );
      const names = await client.listTools();
      assertItem('§7.2-1 read 实例 discovery 含 get_advice', names.includes('get_advice'));
      const leaked = names.filter((name) =>
        (READ_FORBIDDEN_TOOL_NAMES as readonly string[]).includes(name),
      );
      assertItem(
        '§7.1 read discovery 不含 record 写回与队列管理工具',
        leaked.length === 0,
        leaked.join(', '),
      );
      const readBack = asRecord(await client.callToolOk('get_analysis_context', { contextId }));
      assertItem(
        '§7.1 read 实例按 contextId 读回 analysis 实例写入的同一 context',
        readBack.id === contextId && readBack.contextHash === contextHash,
        JSON.stringify(readBack),
      );
      const rejected = await client.callToolRejected('record_advice', {
        contextId,
        result: adviceResult(),
        provenance: adviceProvenance(),
      });
      assertItem(
        '§7.2-1 read 按名字调用 record_advice 被 JSON-RPC error 拒绝',
        rejected.includes('not found or not exposed'),
        rejected,
      );
    });
  }, 90_000);

  it('A2 · analysis 按名字调用 worker 管理/报告/复盘工具全部被拒绝，且不含 batch/settings/trade 面（§7.2-8）', async () => {
    await withClient(analysisEnv(), async (client) => {
      const names = await client.listTools();
      for (const name of WORKER_AND_SETTINGS_TOOL_NAMES) {
        const rejected = await client.callToolRejected(name, {});
        assertItem(
          `§7.2-8 analysis 不得调用 ${name}`,
          rejected.includes('not found or not exposed'),
          rejected,
        );
      }
      for (const name of BATCH_TOOL_NAMES) {
        assertItem(`§7.2-8 analysis discovery 不含批处理工具 ${name}`, !names.includes(name));
      }
      for (const name of SETTINGS_TOOL_NAMES) {
        assertItem(`§7.2-8 analysis discovery 不含设置面工具 ${name}`, !names.includes(name));
      }
      const tradeToolNames = toolRegistry
        .all()
        .filter((tool) => tool.sideEffect === 'trade')
        .map((tool) => tool.name);
      assertItem(
        '§7.2-8 领域 registry 确有 trade 工具，作为排除断言的前提',
        tradeToolNames.length > 0,
      );
      for (const name of tradeToolNames) {
        assertItem(`§7.2-8 analysis discovery 不含 trade 工具 ${name}`, !names.includes(name));
      }
    });
  }, 90_000);

  it('A3 · settings/batch 实例 discovery 收窄到各自白名单，不含分析写回与队列管理（§7.1）', async () => {
    await withClient({ ...batchEnv(), LUOOME_EXPOSE_EXTERNAL: '' }, async (client) => {
      assertNamesEqual('§7.1 batch 只有 write 时不暴露组合能力工具', await client.listTools(), []);
    });
    await withClient(settingsEnv(), async (client, init) => {
      const serverInfo = asRecord(init.serverInfo);
      assertItem(
        '§7.1 settings 实例 server name 为 luoome-settings',
        serverInfo.name === 'luoome-settings',
        String(serverInfo.name),
      );
      const names = await client.listTools();
      assertNamesEqual(
        '§7.1 settings discovery 等于 deploy/dsh/settings-tools.ts 白名单',
        names,
        SETTINGS_TOOL_NAMES,
      );
      assertNoQueueWriteback('§7.1 settings discovery 不含分析写回/队列管理工具', names);
    });

    await withClient(batchEnv(), async (client, init) => {
      const serverInfo = asRecord(init.serverInfo);
      assertItem(
        '§7.1 batch 实例 server name 为 luoome-batch',
        serverInfo.name === 'luoome-batch',
        String(serverInfo.name),
      );
      const names = await client.listTools();
      assertNamesEqual('§7.1 batch discovery 恰好为五个 run_* 批处理入口', names, BATCH_TOOL_NAMES);
      for (const name of names) {
        assertItem(`§7.1 batch 面只含 run_* 工具（实际 ${name}）`, name.startsWith('run_'));
      }
      assertNoQueueWriteback('§7.1 batch discovery 不含分析写回/队列管理工具', names);
    });
  }, 90_000);

  it('A4 · LUOOME_EXPOSE_TRADE=true 在业务 IO 前非零退出（§7.1）', async () => {
    const tradeHome = join(home, 'trade-home');
    mkdirSync(tradeHome, { recursive: true });
    const proc = Bun.spawn(
      [process.execPath, '--no-env-file', 'packages/cli/src/index.ts', 'mcp', 'serve'],
      {
        cwd: REPO_ROOT,
        env: { ...isolatedEnv(), LUOOME_HOME: tradeHome, LUOOME_EXPOSE_TRADE: 'true' },
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    assertItem(
      '§7.1 LUOOME_EXPOSE_TRADE=true 必须启动失败（退出码非零）',
      exitCode !== 0,
      `exit=${exitCode}`,
    );
    assertItem(
      '§7.1 trade 硬卡的 stderr 说明包含 LUOOME_EXPOSE_TRADE',
      stderr.includes('LUOOME_EXPOSE_TRADE'),
      stderr,
    );
    assertItem(
      '§7.1 trade 硬卡发生在任何业务 IO 之前（未创建事实库文件）',
      readdirSync(tradeHome).length === 0,
      readdirSync(tradeHome).join(', '),
    );
  }, 90_000);

  it('B1 · context → record_advice：写回、证据校验、幂等与 read 实例读取同一 Advice（§7.2-3/4/5/6）', async () => {
    const snapshot = await getAnalysisContextTool.execute(
      { kind: 'advice_stock', subject: { kind: 'stock', id: STOCK_ID } },
      domain,
    );
    const context = unwrap(snapshot, '§7.2-2 领域链路无法创建事实包');
    assertItem(
      '§7.2-2 领域链路 context 的 dataAsOf 与注入 clock/合成 quote 一致',
      context.dataAsOf.getTime() === FIXED_NOW.getTime(),
      context.dataAsOf.toISOString(),
    );
    assertItem(
      '§7.2-2 领域链路 context 已持久化到同一临时 SQLite',
      (await store.repos.analysis.findContext(accountId, context.id)) !== null,
    );

    const unknownFact = await recordAdviceTool.execute(
      {
        contextId: context.id,
        result: adviceResult(),
        provenance: adviceProvenance(['invented:not-in-context']),
      },
      domain,
    );
    assertItem(
      '§7.2-5 未出现在事实包中的 evidenceFactIds 被拒绝（unknown_fact_reference）',
      !unknownFact.ok && toolErrorMessage(unknownFact.error) === 'unknown_fact_reference',
      JSON.stringify(unknownFact),
    );

    const input = {
      contextId: context.id,
      result: adviceResult(),
      provenance: adviceProvenance(),
      requestId: 'e2e-advice-request',
    };
    const recorded = unwrap(
      await recordAdviceTool.execute(input, domain),
      '§7.2-3 record_advice 写回失败',
    );
    assertItem(
      '§7.2-3 写回 Advice 带标准免责声明与 dataAsOf',
      recorded.disclaimers.length === 3 &&
        recorded.basedOn.dataAsOf.getTime() === FIXED_NOW.getTime(),
      JSON.stringify(recorded),
    );
    assertItem(
      '§7.2-4 Advice.provenance.contextId 指向本次事实包',
      recorded.provenance?.contextId === context.id,
      JSON.stringify(recorded.provenance),
    );

    const replayed = unwrap(
      await recordAdviceTool.execute(input, domain),
      '§7.2-6 相同结果重放必须成功',
    );
    assertItem(
      '§7.2-6 相同 result/provenance 重放返回同一 Advice',
      replayed.id === recorded.id,
      `${replayed.id} != ${recorded.id}`,
    );
    const rows = await store.repos.advice.query({
      subjectKind: 'stock',
      subjectId: STOCK_ID,
      includeExpired: true,
    });
    assertItem(
      '§7.2-6 重放不重复写库（库中仅一条 Advice）',
      rows.length === 1,
      `count=${rows.length}`,
    );

    const conflicting = await recordAdviceTool.execute(
      { ...input, result: { ...adviceResult(), decision: 'avoid' as const } },
      domain,
    );
    assertItem(
      '§7.2-6 不同结果复用同一 context 被 duplicate_result 拒绝，不能冒充满幂等',
      !conflicting.ok && toolErrorMessage(conflicting.error) === 'duplicate_result',
      JSON.stringify(conflicting),
    );

    await withClient(readEnv(), async (client) => {
      const output = asRecord(
        await client.callToolOk('get_advice', {
          subjectKind: 'stock',
          subjectId: STOCK_ID,
          includeExpired: true,
        }),
      );
      const advices = requireArray(
        output.advices,
        '§7.2-4 read 实例 get_advice 输出缺少 advices 数组',
        JSON.stringify(output),
      );
      const matched = advices.map((item) => asRecord(item)).find((item) => item.id === recorded.id);
      const record = requireValue(
        matched ?? null,
        '§7.2-4 read 实例 get_advice 应读取同一 Advice',
        JSON.stringify(output),
      );
      const provenance = asRecord(record.provenance);
      assertItem(
        '§7.2-4 read 实例读到的 provenance.contextId 指向同一 context',
        provenance.contextId === context.id,
        JSON.stringify(provenance),
      );
    });
  }, 90_000);

  it('B2 · record_analysis_result 完成一条研究方向 publication（写回/重放/冲突）（§7.2-7）', async () => {
    // research_directions 的写回窗口要求 dataAsOf 接近 now；仓库查询路径不产生
    // 可验证时点，因此这里按设计文档的验收方式直接用 repo 构造合法 context。
    const researchContext = AnalysisContextSchema.parse({
      id: randomUUID(),
      jobId: null,
      kind: 'research_directions',
      accountId,
      subject: { kind: 'research', id: 'e2e-research-directions' },
      dataAsOf: FIXED_NOW,
      facts: [],
      factIds: [],
      limitations: ['合成验收：不读取真实研究资料，仅验证写回链路。'],
      contextHash: analysisHash({ facts: [], dataAsOf: FIXED_NOW }),
      writeUntil: new Date(FIXED_NOW.getTime() + 30 * 60000),
      expiresAt: new Date(FIXED_NOW.getTime() + 180 * 86_400_000),
      createdAt: FIXED_NOW,
    });
    await store.repos.analysis.saveContext(researchContext);

    const researchInput = {
      contextId: researchContext.id,
      result: {
        kind: 'research_directions' as const,
        question: '合成验收：研究方向写回链路是否可用？',
        directions: [],
        limitations: ['合成验收数据，不含外部研究或真实模型结论。'],
      },
      provenance: adviceProvenance([]),
      requestId: 'e2e-research-request',
    };
    const published = unwrap(
      await recordAnalysisResultTool.execute(researchInput, domain),
      '§7.2-7 record_analysis_result 写回失败',
    );
    assertItem(
      '§7.2-7 首次写回返回 ok 且 replayed=false',
      published.replayed === false,
      JSON.stringify(published),
    );
    const researchId = `analysis:${researchContext.id}`;
    assertItem(
      '§7.2-7 resultRef 指向 research id',
      published.resultRef === researchId,
      `${published.resultRef} != ${researchId}`,
    );
    const research = requireValue(
      await store.repos.investmentWorkspace.findResearch({
        ownerUserId: domain.user.id,
        accountId,
        id: researchId,
      }),
      '§7.2-7 investmentWorkspace 必须能查到写回的研究方向',
      researchId,
    );
    assertItem(
      '§7.2-7 research 保留问题、限制与 provenance.contextId',
      research.question === researchInput.result.question &&
        research.limitations.length >= 1 &&
        research.provenance?.contextId === researchContext.id,
      JSON.stringify(research),
    );

    const replayed = unwrap(
      await recordAnalysisResultTool.execute(researchInput, domain),
      '§7.2-7 同一结果重放必须成功',
    );
    assertItem(
      '§7.2-7 相同结果重放返回 replayed=true',
      replayed.replayed === true,
      JSON.stringify(replayed),
    );

    const conflicting = await recordAnalysisResultTool.execute(
      {
        ...researchInput,
        result: {
          ...researchInput.result,
          question: '合成验收：不同的研究方向结果。',
        },
      },
      domain,
    );
    assertItem(
      '§7.2-7 不同结果复用同一 context 被 duplicate_result 拒绝',
      !conflicting.ok && toolErrorMessage(conflicting.error) === 'duplicate_result',
      JSON.stringify(conflicting),
    );
  }, 90_000);

  it('A5 · 默认部署最终态只读检查：技能不再引用 worker、compose 无 dsh-worker（§7.2-9/10 部分）', () => {
    const skill = readFileSync(join(REPO_ROOT, '.dsh/skills/stock-deep-dive/SKILL.md'), 'utf8');
    assertItem(
      '§7.2-9 stock-deep-dive 不再引用 luoome-worker 命名空间',
      !skill.includes('luoome-worker'),
    );
    assertItem(
      '§7.2-9 stock-deep-dive 使用 luoome-analysis 的 get_analysis_context',
      skill.includes('mcp__luoome-analysis__get_analysis_context'),
    );

    const compose = readFileSync(join(REPO_ROOT, 'deploy/dsh/compose.yaml'), 'utf8');
    assertItem('§7.2-10 默认 compose 没有 dsh-worker 服务', !/^\s{2}dsh-worker:/m.test(compose));
    assertItem('§7.2-10 默认 compose 没有 DSH_WORKER 轮询环境项', !compose.includes('DSH_WORKER_'));
  });
});
