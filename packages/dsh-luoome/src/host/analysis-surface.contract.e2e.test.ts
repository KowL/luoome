// dsh-luoome —— DSH 交互分析面写回契约验收（Node/Vitest，非 bun:test）。
//
// 迁移自旧 stdio MCP 分析面 e2e（REQ-M2-03 / T13）：MCP 用户入口删除后，这组契约仍然
// 成立，只是载体从「spawn 两个 MCP 实例」换成插件的真实
// 装配——`createAnalysisOperationPolicies()` 给出的写回入口、read surface 给出的只读面，
// 以及 `createPluginOperationService()` 的 prepare / confirm / reconcile。
//
// 验收口径不变：docs/ddd/dsh-interactive-analysis-surface-and-worker-retirement.md
// §7.1（面隔离）与 §7.2（领域写回链路）。用例编号 A1–A4 / B1–B2 / A5 与原文件一一对应，
// 便于逐条对照设计文档。
//
// 分层理由（与原文件相同）：A 段只证明暴露面与启动硬卡，不依赖写回窗口；B 段用注入 clock
// 与合成事实验证领域校验、幂等与重放。所有账户/股票/行情均为合成数据，不联网、不读真实
// `~/.luoome`；A4 的临时目录在用例内清理。

import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BATCH_TOOL_NAMES, batchTools } from '@luoome/batch';
import { AnalysisContextSchema, money, type ToolError, type ToolResult } from '@luoome/core';
import {
  analysisHash,
  createPluginOperationService,
  type PluginPrincipal,
  toolRegistry,
} from '@luoome/tools';
import { buildTestContext } from '@luoome/tools/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAnalysisOperationPolicies,
  createRecordAnalysisResultOperation,
  type TrustedAnalysisProvenance,
} from './analysis-operations.js';
import {
  createProductionHost,
  createProductionOperationPolicies,
  TRUSTED_ANALYSIS_PROVENANCE,
} from './production.js';
import { DEFAULT_READ_TOOL_ALLOWLIST } from './production-config.js';
import { createReadSurface } from './read-surface.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** `packages/dsh-luoome/src/host` → 仓库根。 */
const REPO_ROOT = resolve(HERE, '../../../..');

/** 合成交易日 2026-10-22（周四）10:00 Asia/Shanghai；quote 与注入 clock 同值。 */
const FIXED_NOW = new Date('2026-10-22T02:00:00.000Z');
const STOCK_ID = '600519.SH';
const TRUSTED: TrustedAnalysisProvenance = {
  generatorKind: 'dsh-chat',
  model: 'contract:scripted-model',
};

/** §7.1 / §7.2-8：analysis 面恰好四工具，其中三条是写回 policy，一条是只读事实装配。 */
const ANALYSIS_SURFACE_TOOL_NAMES = [
  'get_analysis_context',
  'record_advice',
  'record_analysis_result',
  'record_triangle_review',
] as const;
/** 分析面的写回入口：只有这三条 policy，读面不持有它们。 */
const ANALYSIS_WRITEBACK_TOOL_NAMES = [
  'record_advice',
  'record_analysis_result',
  'record_triangle_review',
] as const;
/**
 * operation 内核自带的宿主工具（自动化授权）。它由 `createPluginOperationService` 注册在
 * 每个面上，不是分析面写入入口，判定分析面名单时按名字排除。
 */
const HOST_OPERATION_TOOL_NAMES = ['configure_plugin_automation'] as const;
/** 面 = descriptors 减去宿主自带工具。 */
const faceNames = (descriptors: readonly { readonly name: string }[]): readonly string[] =>
  descriptors
    .map((descriptor) => descriptor.name)
    .filter((name) => !(HOST_OPERATION_TOOL_NAMES as readonly string[]).includes(name));
