import { createHash } from 'node:crypto';

import type { ResearchVaultAdapterLike, ResearchVaultEntry, ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { getAccountOverviewTool } from './get-account-overview.js';
import { getAdviceTool } from './get-advice.js';
import { getStrategySignalsTool } from './get-strategy-signals.js';
import { listWatchPlansTool } from './list-watch-plans.js';
import { runStrategyBacktestTool } from './run-strategy-backtest.js';
import { saveAlertPlanTool } from './save-alert-plan.js';
import { saveResearchDocumentTool } from './save-research-document.js';
import { saveStrategyVersionTool } from './save-strategy-version.js';
import { updateHoldingTool } from './update-holding.js';
import { updateWatchlistMembersTool } from './update-watchlist-members.js';
import { createWatchlistTool } from './watchlist.js';

const definition = {
  schemaVersion: 1 as const,
  metadata: { horizon: 'short' as const },
  universe: { coverage: 'CN_A_SHARES_SH_SZ' as const, excludeStockIds: [] },
  selection: {
    logic: 'all' as const,
    rules: [
      { id: 'positive-price', name: '价格有效', when: 'quote.close > 0', evidence: ['价格有效'] },
    ],
  },
  signals: { entry: [], exit: [], risk: [] },
};

describe('S4.1a 合并 facade', () => {
  it('save_strategy_version：create-strategy 与 save-version 串联后可 validate/publish', async () => {
    const ctx = await buildTestContext();
    const created = await saveStrategyVersionTool.execute(
      { action: 'create-strategy', name: '合并入口策略', description: 'S4.1a' },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const strategy = (created.data as { strategy: { id: string } }).strategy;
    const version = await saveStrategyVersionTool.execute(
      { action: 'save-version', strategyId: strategy.id, definition },
      ctx,
    );
    expect(version.ok).toBe(true);
    if (!version.ok) return;
    const versionId = (version.data as { version: { id: string } }).version.id;
    const validated = await saveStrategyVersionTool.execute({ action: 'validate', versionId }, ctx);
    expect(validated.ok).toBe(true);
    const published = await saveStrategyVersionTool.execute({ action: 'publish', versionId }, ctx);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect((published.data as { strategy: { status: string } }).strategy.status).toBe('active');
  });

  it('run_strategy_backtest：list 空、run 缺参 invalid_input', async () => {
    const ctx = await buildTestContext();
    const listed = await runStrategyBacktestTool.execute({ action: 'list' }, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect((listed.data as { runs: unknown[] }).runs).toEqual([]);
    const bad = await runStrategyBacktestTool.execute({ action: 'run' }, ctx);
    expect(bad.ok).toBe(false);
  });

  it('get_account_overview 返回账户 + 持仓 + 事实', async () => {
    const ctx = await buildTestContext();
    const result = await getAccountOverviewTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.account.id).toBe(ctx.user.defaultAccountId);
    expect(result.data.holdings.length).toBeGreaterThan(0);
    expect(result.data.facts).toBeDefined();
  });

  it('update_holding：open 建仓与 close 平仓', async () => {
    const ctx = await buildTestContext();
    const opened = await updateHoldingTool.execute(
      { mode: 'open', stockId: '601398.SH', quantity: 100, avgCost: 5.5 },
      ctx,
    );
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const holdingId = opened.data.holding.id;
    const closed = await updateHoldingTool.execute({ mode: 'close', holdingId }, ctx);
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.data.holding.closedAt).toBeDefined();
  });

  it('get_advice includeDecisionReviews 附带复盘列表', async () => {
    const ctx = await buildTestContext();
    const result = await getAdviceTool.execute(
      { includeDecisionReviews: true, decisionReviewLimit: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.decisionReviews).toBeDefined();
  });

  it('get_strategy_signals 无观察样本时返回空信号与全局统计', async () => {
    const ctx = await buildTestContext();
    const result = await getStrategySignalsTool.execute({ stockId: '002594.SZ' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total).toBeGreaterThanOrEqual(0);
    expect(result.data.observationStats).toBeDefined();
  });

  it('update_watchlist_members：add → update → remove', async () => {
    const ctx = await buildTestContext();
    const created = await (await import('./watchlist.js')).createWatchlistTool.execute(
      { name: 'S4 池', kind: 'personal', membershipPolicy: 'manual', enabled: true },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const watchlistId = created.data.watchlist.id;
    const added = await updateWatchlistMembersTool.execute(
      { watchlistId, add: [{ stockId: '002594.SZ' }] },
      ctx,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.data.added).toBe(1);
    const updated = await updateWatchlistMembersTool.execute(
      { watchlistId, update: [{ stockId: '002594.SZ', stage: 'researching' }] },
      ctx,
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.updated).toBe(1);
    const removed = await updateWatchlistMembersTool.execute(
      { watchlistId, remove: ['002594.SZ'] },
      ctx,
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.data.removed).toBe(1);
  });

  it('list_watch_plans 返回计划与预警数组', async () => {
    const ctx = await buildTestContext();
    const result = await listWatchPlansTool.execute({ includeAlertPlans: true }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Array.isArray(result.data.plans)).toBe(true);
    expect(Array.isArray(result.data.alertPlans)).toBe(true);
  });

  it('save_alert_plan：创建后可更新', async () => {
    const ctx = await buildTestContext();
    const createdWatchlist = await createWatchlistTool.execute(
      { name: 'S4 预警池', kind: 'personal', membershipPolicy: 'manual', enabled: true },
      ctx,
    );
    expect(createdWatchlist.ok).toBe(true);
    if (!createdWatchlist.ok) return;
    const watchlistId = createdWatchlist.data.watchlist.id;
    const created = await saveAlertPlanTool.execute(
      {
        name: 'S4 预警',
        watchlistId,
        rules: [{ id: 'r1', kind: 'price-level', level: 100, side: 'above' }] as never,
      },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const updated = await saveAlertPlanTool.execute(
      { alertPlanId: created.data.plan.id, enabled: false },
      ctx,
    );
    expect(updated.ok).toBe(true);
  });

  const vaultEntry = (relativePath: string, value: string): ResearchVaultEntry => ({
    relativePath,
    size: Buffer.byteLength(value),
    modifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    contentHash: createHash('sha256').update(value).digest('hex'),
  });
  const vault = (): ResearchVaultAdapterLike => {
    const files = new Map<string, string>();
    return {
      name: 'test-vault',
      vaultId: 'vault-test',
      managedRoot: 'Research/Luoome',
      scan: async () => [...files.entries()].map(([path, value]) => vaultEntry(path, value)),
      readText: async ({ relativePath }) => files.get(relativePath) ?? '',
      createManagedDocument: async (input) => {
        files.set(input.relativePath, input.content);
        return vaultEntry(input.relativePath, input.content);
      },
      importAttachment: async ({ suggestedName }) => vaultEntry(`Research/${suggestedName}`, ''),
      buildOpenUri: (relativePath) => `obsidian://open?file=${relativePath}`,
    };
  };

  it('save_research_document 的 note 目标写入 Vault 并索引', async () => {
    const base = await buildTestContext({ clock: () => new Date('2026-08-01T00:00:00.000Z') });
    const ctx: ToolContext = {
      ...base,
      adapters: { ...base.adapters, researchVault: vault() },
    };
    const result = await saveResearchDocumentTool.execute(
      { target: 'note', note: { title: 'S4 笔记', kind: 'note', body: '正文' } },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as { target: string }).target).toBe('note');
  });
});
