import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { money, TradingPlanSchema, TradingPlanV2Schema } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDrizzleRepos } from '../client.js';
import { validateDataTransferRow } from '../data-transfer-contract.js';

const legacyPlanJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: 'account:a:stock:600519.SH',
    version: 1,
    accountId: 'a',
    stockId: '600519.SH',
    industry: '食品饮料',
    status: 'active',
    action: 'add',
    entryPriceLow: money(10),
    entryPriceHigh: money(11),
    entryConditions: [],
    invalidEntryConditions: [],
    position: {
      currentPct: 5,
      targetPct: 30,
      deltaPct: 25,
      constraintStatus: 'passed',
      constraintReasons: [],
      prerequisiteActions: [],
    },
    holding: {
      minTradingDays: 1,
      maxTradingDays: 5,
      nextReviewAt: new Date('2026-09-10T00:00:00.000Z'),
      earlyExitConditions: [],
      extensionBasis: [],
    },
    exit: { conditions: [], triggerConditions: [], canSellNow: true },
    validFrom: new Date('2026-09-08T00:00:00.000Z'),
    validUntil: new Date('2026-09-20T00:00:00.000Z'),
    invalidationConditions: ['账户事实变化'],
    accountFactsAsOf: new Date('2026-09-08T00:00:00.000Z'),
    accountFactsDigest: 'legacy-facts-digest',
    marketFacts: [],
    evidence: [],
    source: { strategyIds: [], strategyVersionIds: [], runIds: [], signalIds: [], adviceIds: [] },
    explanation: { supportingEvidenceIds: [], counterEvidence: [], risks: [], unknowns: [] },
    confidence: 50,
    createdAt: new Date('2026-09-08T01:00:00.000Z'),
    ...overrides,
  });

const insertLegacy = (path: string, planJson: string): void => {
  const handle = createDrizzleRepos(path);
  try {
    handle.db.run(sql`
      INSERT INTO trading_plans
        (version_id, plan_id, version, account_id, stock_id, status, valid_from, valid_until, created_at, plan_json)
      VALUES
        ('account:a:stock:600519.SH:v1', 'account:a:stock:600519.SH', 1, 'a', '600519.SH', 'active',
         1789000000000, 1790000000000, 1789000000000, ${planJson})
    `);
  } finally {
    handle.close();
  }
};

const storedPlanJson = (path: string): string => {
  const handle = createDrizzleRepos(path);
  try {
    const rows = handle.db.all<{ plan_json: string }>(
      sql`SELECT plan_json FROM trading_plans WHERE version_id = 'account:a:stock:600519.SH:v1'`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error('legacy plan row missing');
    return row.plan_json;
  } finally {
    handle.close();
  }
};

describe('T21 旧单值计划的读时归一化（Bun SQLite）', () => {
  it('旧行读为退化区间，plan_json 字节与 status 不被改写，两次启动幂等', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-t21-legacy-'));
    const path = join(dir, 'luoome.db');
    try {
      const original = legacyPlanJson();
      insertLegacy(path, original);
      const before = createHash('sha256').update(original).digest('hex');

      const first = createDrizzleRepos(path);
      try {
        const plan = await first.repos.tradingPlan.findByVersionId('account:a:stock:600519.SH:v1');
        expect(plan).toMatchObject({
          status: 'active',
          position: {
            targetPctRange: { min: 30, max: 30 },
            appliedPct: 30,
            fallbackPct: 30,
            rangePick: { ruleId: 'lower-bound' },
          },
        });
        expect(plan?.position).not.toHaveProperty('deltaPct');
      } finally {
        first.close();
      }

      const second = createDrizzleRepos(path);
      try {
        const plan = await second.repos.tradingPlan.findByVersionId('account:a:stock:600519.SH:v1');
        expect(plan).toMatchObject({ status: 'active' });
      } finally {
        second.close();
      }
      const after = storedPlanJson(path);
      expect(createHash('sha256').update(after).digest('hex')).toBe(before);
      expect(JSON.parse(after)).toEqual(JSON.parse(original));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧行归一化后仍满足写路径不变量（区间/选点/无 deltaPct）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-t21-legacy-'));
    const path = join(dir, 'luoome.db');
    try {
      insertLegacy(path, legacyPlanJson());
      const handle = createDrizzleRepos(path);
      try {
        const plan = await handle.repos.tradingPlan.findByVersionId('account:a:stock:600519.SH:v1');
        if (plan === null) throw new Error('legacy plan missing');
        // 读路径接受旧 active 行；写路径仍要求结构化失效条件，因此 v2 严格解析必须失败。
        expect(TradingPlanV2Schema.safeParse(plan).success).toBe(false);
        expect(JSON.stringify(plan)).not.toContain('deltaPct');
      } finally {
        handle.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T21 列与 plan_json 一致性校验未被放宽', () => {
  const storageRow = (plan: unknown, status: string) => ({
    version_id: 'account:a:stock:600519.SH:v1',
    plan_id: 'account:a:stock:600519.SH',
    version: 1,
    account_id: 'a',
    stock_id: '600519.SH',
    status,
    valid_from: new Date('2026-09-08T00:00:00.000Z').getTime(),
    valid_until: new Date('2026-09-20T00:00:00.000Z').getTime(),
    created_at: new Date('2026-09-08T01:00:00.000Z').getTime(),
    plan_json: JSON.stringify(plan),
  });

  it('v1 旧形状：列 status 与载荷一致时通过，不一致时仍被拒', () => {
    const legacy = JSON.parse(legacyPlanJson());
    expect(() =>
      validateDataTransferRow('trading_plans', storageRow(legacy, 'active')),
    ).not.toThrow();
    expect(() => validateDataTransferRow('trading_plans', storageRow(legacy, 'draft'))).toThrow(
      'status 与 plan_json 元数据不一致',
    );
  });

  it('v2 形状：列 status 与载荷一致时通过，不一致时仍被拒', () => {
    const normalized = TradingPlanSchema.parse(JSON.parse(legacyPlanJson()));
    expect(() =>
      validateDataTransferRow('trading_plans', storageRow(normalized, 'active')),
    ).not.toThrow();
    expect(() => validateDataTransferRow('trading_plans', storageRow(normalized, 'draft'))).toThrow(
      'status 与 plan_json 元数据不一致',
    );
  });
});