/** §7.1 / §7.2-8：analysis 面不得按名字调用的 worker 管理、报告、复盘工具。 */
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
/** settings / batch 面里不得出现的分析写回与队列管理工具。 */
const QUEUE_ANALYSIS_TOOL_NAMES = [
  'get_analysis_context',
  'record_advice',
  'record_analysis_result',
  'record_triangle_review',
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
 * 设置面白名单。原 `deploy/dsh/settings-tools.ts` 随旧 MCP 过渡面删除（REQ-M2-02），
 * 名单本身仍是「设置面不含分析队列写回」的事实来源，故作为本契约的 fixture 保留：
 * 只放配置类写工具，不含 analysis 队列写回、delete_*、chat_* 与 external，trade 永不暴露。
 */
const SETTINGS_TOOL_NAMES = [
  // 账户与持仓
  'create_account',
  'update_account',
  'add_holding',
  'update_holding',
  'close_holding',
  'add_trade',
  'create_portfolio_cash_flow',
  'create_portfolio_corporate_action',
  // 自选与盯盘告警
  'create_watchlist',
  'update_watchlist',
  'archive_watchlist',
  'add_watchlist_member',
  'add_watchlist_members',
  'update_watchlist_member',
  'archive_watchlist_member',
  'create_alert_plan',
  'update_alert_plan',
  'delete_alert_plan',
  'set_watch_trigger_feedback',
  // 策略配置（不含运行与评估）
  'create_strategy',
  'create_strategy_version',
  'validate_strategy_version',
  'publish_strategy_version',
  'archive_strategy',
  'pause_strategy',
  'resume_strategy',
  'set_strategy_schedule',
  'renew_strategy_schedule_claim',
  'subscribe_strategy_to_watchlist',
  'unsubscribe_strategy_from_watchlist',
  // 研究结构（正文与索引同步）
  'create_research_topic',
  'archive_research_topic',
  'create_research_document',
  'create_research_hypothesis_version',
  'link_research_document',
  'import_local_research_document',
  'sync_research_vault',
  // 决策与跟踪
  'save_decision_review',
  'save_investment_consensus',
  'set_investment_tracking',
  'save_trading_plan',
  // 手工公司事件
  'add_stock_event',
  'update_stock_event',
] as const;
/**
 * read 面允许 `get_analysis_context`（只读装配 + 审计快照），但不得出现 record 写回与
 * claim/complete/fail/requeue/cancel 这类队列写操作。
 */
const READ_FORBIDDEN_TOOL_NAMES = [
  'record_advice',
  'record_analysis_result',
  'record_triangle_review',
  'claim_analysis_jobs',
  'complete_analysis_job',
  'fail_analysis_job',
  'requeue_analysis_job',
  'cancel_analysis_job',
  'record_advice_outcome',
  'save_report',
] as const;

const signal = (): AbortSignal => new AbortController().signal;

// ---------- 断言助手：失败信息直接对应 §7 条目编号 ----------

const asRecord = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`期望对象，实际 ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
};

const unwrap = <T>(result: ToolResult<T>, item: string): T => {
  if (result.ok) return result.data;
  throw new Error(`验收未通过 ${item}：${JSON.stringify(result.error)}`);
};

/** ToolError.message 只存在于部分 kind；断言领域错误文本时统一取值。 */
const toolErrorMessage = (error: ToolError): string =>
  'message' in error ? error.message : error.kind;

const sorted = (names: readonly string[]): readonly string[] => [...names].sort();

const assertNamesEqual = (
  item: string,
  actual: readonly string[],
  expected: readonly string[],
): void => {
  const actualSorted = sorted(actual);
  const expectedSorted = sorted(expected);
  expect(actualSorted, `${item}：实际 [${actualSorted.join(', ')}]`).toEqual(expectedSorted);
};

/** confirm 必须带业务回执；缺失即验收失败（不把「没有回执」当成成功）。 */
const requireResult = (
  result: ToolResult<unknown> | undefined,
  item: string,
): ToolResult<unknown> => {
  if (result === undefined) throw new Error(`验收未通过 ${item}：缺少业务回执`);
  return result;
};

/** confirm 的返回值（JSON 回执）：state + 业务 ToolResult。 */
type ConfirmReceipt = {
  readonly state: string;
  readonly result?: ToolResult<unknown>;
};

// ---------- 合成事实 ----------

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

/** 客户端自报的 provenance；generatorKind 等由受信任装配覆盖，不参与事实。 */
const adviceProvenance = (evidenceFactIds: string[] = [`quote:${STOCK_ID}`]) => ({
  generatorKind: 'legacy-ai' as const,
  model: 'client-model',
  skillVersion: 'client-skill',
  evidenceFactIds,
});

/**
 * 每个用例独立的进程内事实库 + 插件装配。
 *
 * 与原 e2e 的差异只在存储：当时用临时 SQLite 证明「子进程退出后仍持久化」，这里用同一
 * `ToolContext` 上的多个独立 surface/service 证明「装配边界不是内存边界」——读回走的是
 * `repos.analysis.findContext`，与插件生产路径同一条查询。
 */
const setup = async () => {
  const ctx = await buildTestContext({ clock: () => FIXED_NOW });
  await ctx.repos.quote.save({
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
    source: 'isolated-contract-fixture',
  });
  const accountId = ctx.user.defaultAccountId;
  const principal: PluginPrincipal = { userId: ctx.user.id, accountId };
  const analysisService = () =>
    createPluginOperationService({
      repository: ctx.repos.pluginAuthority,
      policies: createAnalysisOperationPolicies(TRUSTED),
      // 生产装配同一组能力：record_* 需要 queue，读/外部能力不借给通用入口。
      capabilities: ['read', 'write', 'external', 'queue'],
      policyVersion: 1,
      now: () => FIXED_NOW.getTime(),
      context: () => ctx,
    });
  const readSurface = () =>
    createReadSurface({
      accountId,
      config: { allowlist: [...DEFAULT_READ_TOOL_ALLOWLIST] },
      tools: toolRegistry.all(),
      context: () => ctx,
    });
  return { ctx, accountId, principal, analysisService, readSurface };
};

type AnalysisService = ReturnType<typeof createPluginOperationService>;

/** prepare 一次冻结写入，返回 host 生成的 operationId / 凭据 / 冻结输入。 */
const prepareOnce = async (
  service: AnalysisService,
  principal: PluginPrincipal,
  tool: string,
  input: unknown,
): Promise<{ operationId: string; token: string; input: Record<string, unknown> }> => {
  const operationId = randomUUID();
  const prepared = asRecord(
    unwrap(
      await service.prepare(principal, { id: operationId, tool, input }),
      `prepare ${tool} 失败`,
    ),
  );
  return {
    operationId,
    token: String(prepared.confirmationToken),
    input: asRecord(prepared.input),
  };
};

const confirmOnce = async (
  service: AnalysisService,
  principal: PluginPrincipal,
  operation: { readonly operationId: string; readonly token: string },
  item: string,
): Promise<ConfirmReceipt> =>
  unwrap(
    await service.confirm(
      principal,
      { id: operation.operationId, token: operation.token },
      signal(),
    ),
    item,
  ) as unknown as ConfirmReceipt;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DSH 交互分析面写回契约（§7.1 面隔离 + §7.2 领域链路）', () => {
  it('A1 · analysis 面恰好四工具：三条写回 policy + 一条只读事实装配，read 面可读回但不能 record（§7.2-1/2）', async () => {
    const { ctx, accountId, analysisService, readSurface } = await setup();
    const writebackNames = faceNames(analysisService().descriptors());

    assertNamesEqual(
      '§7.1 analysis 写回入口恰好是 record_advice/record_analysis_result/record_triangle_review',
      writebackNames,
      ANALYSIS_WRITEBACK_TOOL_NAMES,
    );
    // 写回 policy 都是 queue 能力、非定时：不构成「自动写回」入口。
    for (const policy of createAnalysisOperationPolicies(TRUSTED)) {
      expect(policy.scheduled, policy.tool.name).toBe(false);
      expect(policy.tool.requiredCapabilities, policy.tool.name).toEqual(['queue']);
    }

    const read = readSurface();
    const readNames = read.descriptors().map((descriptor) => descriptor.name);
    // analysis 面四工具 = 三条写回 policy ∪ 读面上的 get_analysis_context。
    assertNamesEqual(
      '§7.1 analysis 面合计恰好四工具',
      [...writebackNames, ...readNames.filter((name) => name === 'get_analysis_context')],
      ANALYSIS_SURFACE_TOOL_NAMES,
    );
    expect(readNames).toContain('get_advice');
    for (const forbidden of READ_FORBIDDEN_TOOL_NAMES)
      expect(readNames, `§7.1 read 面不得出现 ${forbidden}`).not.toContain(forbidden);

    // 只读面按名字调 record_advice 必须被拒绝（原 A1 的「未暴露工具」语义）。
    expect(
      await read.invoke(
        'record_advice',
        { contextId: 'ctx-any', result: adviceResult(), provenance: adviceProvenance() },
        signal(),
      ),
    ).toMatchObject({ ok: false, error: { kind: 'permission_denied' } });

    const created = asRecord(
      unwrap(
        await read.invoke(
          'get_analysis_context',
          { kind: 'advice_stock', subject: { kind: 'stock', id: STOCK_ID } },
          signal(),
        ),
        '§7.2-2 analysis 面无法装配事实包',
      ),
    );
    const contextId = String(created.id);
    const contextHash = String(created.contextHash);
    expect(created.kind, JSON.stringify(created)).toBe('advice_stock');
    expect(created.accountId).toBe(accountId);
    expect(created.factIds as string[]).toContain(`quote:${STOCK_ID}`);
    expect(new Date(String(created.dataAsOf)).getTime()).toBe(FIXED_NOW.getTime());

    // 落库：与插件生产路径同一条 repo 查询。
    const persisted = await ctx.repos.analysis.findContext(accountId, contextId);
    expect(persisted, `§7.2-2 context ${contextId} 必须已持久化`).not.toBeNull();
    expect(persisted?.contextHash).toBe(contextHash);

    // 另一个 read surface 实例按 id 读回同一 context。
    const readBack = asRecord(
      unwrap(
        await readSurface().invoke('get_analysis_context', { contextId }, signal()),
        '§7.1 read 面按 contextId 读回失败',
      ),
    );
    expect(readBack.id).toBe(contextId);
    expect(readBack.contextHash).toBe(contextHash);
  });

  it('A2 · analysis 面按名字调用 worker 管理/报告/复盘工具全部被拒绝，且不含 batch/settings/trade 面（§7.2-8）', async () => {
    const { principal, analysisService, readSurface } = await setup();
    const service = analysisService();
    const descriptorNames = faceNames(service.descriptors());
    const read = readSurface();
    const readNames = read.descriptors().map((descriptor) => descriptor.name);

    for (const name of WORKER_AND_SETTINGS_TOOL_NAMES) {
      const rejected = await service.prepare(principal, {
        id: randomUUID(),
        tool: name,
        input: {},
      });
      expect(rejected.ok, `§7.2-8 analysis 不得通过 operation 调用 ${name}`).toBe(false);
      expect(descriptorNames, `§7.2-8 analysis 面不得声明 ${name}`).not.toContain(name);
    }
    // worker 队列管理工具仍在 registry 里（供内部 job 流程使用），但读面不可达。
    for (const name of ['claim_analysis_jobs', 'complete_analysis_job', 'fail_analysis_job']) {
      expect(await read.invoke(name, {}, signal())).toMatchObject({
        ok: false,
        error: { kind: 'permission_denied' },
      });
    }

    for (const name of BATCH_TOOL_NAMES) {
      expect(descriptorNames, `§7.2-8 analysis 面不含批处理工具 ${name}`).not.toContain(name);
      expect(readNames, `§7.2-8 read 面不含批处理工具 ${name}`).not.toContain(name);
    }
    for (const name of SETTINGS_TOOL_NAMES) {
      expect(descriptorNames, `§7.2-8 analysis 面不含设置面工具 ${name}`).not.toContain(name);
    }

    const tradeToolNames = toolRegistry
      .all()
      .filter((tool) => tool.sideEffect === 'trade')
      .map((tool) => tool.name);
    expect(tradeToolNames.length, '§7.2-8 前提：registry 里确有 trade 工具').toBeGreaterThan(0);
    for (const name of tradeToolNames) {
      expect(descriptorNames, `§7.2-8 analysis 面不含 trade 工具 ${name}`).not.toContain(name);
      expect(readNames, `§7.2-8 read 面不含 trade 工具 ${name}`).not.toContain(name);
    }

    // 设置面白名单与「分析写回/队列管理」不相交：两套面不会被同一个名字同时授权。
    for (const name of QUEUE_ANALYSIS_TOOL_NAMES)
      expect(SETTINGS_TOOL_NAMES as readonly string[], `设置面白名单误含 ${name}`).not.toContain(
        name,
      );
  });

  it('A3 · 设置/批处理面收窄：默认装配零 run_*，batchEnabled 才挂五个写入口且不含分析写回（§7.1）', async () => {
    const { readSurface } = await setup();
    const defaults = createProductionOperationPolicies().map((policy) => policy.tool.name);

    for (const name of BATCH_TOOL_NAMES)
      expect(defaults, `§7.1 默认装配不得包含批处理入口 ${name}`).not.toContain(name);
    for (const name of ANALYSIS_WRITEBACK_TOOL_NAMES) expect(defaults).toContain(name);
    // 精确 policy：worker 队列管理与通用设置面都不在个人版默认装配里。
    for (const name of [
      'claim_analysis_jobs',
      'complete_analysis_job',
      'fail_analysis_job',
      'get_analysis_metrics',
      'list_analysis_jobs',
      'get_analysis_job',
      'save_report',
    ] as const)
      expect(defaults, `§7.1 默认装配不得包含 ${name}`).not.toContain(name);

    const batchPolicies = createProductionOperationPolicies(TRUSTED_ANALYSIS_PROVENANCE, {
      batchEnabled: true,
    }).filter((policy) => (BATCH_TOOL_NAMES as readonly string[]).includes(policy.tool.name));
    assertNamesEqual(
      '§7.1 batchEnabled 恰好追加五个 run_* 批处理入口',
      batchPolicies.map((policy) => policy.tool.name),
      BATCH_TOOL_NAMES,
    );
    for (const policy of batchPolicies) {
      expect(policy.tool.sideEffect, policy.tool.name).toBe('write');
      expect(policy.scheduled, policy.tool.name).toBe(true);
    }
    // REQ-M2-01 名单契约（原 `deploy/dsh/batch-tools.test.ts`）：名单 ↔ 真实 batchTools。
    assertNamesEqual(
      'BATCH_TOOL_NAMES 与 @luoome/batch 注册的批处理工具完全一致',
      batchTools.map((tool) => tool.name),
      BATCH_TOOL_NAMES,
    );
    expect(batchTools).toHaveLength(5);
    expect(new Set(BATCH_TOOL_NAMES).size).toBe(BATCH_TOOL_NAMES.length);
    const registryNames = new Set(toolRegistry.all().map((tool) => tool.name));
    for (const name of BATCH_TOOL_NAMES)
      expect(registryNames.has(name), `批处理工具 ${name} 与领域工具重名`).toBe(false);

    const readNames = readSurface()
      .descriptors()
      .map((descriptor) => descriptor.name);
    for (const forbidden of READ_FORBIDDEN_TOOL_NAMES)
      expect(readNames, `§7.1 read 面不含分析写回/队列管理工具 ${forbidden}`).not.toContain(
        forbidden,
      );
    for (const name of readNames)
      expect(name.startsWith('run_'), `§7.1 read 面出现批处理入口 ${name}`).toBe(false);
  });

  it('A4 · LUOOME_EXPOSE_TRADE=true 在创建目录/打开事实库之前就失败（§7.1）', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'luoome-analysis-surface-contract-'));
    const home = join(parent, 'trade-home');
    try {
      // 显式配置 env 与进程 env 两条来源都必须被同一处硬卡拦下。
      await expect(
        createProductionHost({
          home,
          owner: { userId: 'contract-owner', accountId: 'contract-account' },
          env: { LUOOME_EXPOSE_TRADE: 'true' },
        }),
      ).rejects.toThrow(/LUOOME_EXPOSE_TRADE/);
      expect(existsSync(home), '§7.1 trade 硬卡必须发生在任何业务 IO 之前').toBe(false);

      vi.stubEnv('LUOOME_EXPOSE_TRADE', 'true');
      await expect(
        createProductionHost({
          home,
          owner: { userId: 'contract-owner', accountId: 'contract-account' },
          env: { LUOOME_MARKET_PROVIDER: 'real' },
        }),
      ).rejects.toThrow(/LUOOME_EXPOSE_TRADE/);
      expect(existsSync(join(home, 'luoome.db'))).toBe(false);

      // read surface 读同一份判定、同一条文案。
      const ctx = await buildTestContext({ clock: () => FIXED_NOW });
      expect(() =>
        createReadSurface({
          config: { allowlist: [] },
          tools: toolRegistry.all(),
          context: () => ctx,
        }),
      ).toThrow(/LUOOME_EXPOSE_TRADE/);
    } finally {
      vi.unstubAllEnvs();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('B1 · context → record_advice：写回、证据校验、幂等与 read 面读取同一 Advice（§7.2-3/4/5/6）', async () => {
    const { ctx, accountId, principal, analysisService, readSurface } = await setup();
    const service = analysisService();

    const context = asRecord(
      unwrap(
        await readSurface().invoke(
          'get_analysis_context',
          { kind: 'advice_stock', subject: { kind: 'stock', id: STOCK_ID } },
          signal(),
        ),
        '§7.2-2 领域链路无法创建事实包',
      ),
    );
    const contextId = String(context.id);
    expect(new Date(String(context.dataAsOf)).getTime()).toBe(FIXED_NOW.getTime());

    // §7.2-5：证据引用必须落在事实包内。
    const unknownOp = await prepareOnce(service, principal, 'record_advice', {
      contextId,
      result: adviceResult(),
      provenance: adviceProvenance(['invented:not-in-context']),
    });
    const unknown = await confirmOnce(service, principal, unknownOp, '§7.2-5 未知证据引用 confirm');
    expect(unknown.state, '§7.2-5 未知证据引用必须失败而不是成功').toBe('unknown');
    expect(unknown.result?.ok).toBe(false);
    if (unknown.result !== undefined && !unknown.result.ok)
      expect(toolErrorMessage(unknown.result.error)).toBe('unknown_fact_reference');

    const operation = await prepareOnce(service, principal, 'record_advice', {
      contextId,
      result: adviceResult(),
      provenance: adviceProvenance(),
    });
    const confirmed = await confirmOnce(service, principal, operation, '§7.2-3 record_advice 写回');
    expect(confirmed.state, JSON.stringify(confirmed)).toBe('succeeded');
    const advice = asRecord(
      unwrap(requireResult(confirmed.result, '§7.2-3 record_advice'), '§7.2-3 record_advice 回执'),
    );
    const adviceId = String(advice.id);

    expect((advice.disclaimers as unknown[]).length, '§7.2-3 写回 Advice 带免责声明').toBe(3);
    expect(new Date(String(asRecord(advice.basedOn).dataAsOf)).getTime()).toBe(FIXED_NOW.getTime());
    expect(asRecord(advice.provenance).contextId, '§7.2-4 provenance.contextId').toBe(contextId);

    const rows = await ctx.repos.advice.query({
      subjectKind: 'stock',
      subjectId: STOCK_ID,
      includeExpired: true,
    });
    expect(rows.filter((row) => row.id === adviceId)).toHaveLength(1);

    // §7.2-6 重放：同一 operation 再次 confirm 不重复写库，回执不变。
    const replayed = await confirmOnce(service, principal, operation, '§7.2-6 重放');
    expect(replayed.state).toBe('succeeded');
    const replayedData = replayed.result?.ok === true ? asRecord(replayed.result.data) : {};
    expect(String(replayedData.id)).toBe(adviceId);
    expect((await service.reconcile(principal, operation.operationId)).ok).toBe(true);
    const afterReplay = await ctx.repos.advice.query({
      subjectKind: 'stock',
      subjectId: STOCK_ID,
      includeExpired: true,
    });
    expect(afterReplay.filter((row) => row.id === adviceId)).toHaveLength(1);

    // §7.2-6 不同结果复用同一 context：不能冒充满幂等。
    const conflictOp = await prepareOnce(service, principal, 'record_advice', {
      contextId,
      result: { ...adviceResult(), decision: 'avoid' as const },
      provenance: adviceProvenance(),
    });
    const conflict = await confirmOnce(service, principal, conflictOp, '§7.2-6 冲突结果');
    expect(conflict.state, '§7.2-6 不同结果必须被拒绝').toBe('unknown');
    if (conflict.result !== undefined && !conflict.result.ok)
      expect(toolErrorMessage(conflict.result.error)).toBe('duplicate_result');

    // §7.2-4 read 面读到同一 Advice，并保留 context 关系。
    const advices = asRecord(
      unwrap(
        await readSurface().invoke(
          'get_advice',
          { subjectKind: 'stock', subjectId: STOCK_ID, includeExpired: true },
          signal(),
        ),
        '§7.2-4 read 面 get_advice 失败',
      ),
    ).advices as unknown[];
    const matched = advices.map((item) => asRecord(item)).find((item) => item.id === adviceId);
    expect(matched, '§7.2-4 read 面应读到同一 Advice').toBeDefined();
    expect(asRecord(matched?.provenance).contextId).toBe(contextId);
    expect(await ctx.repos.analysis.findContext(accountId, contextId)).not.toBeNull();
  });

  it('B2 · record_analysis_result 完成一条研究方向 publication（写回/重放/冲突）（§7.2-7）', async () => {
    const { ctx, accountId, principal, analysisService } = await setup();
    const service = analysisService();
    // research_directions 的写回窗口要求 dataAsOf 接近 now；走 repo 直接构造合法 context
    // （与原 e2e 相同的验收方式），不依赖已发布策略运行事实。
    const researchContext = AnalysisContextSchema.parse({
      id: randomUUID(),
      jobId: null,
      kind: 'research_directions',
      accountId,
      subject: { kind: 'research', id: 'contract-research-directions' },
      dataAsOf: FIXED_NOW,
      facts: [],
      factIds: [],
      limitations: ['合成验收：不读取真实研究资料，仅验证写回链路。'],
      contextHash: analysisHash({ facts: [], dataAsOf: FIXED_NOW }),
      writeUntil: new Date(FIXED_NOW.getTime() + 30 * 60000),
      expiresAt: new Date(FIXED_NOW.getTime() + 180 * 86_400_000),
      createdAt: FIXED_NOW,
    });
    await ctx.repos.analysis.saveContext(researchContext);

    const researchInput = {
      contextId: researchContext.id,
      result: {
        kind: 'research_directions' as const,
        question: '合成验收：研究方向写回链路是否可用？',
        directions: [],
        limitations: ['合成验收数据，不含外部研究或真实模型结论。'],
      },
      provenance: adviceProvenance([]),
    };
    const operation = await prepareOnce(
      service,
      principal,
      'record_analysis_result',
      researchInput,
    );
    const confirmed = await confirmOnce(
      service,
      principal,
      operation,
      '§7.2-7 record_analysis_result 写回',
    );
    expect(confirmed.state).toBe('succeeded');
    const published = asRecord(
      unwrap(
        requireResult(confirmed.result, '§7.2-7 record_analysis_result'),
        '§7.2-7 record_analysis_result 回执',
      ),
    );
    expect(published.replayed, '§7.2-7 首次写回 replayed=false').toBe(false);

    const researchId = `analysis:${researchContext.id}`;
    expect(published.resultRef, '§7.2-7 resultRef 指向 research id').toBe(researchId);
    const research = await ctx.repos.investmentWorkspace.findResearch({
      ownerUserId: ctx.user.id,
      accountId,
      id: researchId,
    });
    expect(research, '§7.2-7 investmentWorkspace 必须能查到写回的研究方向').not.toBeNull();
    expect(research?.question).toBe(researchInput.result.question);
    expect(research?.limitations.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(research?.provenance?.contextId).toBe(researchContext.id);

    // §7.2-7 重放：policy 的 receipt 只读回已记录的 recordedResult，不再执行业务写入。
    const policy = createRecordAnalysisResultOperation(TRUSTED);
    const replayReceipt = await policy.receipt(operation.input, ctx);
    expect(replayReceipt?.ok, '§7.2-7 相同结果的重放回执必须命中').toBe(true);
    if (replayReceipt?.ok === true)
      expect(asRecord(replayReceipt.data).replayed, '§7.2-7 重放回执 replayed=true').toBe(true);
    expect(
      await policy.receipt(
        { ...operation.input, result: { ...researchInput.result, question: '不同结果' } },
        ctx,
      ),
      '§7.2-7 不同结果不得被当作重放命中',
    ).toBeNull();

    // §7.2-7 不同结果复用同一 context 被 duplicate_result 拒绝。
    const conflictOp = await prepareOnce(service, principal, 'record_analysis_result', {
      ...researchInput,
      result: { ...researchInput.result, question: '合成验收：不同的研究方向结果。' },
    });
    const conflict = await confirmOnce(service, principal, conflictOp, '§7.2-7 冲突结果');
    expect(conflict.state, '§7.2-7 不同结果必须被拒绝').toBe('unknown');
    if (conflict.result !== undefined && !conflict.result.ok)
      expect(toolErrorMessage(conflict.result.error)).toBe('duplicate_result');
  });

  it('A5 · 默认部署最终态只读检查：技能不再引用 worker、compose 无 dsh-worker（§7.2-9/10 部分）', () => {
    // REQ-M1-01：技能唯一根是插件包；正文只写裸工具名，不写 MCP 命名空间。
    const skill = readFileSync(
      join(REPO_ROOT, 'packages/dsh-luoome/skills/stock-deep-dive/SKILL.md'),
      'utf8',
    );
    expect(skill, '§7.2-9 stock-deep-dive 不得引用 luoome-worker 命名空间').not.toContain(
      'luoome-worker',
    );
    expect(skill, '§7.2-9 stock-deep-dive 用裸工具名调用 get_analysis_context').toContain(
      '`get_analysis_context`',
    );
    expect(skill, '§7.2-9 技能正文不写 mcp__ 命名空间').not.toContain('mcp__');

    const compose = readFileSync(join(REPO_ROOT, 'deploy/dsh/compose.yaml'), 'utf8');
    expect(compose, '§7.2-10 默认 compose 没有 dsh-worker 服务').not.toMatch(/^\s{2}dsh-worker:/m);
    expect(compose, '§7.2-10 默认 compose 没有 DSH_WORKER 轮询环境项').not.toContain('DSH_WORKER_');
  });
});
