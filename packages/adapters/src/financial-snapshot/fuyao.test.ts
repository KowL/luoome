import { readFileSync } from 'node:fs';
import type { FinancialSnapshotQuery } from '@luoome/core';
import { describe, expect, it } from 'vitest';
import { FuyaoClient } from '../fuyao/client.js';
import { FuyaoFinancialSnapshotAdapter } from './fuyao.js';
import { FinancialSnapshotManager } from './manager.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fuyao/fixtures/${name}.json`, import.meta.url), 'utf8'));
const paths = ['income-statements', 'balance-sheets', 'cash-flow-statements'] as const;
const clock = () => new Date('2026-11-04T00:00:00Z');
const query: FinancialSnapshotQuery = {
  stockId: '600519.SH',
  statementPeriod: 'annual',
  statementLimit: 3,
  includeStatements: true,
  includeIndicators: false,
  includeValuation: false,
};

// Replay the archived envelopes through the real client; mutations below are explicitly synthetic.
const setup = (overrides: Record<string, unknown> = {}, observationClock = clock) => {
  const requests: URL[] = [];
  const client = new FuyaoClient(
    { baseUrl: 'https://fixture.invalid', apiKey: 'fixture-key', timeoutMs: 1000, retries: 0 },
    {
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requests.push(url);
        const name = url.pathname.split('/').at(-1) as string;
        return new Response(
          JSON.stringify(
            overrides[name] ?? fixture(name === 'snapshot' ? 'valuations-snapshot' : name),
          ),
        );
      }) as typeof fetch,
    },
  );
  const adapter = new FuyaoFinancialSnapshotAdapter({ client, clock: observationClock });
  return { adapter, requests };
};

describe('FinancialSnapshotManager registry observations', () => {
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const managerFor = (adapter: FuyaoFinancialSnapshotAdapter) =>
    new FinancialSnapshotManager({ adapters: [adapter], logger, clock });

  it('starts unobserved and records actual per-capability success and period asOf', async () => {
    const { adapter } = setup();
    const manager = managerFor(adapter);
    expect(manager.status()).toHaveLength(5);
    expect(manager.status().every((status) => status.lastAttemptAt === undefined)).toBe(true);
    expect((await manager.fetchSnapshot(query)).ok).toBe(true);
    const status = manager.status().find((item) => item.dataset === 'financial-income-statements');
    expect(status).toMatchObject({
      lastAttemptAt: clock(),
      lastSuccessAt: clock(),
      dataAsOf: new Date(fixture('income-statements').data.timestamp),
    });
    expect(status?.lastErrorKind).toBeUndefined();
    expect(
      manager.status().find((item) => item.dataset === 'financial-indicators')?.lastSuccessAt,
    ).toBeUndefined();
  });

  it.each([3002, 2003])(
    'records code %i as no_data/permission for only the affected capability',
    async (code) => {
      const { adapter } = setup({ 'income-statements': { code } });
      const manager = managerFor(adapter);
      const result = await manager.fetchSnapshot(query);
      expect(result.ok).toBe(code === 3002);
      const status = manager
        .status()
        .find((item) => item.dataset === 'financial-income-statements');
      expect(status).toMatchObject({
        lastAttemptAt: clock(),
        lastErrorKind: code === 3002 ? 'no_data' : 'permission',
      });
      expect(status?.lastSuccessAt).toBeUndefined();
      expect(status?.dataAsOf).toBeUndefined();
      expect(
        manager.status().find((item) => item.dataset === 'financial-indicators')?.lastErrorKind,
      ).toBeUndefined();
    },
  );

  it('retains prior success/asOf for diagnosis and clears permission only after actual recovery', async () => {
    const overrides: Record<string, unknown> = {};
    let now = clock();
    const { adapter } = setup(overrides, () => now);
    const manager = managerFor(adapter);
    await manager.fetchSnapshot(query);
    now = new Date('2026-11-04T01:00:00Z');
    overrides['income-statements'] = { code: 2003 };
    await manager.fetchSnapshot(query);
    await manager.fetchSnapshot({ ...query, includeStatements: false, includeValuation: true });
    expect(
      manager.status().find((item) => item.dataset === 'financial-income-statements'),
    ).toMatchObject({
      lastAttemptAt: now,
      lastErrorKind: 'permission',
      lastSuccessAt: clock(),
      dataAsOf: new Date(fixture('income-statements').data.timestamp),
    });
    expect(manager.status().find((item) => item.dataset === 'valuation-snapshot')).toMatchObject({
      lastSuccessAt: now,
    });
    expect(
      manager.status().find((item) => item.dataset === 'valuation-snapshot')?.dataAsOf,
    ).toBeUndefined();
    delete overrides['income-statements'];
    await manager.fetchSnapshot(query);
    expect(
      manager.status().find((item) => item.dataset === 'financial-income-statements')
        ?.lastSuccessAt,
    ).toEqual(now);
    expect(
      manager.status().find((item) => item.dataset === 'financial-income-statements')
        ?.lastErrorKind,
    ).toBeUndefined();
  });
});

