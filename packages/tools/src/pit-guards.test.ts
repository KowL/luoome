import { readFileSync } from 'node:fs';
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
