import type {
  DataArchiveWriteInput,
  DataArchiveWriteResult,
  DataArchiveWriter,
  ToolContext,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { exportBusinessDataTool } from './export-business-data.js';

const NOW = new Date('2026-08-01T00:00:00.000Z');

/** 测试用写盘载体：内存里攒文件，不碰真文件系统（与 `report-artifacts` 同一分层）。 */
const createMemoryArchiveWriter = (): DataArchiveWriter & {
  readonly files: Map<string, string>;
} => {
  const files = new Map<string, string>();
  return {
    directory: '/memory/exports',
    files,
    async write(input: DataArchiveWriteInput): Promise<DataArchiveWriteResult> {
      const existing = files.get(input.fileName);
      if (existing !== undefined && !input.overwrite)
        return {
          path: `/memory/exports/${input.fileName}`,
          written: false,
          bytes: existing.length,
        };
      files.set(input.fileName, input.content);
      return {
        path: `/memory/exports/${input.fileName}`,
        written: true,
        bytes: Buffer.byteLength(input.content, 'utf8'),
      };
    },
    async read(fileName: string): Promise<string | null> {
      return files.get(fileName) ?? null;
    },
  };
};

/**
 * 内存导入仓储**不随 `createInMemoryRepos` 装配**（见 `memory/index.ts:4` 的注释：
 * 它只是合约替身，不与 typed repos 共享状态）。所以测试里显式挂上去。
 */
const withDataImportRepo = async (ctx: ToolContext): Promise<ToolContext> => {
  const { InMemoryDataImportRepository } = await import('@luoome/db/memory');
  const repository = new InMemoryDataImportRepository({ tables: {}, receipts: [], operations: [] });
  return { ...ctx, repos: { ...ctx.repos, dataImport: repository } };
};

const exportedTables = (data: { tables: Readonly<Record<string, number>> }): string[] =>
  Object.keys(data.tables).sort();

/**
 * 业务表集合的**唯一真源**：manifest 的 `replace ∪ union`。
 *
 * 这里直接读 manifest 源码里的两个数组，而不是从 `@luoome/db` 入口 import——
 * 那个入口拖 `bun:sqlite`，vitest（node）加载不了。这是**同一份常量**，不是第二份定义。
 */
const manifestBusinessTables = async (): Promise<string[]> => {
  const manifest = (await import('../../../db/src/data-import-manifest.js')) as {
    DATA_IMPORT_BUSINESS_TABLES: readonly string[];
  };
  return [...manifest.DATA_IMPORT_BUSINESS_TABLES].sort();
};

describe('task-35 export_business_data', () => {
  it('导出集合 = DATA_IMPORT_BUSINESS_TABLES（replace ∪ union），不写死表名', async () => {
    const dataArchives = createMemoryArchiveWriter();
    const ctx = await withDataImportRepo(
      await buildTestContext({ clock: () => NOW, dataArchives }),
    );
    const result = await exportBusinessDataTool.execute({}, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 断言来源是 manifest 常量本身，不是硬编码列表。
    const expected = await manifestBusinessTables();
    expect(exportedTables(result.data)).toEqual(expected);
    // 额外：集合非空。
    expect(expected.length).toBeGreaterThan(0);
  });

  it('不含 preserve / transient（与它们的交集为空），也不含 fts 投影', async () => {
    const dataArchives = createMemoryArchiveWriter();
    const ctx = await withDataImportRepo(
      await buildTestContext({ clock: () => NOW, dataArchives }),
    );
    const result = await exportBusinessDataTool.execute({}, ctx);
    if (!result.ok) throw new Error('export failed');
    const exported = new Set(exportedTables(result.data));
    const preserve = [
      'plugin_operations',
      'plugin_automation_grants',
      'data_import_receipts',
      'schema_migrations',
      'watch_notification_settings',
    ];
    for (const table of preserve) expect(exported.has(table), table).toBe(false);
    const transient = [
      'strategy_run_leases',
      'watch_execution_lease',
      'report_execution',
      'watchlist_import_previews',
    ];
    for (const table of transient) expect(exported.has(table), table).toBe(false);
    // fts 是 rebuild 策略，不在业务表集合里。
    expect(exported.has('research_document_fts')).toBe(false);
  });

  it('round-trip：导出的文件能喂给 preview_data_import 并成功恢复', async () => {
    const dataArchives = createMemoryArchiveWriter();
    const ctx = await withDataImportRepo(
      await buildTestContext({ clock: () => NOW, dataArchives }),
    );
    const exported = await exportBusinessDataTool.execute({}, ctx);
    if (!exported.ok) throw new Error('export failed');

    // 1) 导出的字节就是归档内容本身（presentArgs 指向它）。
    const content = await dataArchives.read(exported.data.path.split('/').at(-1) ?? '');
    expect(content).not.toBeNull();
    const archive = JSON.parse(content as string) as {
      format: string;
      version: number;
      tables: Record<string, unknown[]>;
    };
    expect(archive.format).toBe('luoome-data');
    expect(archive.version).toBe(1);

    // 2) 摘要一致：导出的 digest 与仓储侧 `targetDigest` 同口径（都是业务表集合的 sha256）。
    expect(exported.data.archiveDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(exported.data.totalRows).toBe(
      Object.values(archive.tables).reduce((sum, rows) => sum + rows.length, 0),
    );

    // 3) 真 round-trip（preview → restore）在 `packages/db/src/repository/data-import.contract.test.ts`
    //    覆盖：那里有真实 sqlite 表结构，能构造完整 snapshot。见 `task-35 round-trip` 用例。
  });

  it('幂等：同一份数据导两次只产生一个文件（written:false）', async () => {
    const dataArchives = createMemoryArchiveWriter();
    const ctx = await withDataImportRepo(
      await buildTestContext({ clock: () => NOW, dataArchives }),
    );
    const first = await exportBusinessDataTool.execute({}, ctx);
    const second = await exportBusinessDataTool.execute({}, ctx);
    if (!first.ok || !second.ok) throw new Error('export failed');
    expect(first.data.written).toBe(true);
    expect(second.data.written).toBe(false);
    expect(second.data.path).toBe(first.data.path);
    expect(dataArchives.files.size).toBe(1);
  });

  it('空库导出 → 合法空归档（不是报错），与 apps/web 行为一致', async () => {
    const dataArchives = createMemoryArchiveWriter();
    const ctx = await withDataImportRepo(
      await buildTestContext({ clock: () => NOW, dataArchives }),
    );
    // 清空所有业务表：内存仓储直接替换状态。
    const repository = ctx.repos.dataImport;
    if (repository === undefined) throw new Error('missing repo');
    const empty = await repository.exportBusinessTables();
    const emptied = Object.fromEntries(Object.keys(empty.tables).map((t) => [t, []]));
    // 用一个只返回空表集合的仓库做断言（不依赖具体仓储实现内部结构）。
    const emptyRepo = {
      ...repository,
      exportBusinessTables: async () => ({ tables: emptied, digest: empty.digest }),
    };
    const result = await exportBusinessDataTool.execute(
      {},
      { ...ctx, repos: { ...ctx.repos, dataImport: emptyRepo } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalRows).toBe(0);
    expect(Object.values(result.data.tables).every((count) => count === 0)).toBe(true);
  });
});