describe('Fuyao financial snapshot archived JSON contracts', () => {
  it('loads all three real annual fixtures and sends their exact period/limit/identity', async () => {
    const { adapter, requests } = setup();
    const result = await adapter.fetchSnapshot(query);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(Object.fromEntries(request.searchParams)).toEqual({
        thscode: '600519.SH',
        period: 'annual',
        limit: '3',
      });
    }
    const groups = [
      result.statements?.incomeStatements,
      result.statements?.balanceSheets,
      result.statements?.cashFlowStatements,
    ];
    for (const [index, group] of groups.entries()) {
      const raw = fixture(paths[index] as string).data.item;
      expect(group).toHaveLength(raw.length);
      for (const [i, statement] of (group ?? []).entries()) {
        expect(statement).toMatchObject({
          stockId: raw[i].thscode,
          period: raw[i].period,
          fiscalYear: raw[i].fiscal_year,
          fiscalPeriod: 4,
          periodEnd: new Date(raw[i].period_end_ms),
          reportDate: new Date(raw[i].report_date_ms),
        });
      }
    }
    expect(groups[0]?.[0]?.fields.operating_income).toBe(
      fixture('income-statements').data.item[0].operating_income,
    );
    expect(groups[1]?.[0]?.fields.assets_total).toBe(
      fixture('balance-sheets').data.item[0].assets_total,
    );
    expect(groups[2]?.[0]?.fields.act_cash_flow_net).toBe(
      fixture('cash-flow-statements').data.item[0].act_cash_flow_net,
    );
    expect(result).toMatchObject({
      viewKind: 'current-vendor-view',
      pitStatus: 'not-ready',
      fetchedAt: clock(),
      missingFields: [],
    });
    expect(result.observedAt).toBeUndefined();
    expect(result.rawContentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('loads real indicators for their actual stock and report, preserving null and registry units', async () => {
    const { adapter, requests } = setup();
    const result = await adapter.fetchSnapshot({
      ...query,
      stockId: '300033.SZ',
      includeStatements: false,
      includeIndicators: true,
      indicatorReport: '2025-1',
    });
    expect(Object.fromEntries(requests[0]?.searchParams ?? [])).toEqual({
      thscode: '300033.SZ',
      report: '2025-1',
    });
    const raw = fixture('indicators').data.abilities.flatMap(
      (ability: { indicators: unknown[] }) => ability.indicators,
    );
    expect(result.indicators?.indicators).toHaveLength(raw.length);
    expect(result.indicators?.indicators[0]).toMatchObject({
      unit: 'percent-points',
      value: 20.90499,
      rawValue: '20.90499000',
    });
    expect(
      result.indicators?.indicators.find((item) => item.indicatorId === 'earned_interest_multiple'),
    ).toMatchObject({ value: null, rawValue: null });
  });

  it.each(['stock', 'report'])('rejects indicator response %s mismatch', async (mismatch) => {
    const { adapter } = setup();
    await expect(
      adapter.fetchSnapshot({
        ...query,
        stockId: mismatch === 'stock' ? '600519.SH' : '300033.SZ',
        includeStatements: false,
        includeIndicators: true,
        indicatorReport: mismatch === 'report' ? '2024-4' : '2025-1',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_payload' });
  });

  it.each(paths)('preserves other statements when %s returns 3002', async (path) => {
    const { adapter } = setup({ [path]: { code: 3002, message: 'No data', data: null } });
    const result = await adapter.fetchSnapshot(query);
    const key = {
      'income-statements': 'incomeStatements',
      'balance-sheets': 'balanceSheets',
      'cash-flow-statements': 'cashFlowStatements',
    }[path] as 'incomeStatements' | 'balanceSheets' | 'cashFlowStatements';
    expect(result.statements?.[key]).toEqual([]);
    expect(result.missingFields).toContain(`statements.${key}`);
    expect(
      Object.values(result.statements ?? {}).filter(
        (rows) => rows !== undefined && rows.length > 0,
      ),
    ).toHaveLength(2);
  });

  it.each(paths)('rejects wrong stock in %s', async (path) => {
    const raw = fixture(path);
    raw.data.item[0].thscode = '000001.SZ';
    const { adapter } = setup({ [path]: raw });
    await expect(adapter.fetchSnapshot(query)).rejects.toMatchObject({ kind: 'invalid_payload' });
  });

  it('treats unknown indicator IDs as schema drift', async () => {
    const raw = fixture('indicators');
    raw.data.abilities[0].indicators[0].index_id = 'unknown_metric';
    const { adapter } = setup({ indicators: raw });
    await expect(
      adapter.fetchSnapshot({
        ...query,
        stockId: '300033.SZ',
        includeStatements: false,
        includeIndicators: true,
        indicatorReport: '2025-1',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_payload' });
  });

  it('preserves quarterly cumulative amounts and null without inventing PIT times', async () => {
    const raw = fixture('income-statements');
    raw.data.item = [
      { ...raw.data.item[0], period: 'quarterly', fiscal_period: 'Q3', interest_expenses: null },
    ];
    const { adapter, requests } = setup({
      'income-statements': raw,
      'balance-sheets': { code: 3002 },
      'cash-flow-statements': { code: 3002 },
    });
    const result = await adapter.fetchSnapshot({
      ...query,
      statementPeriod: 'quarterly',
      statementLimit: 4,
    });
    expect(Object.fromEntries(requests[0]?.searchParams ?? [])).toEqual({
      thscode: '600519.SH',
      period: 'quarterly',
      limit: '4',
    });
    expect(result.statements?.incomeStatements?.[0]).toMatchObject({
      period: 'quarterly',
      fiscalPeriod: 3,
      fields: { operating_income: raw.data.item[0].operating_income, interest_expenses: null },
    });
    expect(result.observedAt).toBeUndefined();
    expect(result.pitStatus).toBe('not-ready');
  });

  it('selects requested valuation identity from archived multi-stock payload without treating timestamp as observation', async () => {
    const { adapter, requests } = setup();
    const result = await adapter.fetchSnapshot({
      ...query,
      stockId: '000001.SZ',
      includeStatements: false,
      includeValuation: true,
    });
    expect(Object.fromEntries(requests[0]?.searchParams ?? [])).toEqual({ thscodes: '000001.SZ' });
    expect(result.valuation).toMatchObject({
      stockId: '000001.SZ',
      peTtm: fixture('valuations-snapshot').data.item[1].pe_ttm,
    });
    expect(result.observedAt).toBeUndefined();
  });

  it.each(['period', 'limit', 'shape'])('rejects statement contract drift in %s', async (field) => {
    const raw = fixture('income-statements');
    if (field === 'period') raw.data.item[0].period = 'quarterly';
    if (field === 'limit') raw.data.item.push(raw.data.item[0]);
    if (field === 'shape') delete raw.data.item[0].operating_income;
    const { adapter } = setup({ 'income-statements': raw });
    await expect(adapter.fetchSnapshot(query)).rejects.toMatchObject({ kind: 'invalid_payload' });
    expect(
      adapter.status().find((item) => item.dataset === 'financial-income-statements')
        ?.lastErrorKind,
    ).toBe('invalid_payload');
  });

  it.each(['', '1.2junk'])('rejects malformed numeric indicator strings: %j', async (value) => {
    const raw = fixture('indicators');
    raw.data.abilities[0].indicators[0].value = value;
    const { adapter } = setup({ indicators: raw });
    await expect(
      adapter.fetchSnapshot({
        ...query,
        stockId: '300033.SZ',
        includeStatements: false,
        includeIndicators: true,
        indicatorReport: '2025-1',
      }),
    ).rejects.toMatchObject({ kind: 'invalid_payload' });
  });

  it.each(['indicators', 'snapshot'])(
    'preserves no_data for optional %s in result and registry',
    async (endpoint) => {
      const { adapter } = setup({ [endpoint]: { code: 3002 } });
      const result = await adapter.fetchSnapshot({
        ...query,
        includeStatements: false,
        includeIndicators: endpoint === 'indicators',
        includeValuation: endpoint === 'snapshot',
        indicatorReport: '2025-1',
      });
      expect(result.missingFields).toContain(
        endpoint === 'indicators' ? 'indicators' : 'valuation',
      );
      expect(
        adapter
          .status()
          .find(
            (item) =>
              item.dataset ===
              (endpoint === 'indicators' ? 'financial-indicators' : 'valuation-snapshot'),
          )?.lastErrorKind,
      ).toBe('no_data');
    },
  );

  it('rejects valuation with only a different stock', async () => {
    const raw = fixture('valuations-snapshot');
    raw.data.item = [raw.data.item[1]];
    const { adapter } = setup({ snapshot: raw });
    await expect(
      adapter.fetchSnapshot({ ...query, includeStatements: false, includeValuation: true }),
    ).rejects.toMatchObject({ kind: 'invalid_payload' });
  });
});
