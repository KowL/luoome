import type { ToolContext } from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { getStockFinancialSnapshotTool } from './get-stock-financial-snapshot.js';

/**
 * get_stock_financial_snapshot tool 测试。
 *
 * 走 Tool 契约入口 execute（input parse → handler → output parse），
 * 不直接触达内部 handler。
 */

const createMockContext = (financialSnapshot?: ToolContext['financialSnapshot']): ToolContext => {
  return {
    repos: {} as ToolContext['repos'],
    adapters: {} as ToolContext['adapters'],
    user: { id: 'test-user', defaultAccountId: 'test-account' },
    clock: () => new Date('2026-11-04T07:50:00+08:00'),
    logger: console,
    ...(financialSnapshot === undefined ? {} : { financialSnapshot }),
  } as ToolContext;
};

describe('getStockFinancialSnapshotTool', () => {
  it('returns invalid_input when financialSnapshot manager is not configured', async () => {
    const ctx = createMockContext(undefined);
    const result = await getStockFinancialSnapshotTool.execute({ stockId: '600519.SH' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_input');
      if (result.error.kind === 'invalid_input') {
        expect(result.error.message).toContain('financialSnapshot');
      }
    }
  });

  it('returns adapter_error when manager fails', async () => {
    const mockManager = {
      name: 'financial-snapshot' as const,
      sources: ['fuyao'],
      fetchSnapshot: async () => ({
        ok: false as const,
        error: {
          kind: 'adapter_error' as const,
          adapter: 'financial-snapshot' as const,
          message: 'Network error',
          recoverable: true,
        },
      }),
      status: () => [],
    };

    const ctx = createMockContext(mockManager);
    const result = await getStockFinancialSnapshotTool.execute({ stockId: '600519.SH' }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('adapter_error');
      if (result.error.kind === 'adapter_error') {
        expect(result.error.cause).toContain('Network error');
      }
    }
  });

  it('returns snapshot data when manager succeeds', async () => {
    const mockSnapshot = {
      stockId: '600519.SH',
      source: 'fuyao' as const,
      viewKind: 'current-vendor-view' as const,
      pitStatus: 'not-ready' as const,
      periodEnd: new Date('2025-12-31'),
      reportDate: new Date('2026-04-01'),
      fetchedAt: new Date('2026-11-04T07:50:00+08:00'),
      rawContentHash: 'a'.repeat(64),
      statements: {
        incomeStatements: [
          {
            statementType: 'income-statement' as const,
            stockId: '600519.SH',
            period: '2025-4',
            fiscalYear: 2025,
            fiscalPeriod: 4,
            periodEnd: new Date('2025-12-31'),
            reportDate: new Date('2026-04-01'),
            currency: 'CNY' as const,
            fields: {
              operating_income: 150000000000,
              operating_cost: 80000000000,
              operating_expenses: 20000000000,
              operating_profit: 50000000000,
              total_profit: 52000000000,
              income_tax: 10000000000,
              net_profit: 42000000000,
              parent_holder_net_profit: 40000000000,
              deduct_parent_holder_net_profit: 38000000000,
              minority_interest: 2000000000,
              basic_eps: 3.5,
              interest_expenses: 500000000,
              interest_income: 200000000,
            },
          },
        ],
      },
      missingFields: [],
      issues: [],
    };

    const mockManager = {
      name: 'financial-snapshot' as const,
      sources: ['fuyao'],
      fetchSnapshot: async () => ({
        ok: true as const,
        data: mockSnapshot,
      }),
      status: () => [],
    };

    const ctx = createMockContext(mockManager);
    const result = await getStockFinancialSnapshotTool.execute({ stockId: '600519.SH' }, ctx);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.stockId).toBe('600519.SH');
      expect(result.data.viewKind).toBe('current-vendor-view');
      expect(result.data.pitStatus).toBe('not-ready');
      expect(result.data.statements?.incomeStatements).toHaveLength(1);
    }
  });

  it('validates input schema', async () => {
    const mockManager = {
      name: 'financial-snapshot' as const,
      sources: ['fuyao'],
      fetchSnapshot: async () => ({
        ok: true as const,
        data: {
          stockId: '600519.SH',
          source: 'fuyao' as const,
          viewKind: 'current-vendor-view' as const,
          pitStatus: 'not-ready' as const,
          fetchedAt: new Date(),
          rawContentHash: 'a'.repeat(64),
          missingFields: [],
          issues: [],
        },
      }),
      status: () => [],
    };

    const ctx = createMockContext(mockManager);

    // 缺少必需字段 stockId
    const result = await getStockFinancialSnapshotTool.execute({ includeStatements: true }, ctx);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_input');
    }
  });
});
