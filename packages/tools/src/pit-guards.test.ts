import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * REQ-M4-05 的两条**结构性**保证。
 *
 * 这两条的共同点：**失效了在数据上完全看不出来**。
 * - T+1 被绕过 → 数据看起来正常，只是有 ≤1 交易日前视
 * - 层 3 入库 → 数据看起来正常，只是当成了「数据商说什么就是什么」
 *
 * ⇒ 只有源码级守卫能防。
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('层 3 不参与 PIT（resolveVintage 永不读快照表）', () => {
  it('financialFact 仓储实现里不出现 ingestSnapshot 引用', () => {
    for (const path of [
      'packages/db/src/repository/drizzle/financial-fact.ts',
      'packages/db/src/repository/memory/financial-fact.ts',
    ]) {
      const source = stripComments(read(path));
      expect(source, `${path} 不应引用快照仓储`).not.toContain('IngestSnapshot');
      expect(source, `${path} 不应引用快照表`).not.toContain('financial_ingest_snapshots');
    }
  });

  it('`resolveVintage` 的接口定义里不出现快照仓储', () => {
    const source = stripComments(read('packages/core/src/repository/index.ts'));
    const start = source.indexOf('export interface FinancialFactRepository');
    const body = source.slice(start, source.indexOf('export interface', start + 10));
    expect(body).not.toContain('IngestSnapshot');
  });
});

describe('recordedAt 永不回填', () => {
  it('层 3 的观测写入**不碰** `financial_fact_revisions`', () => {
    // 层 3 只写 `financialIngestSnapshot`。若将来有人在这里加一行
    // `ctx.repos.financialFact.appendMany(...)`，PIT 立刻被污染。
    const source = stripComments(read('packages/tools/src/pit-layers.ts'));
    const start = source.indexOf('export const observeIngestSnapshot');
    const body = source.slice(start, source.indexOf('export const strictPitAsOf'));
    expect(body).not.toContain('financialFact.appendMany');
    expect(body).not.toContain('financialFact.append');
  });

  it('PIT 写入路径不得出现「把 recordedAt 设成公告日」的覆盖', () => {
    // `recordedAt` 必须是真实抓取时刻。若有人写 `recordedAt: publishedAt`，
    // 就会制造「我知道我当时就知道」的假象——这正是 spike §4 明确不采用的方案。
    const source = stripComments(read('packages/tools/src/pit-layers.ts'));
    for (const forbidden of ['recordedAt: publishedAt', 'recordedAt: revisionPublishedAt'])
      expect(source).not.toContain(forbidden);
  });
});

describe('直接调用 resolveVintage 的白名单（T+1 不被静默绕过）', () => {
  /**
   * ## 为什么是「白名单恰好这两处」而不是「零调用」
   *
   * 这两处传的是 **`dataAsOf`（数据截止日）**，不是「按披露日判断可见性」——
   * 它们**本来就不该**走 T+1。把它们算进「绕过者」会把语义搞混。
   *
   * 所以断言的是：**除这两处之外，没有任何其它直接调用**。
   * 将来有人新增直接调用，这条会红——**那一刻他必须回答「为什么不用 wrapper」**。
   *
   * > 「现在还没有所以测不了」不成立：**断言它现在是白名单就够了**。
   */
  const ALLOWED_DIRECT_CALLS = [
    // 按 dataAsOf 查财务事实（数据截止日语义，与披露日粒度无关）
    'packages/tools/src/tools/fundamental-score.ts',
    'packages/tools/src/tools/financial-facts.ts',
  ];

  it('除白名单外，没有其它直接调用 `resolveVintage(` 的地方', () => {
    // 用 `readdirSync` 递归而不是 `Bun.Glob`：后者在 vitest 环境下相对路径解析不稳定
    // （实测返回空结果，会让这条断言变成恒真——那比没有断言更糟）。
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        if (path.includes('.test.')) continue;
        if (path.includes('/repository/')) continue; // 接口与实现，不是调用方
        if (path === 'packages/tools/src/pit-layers.ts') continue; // wrapper 自己（注释里提到）
        const source = stripComments(read(path));
        if (!source.includes('.resolveVintage(')) continue;
        if (!ALLOWED_DIRECT_CALLS.includes(path)) offenders.push(path);
      }
    };
    walk('packages');
    // **零绕过者**。将来新增一个直接调用，这里立刻红。
    expect(offenders).toEqual([]);
    // 自检：扫描确实扫到了东西（否则「空数组」毫无意义）。
    expect(read('packages/tools/src/tools/financial-facts.ts')).toContain('.resolveVintage(');
  });

  it('白名单里的两处确实存在（白名单不能变成空话）', () => {
    for (const path of ALLOWED_DIRECT_CALLS) {
      const source = stripComments(read(path));
      expect(source, `${path} 已不再直接调用 resolveVintage，白名单该更新`).toContain(
        '.resolveVintage(',
      );
    }
  });
});
