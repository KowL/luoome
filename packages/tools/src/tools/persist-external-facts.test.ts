import { externalFactId } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { persistExternalFactsTool, stripCredentialQuery } from './persist-external-facts.js';

const NOW = new Date('2026-10-31T06:00:00.000Z');
const PUBLISHED = new Date('2026-10-30T01:12:00.000Z');

const news = (overrides: Record<string, unknown> = {}) => ({
  id: '20261030001',
  title: '央行开展 5000 亿 MLF 操作',
  summary: '净投放 2000 亿',
  category: '宏观',
  media: '东方财富',
  publishedAt: PUBLISHED,
  url: 'https://finance.example.com/a',
  source: 'eastmoney',
  ...overrides,
});

const run = async (
  input: Record<string, unknown>,
  ctx?: Awaited<ReturnType<typeof buildTestContext>>,
) => {
  const context = ctx ?? (await buildTestContext({ clock: () => NOW }));
  const result = await persistExternalFactsTool.execute(input, context);
  return { result, ctx: context };
};

describe('persist_external_facts：幂等落库与稳定 id', () => {
  it('落 3 条 news → 3 行，source / observedAt 齐全（= 上游 publishedAt）', async () => {
    const { result, ctx } = await run({
      facts: [news(), news({ id: '20261030002' }), news({ id: '20261030003' })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ inserted: 3, updated: 0, unchanged: 0, rejected: [] });
    expect(result.data.dataAsOf).toEqual(PUBLISHED);
    const rows = await ctx.repos.externalMarketFact.listByKind({ kind: 'news' });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.source).toBe('eastmoney');
      expect(row.observedAt).toEqual(PUBLISHED);
      expect(row.id).toBe(
        externalFactId({
          kind: 'news',
          source: row.source,
          subjectKey: row.subjectKey,
          observedAt: row.observedAt,
        }),
      );
    }
  });

  it('同一条事实重抓 → unchanged，行数不变（幂等）', async () => {
    const { result, ctx } = await run({ facts: [news()] });
    expect(result.ok && result.data.inserted).toBe(1);
    const again = await persistExternalFactsTool.execute({ facts: [news()] }, ctx);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(await ctx.repos.externalMarketFact.listByKind({ kind: 'news' })).toHaveLength(1);
  });

  it('内容更正后再抓 → id 不变、事实更新、引用链仍能追到（revisedAt 留痕）', async () => {
    const { result, ctx } = await run({ facts: [news()] });
    if (!result.ok) throw new Error('seed failed');
    const originalId = result.data.facts[0]?.id;
    expect(originalId).toBeDefined();
    // 先建立一条引用（模拟 Advice 引用过它）。
    await ctx.repos.externalMarketFact.addReference(originalId ?? '', 'advice:adv-1');

    const revised = await persistExternalFactsTool.execute(
      {
        facts: [news({ title: '央行开展 5000 亿 MLF 操作（更正）', summary: '净投放 2500 亿' })],
      },
      ctx,
    );
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.data).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 });
    // 关键：id 不变 → Advice 的引用链没有断。
    expect(revised.data.facts[0]?.id).toBe(originalId);
    const row = await ctx.repos.externalMarketFact.findById(originalId ?? '');
    expect(row?.payload.title).toBe('央行开展 5000 亿 MLF 操作（更正）');
    expect(row?.referencedBy).toEqual(['advice:adv-1']);
    expect(row?.revisedAt).toEqual(NOW);
    expect(row?.recordedAt).toEqual(NOW);
  });

  it('observedAt 超出可落库窗口 → 该条 rejected，其余正常落库（不拿 fetchedAt 顶替）', async () => {
    const ancient = new Date('2010-01-01T00:00:00.000Z');
    const { result, ctx } = await run({
      facts: [news({ publishedAt: ancient }), news({ id: 'ok-1' })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.inserted).toBe(1);
    expect(result.data.rejected).toHaveLength(1);
    expect(result.data.rejected[0]?.reason).toContain('窗口');
    const rows = await ctx.repos.externalMarketFact.listByKind({ kind: 'news' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subjectKey).toBe('ok-1');
  });

  it('URL 里的凭据查询参数在落库前被剥离（不把 token 写进可导出的业务事实）', async () => {
    const { result, ctx } = await run({
      facts: [news({ url: 'https://finance.example.com/a?token=SECRET123&page=2' })],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rows = await ctx.repos.externalMarketFact.listByKind({ kind: 'news' });
    const payload = rows[0]?.payload;
    expect(String(payload?.url)).not.toContain('SECRET123');
    expect(String(payload?.url)).toContain('page=2');
    expect(JSON.stringify(rows[0])).not.toContain('SECRET123');
  });

  it('stripCredentialQuery 只剥凭据类参数，保留其它查询参数与普通 URL', () => {
    expect(stripCredentialQuery('https://a.example/b?key=1&x=2')).toBe('https://a.example/b?x=2');
    expect(stripCredentialQuery('https://a.example/b?x=2')).toBe('https://a.example/b?x=2');
    expect(stripCredentialQuery('not a url')).toBe('not a url');
  });

  it('所有条目都不可落库 → invalid_input（不返回伪成功）', async () => {
    const { result } = await run({
      facts: [news({ publishedAt: new Date('2010-01-01T00:00:00.000Z') })],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });
});
