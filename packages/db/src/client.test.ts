import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { money, quantity } from '@luoome/core';
import { sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { createDrizzleRepos, ensureSchema } from './client.js';
import {
  makeAccount,
  makeAdvice,
  makeHolding,
  makeReport,
  makeTrade,
  makeTradingPlan,
  makeWatchTrigger,
} from './repository/contract-tests.js';
import * as schema from './schema/index.js';
import { accounts } from './schema/index.js';

describe('createDrizzleRepos / ensureSchema', () => {
  it('预警投递迁移保留旧数据并可重复执行', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      await handle.repos.watchTrigger.save(
        makeWatchTrigger('legacy-watch', {
          deliveryStatus: 'pending',
          notified: false,
        }),
      );
      handle.db.run(sql`ALTER TABLE watch_triggers DROP COLUMN delivery_attempts`);
      handle.db.run(sql`ALTER TABLE watch_triggers DROP COLUMN last_delivery_attempt_at`);
      handle.db.run(sql`ALTER TABLE watch_triggers DROP COLUMN delivery_completed_at`);
      ensureSchema(handle.db);
      ensureSchema(handle.db);
      expect(await handle.repos.watchTrigger.findById('legacy-watch')).toMatchObject({
        id: 'legacy-watch',
      });
      await handle.repos.watchTrigger.beginDelivery(
        ['legacy-watch'],
        new Date('2026-07-27T02:00:00Z'),
      );
      expect(await handle.repos.watchTrigger.findById('legacy-watch')).toMatchObject({
        deliveryAttempts: 1,
      });
    } finally {
      handle.close();
    }
  });

  it('旧预警行情列放宽约束时保留账户归属和投递完成时间', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      handle.db.run(sql`DROP TABLE watch_triggers`);
      handle.db.run(sql`
        CREATE TABLE watch_triggers (
          id TEXT PRIMARY KEY,
          alert_plan_id TEXT,
          pool_id TEXT NOT NULL,
          stock_id TEXT NOT NULL,
          rule_kind TEXT NOT NULL,
          direction TEXT NOT NULL,
          reason TEXT NOT NULL,
          evidence TEXT NOT NULL,
          quote_close REAL NOT NULL,
          quote_ts INTEGER NOT NULL,
          notified INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          rule_id TEXT NOT NULL,
          trigger_type TEXT NOT NULL,
          priority TEXT NOT NULL,
          delivery_status TEXT NOT NULL,
          notification_id TEXT,
          eval_snapshot TEXT NOT NULL,
          feedback TEXT,
          feedback_at INTEGER,
          event_id TEXT,
          delivery_attempts INTEGER,
          last_delivery_attempt_at INTEGER,
          delivery_completed_at INTEGER
        )
      `);
      const eventAt = new Date('2026-07-27T02:00:00.000Z');
      const acceptedAt = new Date('2026-07-27T02:00:05.000Z');
      handle.db.run(sql`
        INSERT INTO watch_triggers (
          id, alert_plan_id, pool_id, stock_id, rule_kind, direction, reason,
          evidence, quote_close, quote_ts, notified, created_at, rule_id,
          trigger_type, priority, delivery_status, notification_id, eval_snapshot,
          delivery_attempts, last_delivery_attempt_at, delivery_completed_at
        ) VALUES (
          'legacy-not-null', 'plan-1', 'pool-1', 'stock-1', 'price-level', 'buy',
          '旧记录', '["legacy"]', 10, ${eventAt.getTime()}, 1, ${eventAt.getTime()},
          'rule-1', 'triggered', 'normal', 'sent', 'notification-1', '{}',
          1, ${eventAt.getTime()}, ${acceptedAt.getTime()}
        )
      `);
      ensureSchema(handle.db);
      ensureSchema(handle.db);
      expect(await handle.repos.watchTrigger.findById('legacy-not-null')).toMatchObject({
        alertPlanId: 'plan-1',
        deliveryAttempts: 1,
        lastDeliveryAttemptAt: eventAt,
        deliveryCompletedAt: acceptedAt,
      });
      const quoteColumns = handle.db.all<{ name: string; notnull: number }>(
        sql`PRAGMA table_info(watch_triggers)`,
      );
      expect(quoteColumns.find((column) => column.name === 'quote_close')?.notnull).toBe(0);
    } finally {
      handle.close();
    }
  });

  it('旧报告按周期唯一索引升级为版本索引，保留原报告且迁移幂等', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      await handle.repos.report.upsertForPeriod(makeReport('legacy-report'));
      handle.db.run(sql`DROP INDEX reports_period_version_unique`);
      handle.db.run(sql`ALTER TABLE reports DROP COLUMN supersedes_report_id`);
      handle.db.run(sql`ALTER TABLE reports DROP COLUMN version`);
      handle.db.run(sql`ALTER TABLE reports DROP COLUMN delivery_attempt_id`);
      handle.db.run(sql`
        CREATE UNIQUE INDEX reports_period_unique
        ON reports (kind, scope_key, period_start, period_end)
      `);

      ensureSchema(handle.db);
      ensureSchema(handle.db);
      const original = await handle.repos.report.findById('legacy-report');
      expect(original?.version).toBe(1);
      expect(
        handle.db.all<{ name: string }>(sql`PRAGMA table_info(reports)`).map((row) => row.name),
      ).toContain('delivery_attempt_id');
      const supplement = await handle.repos.report.upsertForPeriod(
        makeReport('supplement-report', { version: 2, supersedesReportId: 'legacy-report' }),
      );
      expect(supplement.version).toBe(2);
      expect((await handle.repos.report.findById('legacy-report'))?.id).toBe('legacy-report');
    } finally {
      handle.close();
    }
  });

  it('两个独立进程并发发布同一收盘报告版本时保留唯一主版与补充版', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'luoome-report-concurrency-'));
    const dbPath = join(directory, 'reports.sqlite');
    createDrizzleRepos(dbPath).close();
    const script = `
      import { createDrizzleRepos } from ${JSON.stringify(new URL('./client.ts', import.meta.url).pathname)};
      import { ReportSchema } from '@luoome/core';
      const handle = createDrizzleRepos(process.env.REPORT_CONCURRENCY_DB);
      try {
        const report = ReportSchema.parse(JSON.parse(process.env.REPORT_CONCURRENCY_INPUT));
        const saved = await handle.repos.report.upsertForPeriod(report);
        console.log(JSON.stringify({ id: saved.id, version: saved.version }));
      } finally { handle.close(); }
    `;
    const publish = async (report: ReturnType<typeof makeReport>) => {
      const child = Bun.spawn([process.execPath, '-e', script], {
        // Bun -e 从 cwd 解析 workspace 包；子进程需在 db package 根目录运行。
        cwd: new URL('../', import.meta.url).pathname,
        env: {
          ...process.env,
          REPORT_CONCURRENCY_DB: dbPath,
          REPORT_CONCURRENCY_INPUT: JSON.stringify(report),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as {
        id: string;
        version: number;
      };
    };
    try {
      const [mainA, mainB] = await Promise.all([
        publish(makeReport('main-a')),
        publish(makeReport('main-b')),
      ]);
      expect(mainA).toEqual(mainB);
      expect(mainA.version).toBe(1);

      const [supplementA, supplementB] = await Promise.all([
        publish(makeReport('supplement-a', { version: 2, supersedesReportId: mainA.id })),
        publish(makeReport('supplement-b', { version: 2, supersedesReportId: mainA.id })),
      ]);
      expect(supplementA).toEqual(supplementB);
      expect(supplementA.version).toBe(2);

      const handle = createDrizzleRepos(dbPath);
      try {
        expect(
          (await handle.repos.report.list({ kind: 'closing' })).map((item) => item.version),
        ).toEqual([2, 1]);
        expect((await handle.repos.report.findById(mainA.id))?.version).toBe(1);
      } finally {
        handle.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('两个独立进程只能领取同一报告的一次通知投递', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'luoome-report-delivery-'));
    const dbPath = join(directory, 'reports.sqlite');
    const handle = createDrizzleRepos(dbPath);
    await handle.repos.report.upsertForPeriod(makeReport('delivery-race'));
    handle.close();
    const script = `
      import { createDrizzleRepos } from ${JSON.stringify(new URL('./client.ts', import.meta.url).pathname)};
      const handle = createDrizzleRepos(process.env.REPORT_DELIVERY_DB);
      try {
        const now = new Date('2026-07-03T01:00:00.000Z');
        const claimed = await handle.repos.report.claimDelivery({
          id: 'delivery-race', attemptId: process.env.REPORT_DELIVERY_ATTEMPT, now,
          stalePendingBefore: new Date(now.getTime() - 300000),
          failedRetryBefore: new Date(now.getTime() - 900000),
        });
        console.log(JSON.stringify({ claimed }));
      } finally { handle.close(); }
    `;
    const claim = async (attemptId: string): Promise<boolean> => {
      const child = Bun.spawn([process.execPath, '-e', script], {
        cwd: new URL('../', import.meta.url).pathname,
        env: {
          ...process.env,
          REPORT_DELIVERY_DB: dbPath,
          REPORT_DELIVERY_ATTEMPT: attemptId,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      return (JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { claimed: boolean }).claimed;
    };
    try {
      const results = await Promise.all([claim('worker-a'), claim('worker-b')]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const reopened = createDrizzleRepos(dbPath);
      try {
        expect((await reopened.repos.report.findById('delivery-race'))?.deliveryStatus).toBe(
          'pending',
        );
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ResearchIndex 以 document 粒度写入 FTS5，并可降级 metadata 检索', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const now = new Date('2026-08-01T00:00:00.000Z');
      await handle.repos.researchIndex.applyIndexBatch({
        vaultId: 'vault-fts',
        completeness: 'complete',
        documents: [
          {
            id: 'doc_fts',
            title: 'Revenue report',
            kind: 'report',
            importedAt: now,
            tags: ['earnings'],
            stockCodes: ['600519.SH'],
            vaultId: 'vault-fts',
            relativePath: 'Research/revenue.md',
            attachmentPaths: [],
            contentHash: 'a'.repeat(64),
            excerpt: 'Revenue growth',
            fileModifiedAt: now,
            indexedAt: now,
            availability: 'available',
          },
        ],
        contents: { doc_fts: 'Revenue growth remains strong' },
        seenDocumentIds: new Set(['doc_fts']),
        indexedAt: now,
      });
      expect(handle.repos.researchIndex.searchCapability()).toBe('fts');
      const hits = await handle.repos.researchIndex.searchDocuments({ text: 'Revenue' });
      expect(hits[0]).toMatchObject({ document: { id: 'doc_fts' } });
      expect(hits[0]?.snippet).toContain('Revenue');
      expect(await handle.repos.researchIndex.listStockCodes()).toEqual(['600519.SH']);
      handle.db.run(sql`DROP TABLE research_document_fts`);
      const fallback = await handle.repos.researchIndex.searchDocuments({ text: 'Revenue' });
      expect(fallback[0]).toMatchObject({ document: { id: 'doc_fts' } });
      expect(handle.repos.researchIndex.searchCapability()).toBe('metadata');
    } finally {
      handle.close();
    }
  });

  it('旧 chunk 行 FTS 投影在启动时重建为 document 行且不丢权威文档', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'luoome-research-fts-'));
    const dbPath = join(directory, 'research.sqlite');
    try {
      const first = createDrizzleRepos(dbPath);
      const now = new Date('2026-08-01T00:00:00.000Z');
      await first.repos.researchIndex.applyIndexBatch({
        vaultId: 'vault-legacy',
        completeness: 'complete',
        documents: [
          {
            id: 'doc_legacy',
            title: '渠道库存',
            kind: 'note',
            importedAt: now,
            tags: [],
            stockCodes: [],
            vaultId: 'vault-legacy',
            relativePath: 'Research/legacy.md',
            attachmentPaths: [],
            contentHash: 'b'.repeat(64),
            fileModifiedAt: now,
            indexedAt: now,
            availability: 'available',
          },
        ],
        contents: { doc_legacy: '旧正文' },
        seenDocumentIds: new Set(['doc_legacy']),
        indexedAt: now,
      });
      first.db.run(sql`DROP TABLE research_document_fts`);
      first.db.run(
        sql`CREATE VIRTUAL TABLE research_document_fts USING fts5(document_id UNINDEXED, ordinal UNINDEXED, content_hash UNINDEXED, title, heading_path, body, tokenize='unicode61')`,
      );
      first.close();

      const reopened = createDrizzleRepos(dbPath);
      try {
        const columns = reopened.db
          .all<{ name: string }>(sql`PRAGMA table_info(research_document_fts)`)
          .map((column) => column.name);
        expect(columns).toContain('relative_path');
        expect(columns).not.toContain('ordinal');
        expect(await reopened.repos.researchIndex.findDocument('doc_legacy')).toMatchObject({
          title: '渠道库存',
          availability: 'available',
        });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('createDrizzleRepos(:memory:) 自动建表，repos 可读写，close 正常', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const account = makeAccount('acc-1');
      await handle.repos.account.save(account);
      expect(await handle.repos.account.findById('acc-1')).toEqual(account);
      // db 句柄也可直接查询（表确实存在）
      const rows = handle.db.select().from(accounts).all();
      expect(rows).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('ensureSchema 幂等：重复执行不报错，已有数据保留', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      await handle.repos.account.save(makeAccount('acc-1'));
      ensureSchema(handle.db);
      ensureSchema(handle.db);
      expect(await handle.repos.account.findById('acc-1')).not.toBeNull();
    } finally {
      handle.close();
    }
  });

  it('旧 advice_outcomes 表启动迁移补齐 Outcome 字段并保留存量数据', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Database } = await import('bun:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-advice-outcome-migration-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      const sqlite = new Database(dbPath);
      sqlite.exec(`
        CREATE TABLE advice_outcomes (
          advice_id TEXT PRIMARY KEY,
          outcome TEXT NOT NULL,
          pnl REAL,
          benchmark_pnl REAL,
          recorded_at INTEGER NOT NULL
        );
        INSERT INTO advice_outcomes
          (advice_id, outcome, pnl, benchmark_pnl, recorded_at)
        VALUES ('legacy-advice', 'followed', 12.5, 8.5, 1782748800000);
      `);
      sqlite.close();

      const handle = createDrizzleRepos(dbPath);
      try {
        const columns = handle.db
          .all<{ name: string }>(sql`PRAGMA table_info(advice_outcomes)`)
          .map((column) => column.name);
        expect(columns).toEqual([
          'advice_id',
          'outcome',
          'pnl',
          'benchmark_pnl',
          'recorded_at',
          'trade_ids',
          'holding_hours',
          'notes',
        ]);
        expect(await handle.repos.advice.findOutcome('legacy-advice')).toMatchObject({
          adviceId: 'legacy-advice',
          tradeIds: [],
          outcome: 'followed',
          pnl: 12.5,
          benchmarkPnl: 8.5,
        });
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧 advices 表启动迁移补齐交易计划消费字段并保留幂等读写', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      handle.db.run(sql`ALTER TABLE advices DROP COLUMN entry_price`);
      handle.db.run(sql`ALTER TABLE advices DROP COLUMN entry_price_low`);
      handle.db.run(sql`ALTER TABLE advices DROP COLUMN entry_price_high`);
      handle.db.run(sql`ALTER TABLE advices DROP COLUMN target_position_pct`);
      handle.db.run(sql`ALTER TABLE advices DROP COLUMN target_price`);
      handle.db.run(sql`ALTER TABLE advices DROP COLUMN stop_loss`);
      ensureSchema(handle.db);
      ensureSchema(handle.db);

      const columns = handle.db
        .all<{ name: string }>(sql`PRAGMA table_info(advices)`)
        .map((column) => column.name);
      expect(columns).toEqual(
        expect.arrayContaining([
          'entry_price',
          'entry_price_low',
          'entry_price_high',
          'target_position_pct',
          'target_price',
          'stop_loss',
        ]),
      );

      await handle.repos.advice.save(
        makeAdvice('legacy-advice-plan-fields', {
          entryPrice: money(102),
          entryPriceLow: money(100),
          entryPriceHigh: money(105),
          targetPositionPct: 10,
          targetPrice: money(120),
          stopLoss: money(95),
        }),
      );
      expect(await handle.repos.advice.findById('legacy-advice-plan-fields')).toMatchObject({
        entryPrice: 102,
        entryPriceLow: 100,
        entryPriceHigh: 105,
        targetPositionPct: 10,
        targetPrice: 120,
        stopLoss: 95,
      });
    } finally {
      handle.close();
    }
  });

  it('Drizzle schema 与 ensureSchema 的实际 SQLite 列和索引保持一致', () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const drizzleTableMarker = Symbol.for('drizzle:IsDrizzleTable');
      const tables = Object.entries(schema).filter(
        ([, value]) =>
          value !== null &&
          typeof value === 'object' &&
          (value as Record<PropertyKey, unknown>)[drizzleTableMarker] === true,
      );
      expect(tables.length).toBeGreaterThanOrEqual(38);
      for (const [exportName, table] of tables) {
        const config = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
        const quotedTable = JSON.stringify(config.name);
        const actualColumns = handle.db
          .all<{ name: string }>(sql.raw(`PRAGMA table_info(${quotedTable})`))
          .map((row) => row.name);
        const expectedColumns = Object.values(config.columns).map((column) => column.name);
        expect(actualColumns, `${exportName} columns`).toEqual(expectedColumns);

        const actualIndexes = handle.db
          .all<{ name: string }>(sql.raw(`PRAGMA index_list(${quotedTable})`))
          .map((row) => row.name);
        for (const index of config.indexes) {
          if (index.config.name === undefined) continue;
          expect(actualIndexes, `${exportName} index ${index.config.name}`).toContain(
            index.config.name,
          );
        }
      }
    } finally {
      handle.close();
    }
  });

  it('存量 strategy_results 幂等搬入 strategy_runs.results_json，旧表保留不 DROP', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      handle.db.run(sql`CREATE TABLE IF NOT EXISTS strategy_results (
        run_id TEXT NOT NULL, stock_id TEXT NOT NULL, selected INTEGER NOT NULL,
        score REAL, rank INTEGER, rule_evaluations_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL, data_as_of INTEGER NOT NULL,
        PRIMARY KEY (run_id, stock_id)
      )`);
      handle.db.run(sql`INSERT INTO strategy_runs (
        id, strategy_id, strategy_version_id, mode, coverage, data_as_of, started_at,
        finished_at, status, scope, input_snapshot_json, provider_statuses_json, summary_json
      ) VALUES (
        'legacy-results-run', 'legacy-strategy', 'legacy-v1', 'scan', 'CN_A_SHARES_SH_SZ',
        1782748800000, 1782748800000, 1782748800000, 'complete', 'operational',
        '{"schemaVersion":2,"strategyVersionId":"legacy-v1","definitionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evaluatorVersion":"test","coverage":"CN_A_SHARES_SH_SZ","stockIds":["600519.SH"],"stockIdChecksum":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requestedBy":"manual"}',
        '[]', NULL
      )`);
      handle.db.run(sql`INSERT INTO strategy_results VALUES (
        'legacy-results-run', '600519.SH', 1, 50, 1,
        '[{"ruleId":"rule-1","status":"matched","value":true,"evidence":["legacy"]}]',
        '["legacy"]', 1782748800000
      )`);
      ensureSchema(handle.db);
      ensureSchema(handle.db);
      expect(
        handle.db.get(sql`SELECT name FROM sqlite_master WHERE name='strategy_results'`),
      ).toBeDefined();
      const results = await handle.repos.strategyRun.listResults('legacy-results-run');
      expect(results).toMatchObject([
        { runId: 'legacy-results-run', stockId: '600519.SH', selected: true, score: 50, rank: 1 },
      ]);
      expect(results[0]?.ruleEvaluations).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('存量明文 results_json 压缩迁移幂等，且明细不丢', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      handle.db.run(sql`
        INSERT INTO strategy_runs (
          id, strategy_id, strategy_version_id, mode, coverage, data_as_of, started_at,
          finished_at, status, scope, input_snapshot_json, provider_statuses_json, results_json
        ) VALUES (
          'legacy-plain-run', 'legacy-strategy', 'legacy-v1', 'scan', 'CN_A_SHARES_SH_SZ',
          1782748800000, 1782748800000, 1782748800000, 'complete', 'operational',
          '{"schemaVersion":2,"strategyVersionId":"legacy-v1","definitionHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","evaluatorVersion":"test","coverage":"CN_A_SHARES_SH_SZ","stockIds":["600519.SH"],"stockIdChecksum":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","requestedBy":"manual"}',
          '[]',
          ${JSON.stringify([
            {
              runId: 'legacy-plain-run',
              stockId: '600519.SH',
              selected: true,
              score: 50,
              rank: 1,
              ruleEvaluations: [
                { ruleId: 'rule-1', status: 'matched', value: true, evidence: ['legacy'] },
              ],
              evidence: ['legacy'],
              dataAsOf: new Date(1782748800000).toISOString(),
            },
          ])}
        )
      `);
      // 模拟存量库：迁移标记尚未写入。
      handle.db.run(sql`DELETE FROM schema_migrations WHERE id = 'strategy-run-results-zlib-v1'`);

      ensureSchema(handle.db);
      ensureSchema(handle.db);

      const raw = handle.db.all<{ results_json: string }>(
        sql`SELECT results_json FROM strategy_runs WHERE id = 'legacy-plain-run'`,
      )[0];
      expect(raw?.results_json.startsWith('zlib+base64:')).toBe(true);
      const results = await handle.repos.strategyRun.listResults('legacy-plain-run');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ stockId: '600519.SH', score: 50 });
      expect(results[0]?.ruleEvaluations).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('存量 strategy_signals 改为 64 位整数 id，并同步改写观察引用', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      handle.db.run(sql`DROP TABLE strategy_signals`);
      handle.db.run(sql`CREATE TABLE strategy_signals (
        id TEXT PRIMARY KEY, strategy_id TEXT NOT NULL, strategy_version_id TEXT NOT NULL,
        run_id TEXT NOT NULL, rule_id TEXT NOT NULL, stock_id TEXT NOT NULL, ts INTEGER NOT NULL,
        score REAL NOT NULL, direction TEXT NOT NULL, evidence_json TEXT NOT NULL,
        evaluation_snapshot_json TEXT NOT NULL
      )`);
      handle.db.run(sql`
        CREATE UNIQUE INDEX strategy_signals_run_event_unique
        ON strategy_signals (run_id, rule_id, stock_id, ts)
      `);
      const ts = 1782748800000;
      const oldId = `strategy-run-legacy:entry:600519.SH:${new Date(ts).toISOString()}`;
      handle.db.run(sql`INSERT INTO strategy_signals VALUES (
        ${oldId}, 'legacy-strategy', 'legacy-v1', 'strategy-run-legacy', 'entry', '600519.SH',
        ${ts}, 80, 'bullish', '["价格有效"]', '{"expression":"quote.close > 0","result":true}'
      )`);
      handle.db.run(sql`INSERT INTO signal_observations (
        source_kind, source_id, stock_id, horizon, benchmark_status, status, provenance, attempt_count
      ) VALUES (
        'strategy-signal', ${oldId}, '600519.SH', 't1', 'unavailable', 'pending',
        '{"provider":"fixture","observedAt":1782748800000,"fetchedAt":1782748800000,"freshness":"unknown"}',
        0
      )`);
      handle.db.run(sql`DELETE FROM schema_migrations WHERE id = 'strategy-signal-int64-id-v1'`);

      ensureSchema(handle.db);
      ensureSchema(handle.db);

      const signals = handle.db.all<{ id: string; evidence_json: string }>(
        sql`SELECT id, evidence_json FROM strategy_signals`,
      );
      expect(signals).toHaveLength(1);
      expect(signals[0]?.id).toMatch(/^\d{18,19}$/);
      expect(signals[0]?.evidence_json.startsWith('zlib+base64:')).toBe(false);
      expect(JSON.parse(signals[0]?.evidence_json ?? '[]')).toEqual(['价格有效']);

      const decoded = await handle.repos.strategyRun.signalsByRun('strategy-run-legacy');
      expect(decoded).toHaveLength(1);
      expect(decoded[0]?.id).toBe(signals[0]?.id);
      expect(decoded[0]?.evidence).toEqual(['价格有效']);
      expect(decoded[0]?.evaluationSnapshot).toEqual({
        expression: 'quote.close > 0',
        result: true,
      });

      const observations = handle.db.all<{ source_id: string }>(
        sql`SELECT source_id FROM signal_observations`,
      );
      expect(observations).toEqual([{ source_id: signals[0]?.id }]);
    } finally {
      handle.close();
    }
  });

  it('存量 rowid 形态的 signal_observations 重建为 WITHOUT ROWID 并保留数据', () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      handle.db.run(sql`DROP TABLE signal_observations`);
      handle.db.run(sql`CREATE TABLE signal_observations (
        id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, stock_id TEXT NOT NULL,
        baseline_price REAL, baseline_at INTEGER, horizon TEXT NOT NULL, close_price REAL, return_pct REAL,
        max_favorable_excursion_pct REAL, max_adverse_excursion_pct REAL, benchmark_return_pct REAL,
        benchmark_status TEXT NOT NULL, status TEXT NOT NULL, provenance TEXT NOT NULL,
        unavailable_reason TEXT, observed_at INTEGER, due_at INTEGER,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER,
        next_attempt_at INTEGER, last_error_kind TEXT, vintage TEXT NOT NULL DEFAULT 'pit'
      )`);
      handle.db.run(sql`
        CREATE INDEX signal_observations_source_idx
        ON signal_observations (source_kind, source_id)
      `);
      handle.db.run(sql`INSERT INTO signal_observations (
        id, source_kind, source_id, stock_id, horizon, benchmark_status, status, provenance,
        attempt_count, vintage
      ) VALUES (
        'obs-1', 'strategy-signal', 'sig-1', '600519.SH', 't1', 'unavailable', 'pending',
        '{"source":"local"}', 2, 'pit'
      )`);

      ensureSchema(handle.db);
      ensureSchema(handle.db);

      const ddl =
        handle.db.all<{ sql: string }>(
          sql`SELECT sql FROM sqlite_master WHERE type='table' AND name='signal_observations'`,
        )[0]?.sql ?? '';
      expect(ddl).toContain('WITHOUT ROWID');
      expect(ddl).not.toContain('vintage');
      expect(ddl).toContain('PRIMARY KEY (source_kind, source_id, horizon)');
      expect(
        handle.db.all<{ source_id: string; horizon: string; attempt_count: number }>(
          sql`SELECT source_id, horizon, attempt_count FROM signal_observations`,
        ),
      ).toEqual([{ source_id: 'sig-1', horizon: 't1', attempt_count: 2 }]);
    } finally {
      handle.close();
    }
  });

  it('存量 qfq 日线按累计因子还原为原始价，读取时再投影回 qfq', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      // 一根 qfq 收盘 11、因子 0.5 的存量行：还原后原始价应为 22。
      handle.db.run(sql`
        INSERT INTO daily_bars (
          stock_id, date, open, high, low, close, volume, adj_factor, adjustment,
          source_adj_factor, source
        ) VALUES (
          '600519.SH', 1782748800000, 10, 12, 9, 11, 1000, 1, 'qfq', 0.5, 'legacy'
        )
      `);
      handle.db.run(sql`
        INSERT INTO adjustment_factors (
          stock_id, ex_date, factor, dividend_per_share, per_share_bonus,
          allotment_ratio, allotment_price, source
        ) VALUES ('600519.SH', 1790000000000, 0.5, 1, 0, 0, 0, 'fuyao')
      `);
      handle.db.run(sql`DELETE FROM schema_migrations WHERE id = 'daily-bars-raw-v1'`);

      ensureSchema(handle.db);
      ensureSchema(handle.db);

      const raw = handle.db.all<{
        close: number;
        adjustment: string;
        source_adj_factor: number | null;
      }>(
        sql`SELECT close, adjustment, source_adj_factor FROM daily_bars WHERE stock_id = '600519.SH'`,
      )[0];
      expect(raw?.adjustment).toBe('raw');
      expect(raw?.source_adj_factor).toBeNull();
      expect(raw?.close).toBeCloseTo(22, 6);

      // 读边界投影回 qfq：22 × 0.5 = 11
      const bars = await handle.repos.dailyBar.findInRange(
        '600519.SH',
        new Date(1782748800000),
        new Date(1782748800000),
      );
      expect(bars[0]?.close).toBeCloseTo(11, 6);
      expect(bars[0]?.adjustment).toBe('qfq');
    } finally {
      handle.close();
    }
  });

  it('无 source_adj_factor 的存量 qfq 行不冒充原始价，保持原值可读', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      // 旧 provider（fuyao/东财等）只给 qfq 价格，不带因子；无法精确还原。
      handle.db.run(sql`
        INSERT INTO daily_bars (
          stock_id, date, open, high, low, close, volume, adj_factor, adjustment,
          source_adj_factor, source
        ) VALUES (
          '600519.SH', 1782748800000, 10, 12, 9, 11, 1000, 1, 'qfq', NULL, 'fuyao'
        )
      `);
      handle.db.run(sql`
        INSERT INTO adjustment_factors (
          stock_id, ex_date, factor, dividend_per_share, per_share_bonus,
          allotment_ratio, allotment_price, source
        ) VALUES ('600519.SH', 1790000000000, 0.5, 1, 0, 0, 0, 'fuyao')
      `);
      handle.db.run(sql`DELETE FROM schema_migrations WHERE id = 'daily-bars-raw-v1'`);

      ensureSchema(handle.db);
      ensureSchema(handle.db);

      const stored = handle.db.all<{ close: number; adjustment: string }>(
        sql`SELECT close, adjustment FROM daily_bars WHERE stock_id = '600519.SH'`,
      )[0];
      // 未除以未知因子：行仍是 qfq，投影也不会再次乘因子。
      expect(stored).toEqual({ close: 11, adjustment: 'qfq' });
      const bars = await handle.repos.dailyBar.findInRange(
        '600519.SH',
        new Date(1782748800000),
        new Date(1782748800000),
      );
      expect(bars[0]?.close).toBeCloseTo(11, 6);
    } finally {
      handle.close();
    }
  });

  it('已退役的 fundamental 管线表与三段账本旧表不再由启动迁移创建', () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      ensureSchema(handle.db);
      const names = handle.db
        .all<{ name: string }>(
          sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (
            'financial_fact_revisions',
            'fundamental_score_versions',
            'fundamental_score_runs',
            'fundamental_score_results',
            'holding_cash_adjustments',
            'portfolio_cash_flows',
            'portfolio_corporate_actions',
            'strategy_results',
            'stock_universe_snapshot_members',
            'watchlist_sync_runs',
            'membership_snapshots'
          )`,
        )
        .map((row) => row.name);
      expect(names).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('旧 builtin Strategy 在启动迁移中转为可编辑、可删除的 user 实例', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      handle.db.run(sql`
        INSERT INTO strategies (
          id, name, description, owner, status, current_version_id, created_at, updated_at
        ) VALUES (
          'legacy-builtin', '旧模板策略', '历史误播种数据', 'builtin', 'draft', NULL, 1, 1
        )
      `);
      ensureSchema(handle.db);
      expect(await handle.repos.strategy.findById('legacy-builtin')).toMatchObject({
        owner: 'user',
      });
    } finally {
      handle.close();
    }
  });

  it('旧 strategy_schedules 表在启动迁移中幂等回填 schedule_cron 与 last_scheduled_at', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      handle.db.run(sql`
        CREATE TABLE IF NOT EXISTS strategy_schedules (
          id TEXT PRIMARY KEY,
          strategy_id TEXT NOT NULL,
          cron TEXT NOT NULL,
          timezone TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          next_run_at INTEGER,
          last_run_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      handle.db.run(sql`
        INSERT INTO strategies (
          id, name, description, owner, status, current_version_id, created_at, updated_at
        ) VALUES (
          'test-strat-1', '测试策略1', '描述', 'user', 'active', 'v1', 1000, 1000
        )
      `);
      handle.db.run(sql`
        INSERT INTO strategy_runs (
          id, strategy_id, strategy_version_id, mode, coverage, data_as_of, started_at, status, input_snapshot_json, provider_statuses_json
        ) VALUES (
          'run-123', 'test-strat-1', 'v1', 'scheduled', 'all', 1700000000000, 1700000001000, 'complete', '{}', '[]'
        )
      `);
      handle.db.run(sql`
        INSERT INTO strategy_schedules (
          id, strategy_id, cron, timezone, enabled, next_run_at, last_run_id, created_at, updated_at
        ) VALUES (
          'sched-1', 'test-strat-1', '0 18 * * 1-5', 'Asia/Shanghai', 1, 1700000000000, 'run-123', 1000, 1000
        )
      `);
      ensureSchema(handle.db);
      const strat = await handle.repos.strategy.findById('test-strat-1');
      expect(strat).toMatchObject({
        scheduleCron: '0 18 * * 1-5',
        lastScheduledAt: new Date(1700000001000),
      });

      // 再次执行，幂等
      ensureSchema(handle.db);
      const strat2 = await handle.repos.strategy.findById('test-strat-1');
      expect(strat2).toMatchObject({
        scheduleCron: '0 18 * * 1-5',
        lastScheduledAt: new Date(1700000001000),
      });
    } finally {
      handle.close();
    }
  });

  it('策略信号索引迁移保留同一 replay run 的不同时点事实', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Database } = await import('bun:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-signal-index-migration-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      const sqlite = new Database(dbPath);
      sqlite.exec(`
        CREATE TABLE strategy_signals (
          id TEXT PRIMARY KEY,
          strategy_id TEXT NOT NULL,
          strategy_version_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          rule_id TEXT NOT NULL,
          stock_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          score REAL NOT NULL,
          direction TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          evaluation_snapshot_json TEXT NOT NULL
        );
        CREATE UNIQUE INDEX strategy_signals_identity_unique
          ON strategy_signals (strategy_version_id, rule_id, stock_id, ts);
        INSERT INTO strategy_signals VALUES
          ('signal-1', 'strategy-1', 'version-1', 'replay-run-1', 'entry', '600519.SH',
           1784821818933, 84, 'bullish', '["first"]', '{"matched":true}'),
          ('signal-2', 'strategy-1', 'version-1', 'replay-run-1', 'entry', '600519.SH',
           1784970090970, 86, 'bullish', '["second"]', '{"matched":true}');
      `);
      sqlite.close();

      const handle = createDrizzleRepos(dbPath);
      expect(await handle.repos.strategyRun.signalsByRun('replay-run-1')).toHaveLength(2);
      handle.close();

      const migrated = new Database(dbPath, { readonly: true });
      expect(
        migrated
          .query('PRAGMA index_info(strategy_signals_run_event_unique)')
          .all()
          .map((column) => (column as { name: string }).name),
      ).toEqual(['run_id', 'rule_id', 'stock_id', 'ts']);
      migrated.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('文件库：写入后重开数据仍在', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-db-test-'));
    const dbPath = path.join(dir, 'test.sqlite');
    try {
      const h1 = createDrizzleRepos(dbPath);
      await h1.repos.account.save(makeAccount('acc-persist'));
      await h1.repos.report.upsertForPeriod(makeReport('report-persist'));
      h1.close();

      const h2 = createDrizzleRepos(dbPath);
      expect(await h2.repos.account.findById('acc-persist')).not.toBeNull();
      expect((await h2.repos.report.findById('report-persist'))?.title).toBe(
        '收盘复盘-report-persist',
      );
      h2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧版 price_snapshots(ts) 幂等迁移为双时间并保留数据', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Database } = await import('bun:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-quote-migration-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      const sqlite = new Database(dbPath);
      sqlite.exec(`
        CREATE TABLE price_snapshots (
          stock_id TEXT NOT NULL,
          ts INTEGER NOT NULL,
          open REAL NOT NULL,
          high REAL NOT NULL,
          low REAL NOT NULL,
          close REAL NOT NULL,
          volume INTEGER NOT NULL,
          source TEXT NOT NULL,
          PRIMARY KEY (stock_id, ts)
        );
        INSERT INTO price_snapshots
          (stock_id, ts, open, high, low, close, volume, source)
        VALUES
          ('600519.SH', 1784591400000, 100, 101, 99, 100.5, 1234, 'legacy');
      `);
      sqlite.close();

      const handle = createDrizzleRepos(dbPath);
      const migrated = await handle.repos.quote.latestByStock('600519.SH');
      expect(migrated).toMatchObject({
        stockId: '600519.SH',
        timestampSource: 'retrieval',
        source: 'legacy',
        close: 100.5,
      });
      expect(migrated?.observedAt.getTime()).toBe(1784591400000);
      expect(migrated?.fetchedAt.getTime()).toBe(1784591400000);
      ensureSchema(handle.db);
      expect(
        await handle.repos.quote.listInRange('600519.SH', new Date(0), new Date(8.64e15)),
      ).toHaveLength(1);
      handle.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('旧版 price_snapshots 幂等补齐成交与估值列并保留数据', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Database } = await import('bun:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-quote-amount-migration-'));
    const dbPath = path.join(dir, 'legacy.sqlite');
    try {
      const sqlite = new Database(dbPath);
      sqlite.exec(`
        CREATE TABLE price_snapshots (
          stock_id TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          fetched_at INTEGER NOT NULL,
          timestamp_source TEXT NOT NULL,
          open REAL NOT NULL,
          high REAL NOT NULL,
          low REAL NOT NULL,
          close REAL NOT NULL,
          volume INTEGER NOT NULL,
          prev_close REAL,
          source TEXT NOT NULL,
          CONSTRAINT price_snapshots_pk PRIMARY KEY (stock_id, observed_at, source)
        );
        INSERT INTO price_snapshots
          (stock_id, observed_at, fetched_at, timestamp_source, open, high, low, close, volume, prev_close, source)
        VALUES
          ('600519.SH', 1784591400000, 1784591400000, 'retrieval', 100, 101, 99, 100.5, 1234, 100, 'legacy');
      `);
      sqlite.close();

      const handle = createDrizzleRepos(dbPath);
      const cols = handle.db
        .all<{ name: string }>(sql`PRAGMA table_info(price_snapshots)`)
        .map((c) => c.name);
      expect(cols).toContain('amount');
      expect(cols).toContain('turnover_rate');
      expect(cols).toContain('total_market_cap');
      expect(cols).toContain('float_market_cap');
      expect(cols).toContain('pe_ttm');
      expect(cols).toContain('ps_ttm');
      expect(cols).toContain('pb');
      const migrated = await handle.repos.quote.latestByStock('600519.SH');
      expect(migrated).toMatchObject({ stockId: '600519.SH', source: 'legacy', close: 100.5 });
      expect(migrated?.amount).toBeUndefined();
      expect(migrated?.turnoverRatePct).toBeUndefined();
      expect(migrated?.totalMarketCap).toBeUndefined();
      expect(migrated?.peTtm).toBeUndefined();
      ensureSchema(handle.db); // 再跑一次幂等
      expect(
        await handle.repos.quote.listInRange('600519.SH', new Date(0), new Date(8.64e15)),
      ).toHaveLength(1);
      handle.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('旧 accounts 表启动迁移补 cash_balance 并按本金回填（幂等）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'luoome-accounts-cash-'));
    const dbPath = join(dir, 'legacy.sqlite');
    try {
      // 1) 手工造一张没有 cash_balance 的旧表（模拟 v0.7 及更早的库）
      const legacy = new Database(dbPath);
      legacy.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          currency TEXT NOT NULL,
          initial_capital REAL NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      legacy
        .query(
          `INSERT INTO accounts (id, name, kind, currency, initial_capital, created_at) VALUES (?,?,?,?,?,?)`,
        )
        .run('legacy-acc', '旧账户', 'real', 'CNY', 250000, 1750000000000);
      legacy.close();

      // 2) ensureSchema 自动补列并按本金回填
      const handle = createDrizzleRepos(dbPath);
      const account = await handle.repos.account.findById('legacy-acc');
      expect(account).toMatchObject({ initialCapital: 250000, cashBalance: 250000 });
      ensureSchema(handle.db); // 幂等：再跑一次不重复加列、不覆盖已有余额
      await handle.repos.account.save({
        ...(account as NonNullable<typeof account>),
        cashBalance: money(180_000),
      });
      ensureSchema(handle.db);
      expect((await handle.repos.account.findById('legacy-acc'))?.cashBalance).toBe(180_000);
      handle.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('现金迁移重放已有交易、流水与手工持仓成本，且重复启动不重复扣款', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      await handle.repos.account.save(makeAccount('acc-1', { initialCapital: money(100000) }));
      await handle.repos.trade.save(
        makeTrade('buy', { quantity: quantity(100), price: money(10) }),
      );
      await handle.repos.holding.save(
        makeHolding('held', { quantity: 100, availableQuantity: 100, avgCost: money(10) }),
      );
      await handle.repos.holding.save(
        makeHolding('manual', {
          stockId: 'manual-stock',
          quantity: 200,
          availableQuantity: 200,
          avgCost: money(10),
        }),
      );
      await handle.repos.portfolioCashFlow.save({
        id: 'deposit',
        accountId: 'acc-1',
        occurredAt: new Date(),
        kind: 'deposit',
        amount: 500,
        currency: 'CNY',
        source: 'manual',
        createdAt: new Date(),
      });
      handle.db.run(sql`ALTER TABLE accounts DROP COLUMN cash_balance`);
      ensureSchema(handle.db);
      expect((await handle.repos.account.findById('acc-1'))?.cashBalance).toBe(97500);
      ensureSchema(handle.db);
      expect((await handle.repos.account.findById('acc-1'))?.cashBalance).toBe(97500);
    } finally {
      handle.close();
    }
  });

  it('现金迁移失败时回滚列和调整记录，下次启动可以重试', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      await handle.repos.account.save(makeAccount('acc-1', { initialCapital: money(100000) }));
      await handle.repos.holding.save(
        makeHolding('manual', { quantity: 100, availableQuantity: 100, avgCost: money(10) }),
      );
      handle.db.run(sql`ALTER TABLE accounts DROP COLUMN cash_balance`);
      handle.db.run(sql`DROP TABLE account_ledger_entries`);
      handle.db.run(
        sql`CREATE TRIGGER reject_migration BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT, 'test migration failure'); END`,
      );
      expect(() => ensureSchema(handle.db)).toThrow('test migration failure');
      expect(
        handle.db.all<{ name: string }>(sql`PRAGMA table_info(accounts)`).map((row) => row.name),
      ).not.toContain('cash_balance');
      expect(await handle.repos.ledger.listHoldingAdjustments('acc-1')).toHaveLength(0);
      handle.db.run(sql`DROP TRIGGER reject_migration`);
      ensureSchema(handle.db);
      expect((await handle.repos.account.findById('acc-1'))?.cashBalance).toBe(99000);
      expect(await handle.repos.ledger.listHoldingAdjustments('acc-1')).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('两个独立进程写入同一账户，现金与所有入金流水一致', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'luoome-ledger-concurrency-'));
    const dbPath = join(directory, 'ledger.sqlite');
    const handle = createDrizzleRepos(dbPath);
    await handle.repos.account.save(makeAccount('acc-1', { cashBalance: money(1000) }));
    handle.close();
    try {
      const runChild = async (prefix: string) => {
        const script = `
          import { createDrizzleRepos } from ${JSON.stringify(new URL('./client.ts', import.meta.url).pathname)};
          const handle = createDrizzleRepos(${JSON.stringify(dbPath)});
          try {
            for (let i = 0; i < 30; i++) await handle.repos.ledger.applyCashFlow({ flow: {
              id: ${JSON.stringify(prefix)} + i, accountId: 'acc-1', kind: 'deposit', amount: 1,
              currency: 'CNY', source: 'manual', occurredAt: new Date(), createdAt: new Date(),
            }});
          } finally { handle.close(); }
        `;
        const child = Bun.spawn([process.execPath, '-e', script], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        expect(stderr).toBe('');
        expect(code).toBe(0);
      };
      await Promise.all([runChild('a-'), runChild('b-')]);
      const reopened = createDrizzleRepos(dbPath);
      try {
        expect((await reopened.repos.account.findById('acc-1'))?.cashBalance).toBe(1060);
        expect(await reopened.repos.portfolioCashFlow.listByAccount('acc-1')).toHaveLength(60);
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('升级保留旧计划的读取能力，并使旧计划失效', async () => {
    const handle = createDrizzleRepos(':memory:');
    try {
      const plan = makeTradingPlan('legacy', 1, { status: 'active' });
      await handle.repos.tradingPlan.save(plan);
      const { accountFactsAsOf, accountFactsDigest, ...rest } = plan;
      const legacy = JSON.stringify({
        ...rest,
        accountSnapshotId: 'snapshot-old',
        accountSnapshotVersion: 1,
      });
      handle.db.run(sql`UPDATE trading_plans SET plan_json = ${legacy}`);
      ensureSchema(handle.db);
      expect(await handle.repos.tradingPlan.list()).toMatchObject([
        { id: 'legacy', status: 'expired' },
      ]);
      expect(await handle.repos.tradingPlan.list({ activeOnly: true })).toEqual([]);
      ensureSchema(handle.db);
      expect(await handle.repos.tradingPlan.list()).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  it('阶段 C 存量迁移：v0.5 → MVP accounts.kind=mock 自动升级为 real（幂等）', async () => {
    // 1) 手工建 accounts 表 + 灌 3 条 v0.5 旧 mock 行（绕过 repo.save 的 invariant）
    const handle = createDrizzleRepos(':memory:');
    try {
      const TS = 1750000000000;
      handle.db.run(sql`
        INSERT INTO accounts (id, name, kind, currency, initial_capital, created_at)
        VALUES
          ('f47ac10b-58cc-4372-a567-0e02b2c3d479', '默认模拟账户', 'mock', 'CNY', 1000000, ${TS}),
          ('a1b2c3d4-0001-4000-8000-000000000001', '长期持仓', 'mock', 'CNY', 500000, ${TS}),
          ('a1b2c3d4-0001-4000-8000-000000000002', '短线交易', 'mock', 'CNY', 200000, ${TS})
      `);
      // 灌一条新行 kind=real + 一条已迁移行（用于验证幂等不二次回填）
      await handle.repos.account.save(makeAccount('acc-real-1'));
      handle.db.run(sql`
        INSERT INTO accounts (id, name, kind, currency, initial_capital, created_at)
        VALUES ('already-real', '已经迁移', 'real', 'CNY', 100, ${TS})
      `);

      // 2) 直接调用迁移函数（ensureSchema 已经跑过，迁移不依赖它；这里只测函数行为）
      // 复刻 ensureSchema 末尾的迁移调用
      const { sql: sql2 } = await import('drizzle-orm');
      handle.db.run(sql2`UPDATE accounts SET kind = 'real' WHERE kind = 'mock'`);
      // 注：实际生产路径里 ensureSchema 末尾会跑，这里手工调用以验证 SQL 行为
      // 避免通过 client.ts 私有函数耦合。
      // （如要直接调私有函数，需要把 migrateLegacyAccountKinds export，权衡后维持原状。）

      // 3) 全部行应升为 real
      const all = await handle.repos.account.list();
      expect(all).toHaveLength(5);
      expect(all.every((a) => a.kind === 'real')).toBe(true);
      // 旧行 id 保留
      expect(all.find((a) => a.id === 'f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBeDefined();
      expect(all.find((a) => a.id === 'a1b2c3d4-0001-4000-8000-000000000001')).toBeDefined();
      expect(all.find((a) => a.id === 'a1b2c3d4-0001-4000-8000-000000000002')).toBeDefined();

      // 4) 幂等：再跑一次无变化
      handle.db.run(sql2`UPDATE accounts SET kind = 'real' WHERE kind = 'mock'`);
      const all2 = await handle.repos.account.list();
      expect(all2).toHaveLength(5);
      expect(all2.every((a) => a.kind === 'real')).toBe(true);
    } finally {
      handle.close();
    }
  });

  it('阶段 C 集成：createDrizzleRepos 自动跑 migrateLegacyAccountKinds（v0.5 旧库）', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Database } = await import('bun:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luoome-db-legacy-account-'));
    const dbPath = path.join(dir, 'legacy-account.sqlite');
    try {
      // 手工建 accounts 表 + 灌 1 条 kind=mock 旧行
      const sqlite = new Database(dbPath);
      sqlite.exec(`
        CREATE TABLE accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          currency TEXT NOT NULL,
          initial_capital REAL NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      sqlite.exec(`
        INSERT INTO accounts (id, name, kind, currency, initial_capital, created_at)
        VALUES ('f47ac10b-58cc-4372-a567-0e02b2c3d479', '默认模拟账户', 'mock', 'CNY', 1000000, 1750000000000)
      `);
      sqlite.close();

      // 打开 db（createDrizzleRepos 应自动跑 migrateLegacyAccountKinds）
      const handle = createDrizzleRepos(dbPath);
      try {
        const after = await handle.repos.account.list();
        expect(after).toHaveLength(1);
        expect(after[0]?.kind).toBe('real');
        expect(after[0]?.name).toBe('默认模拟账户'); // name 保留
        expect(after[0]?.initialCapital).toBe(1000000); // initialCapital 保留
      } finally {
        handle.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
