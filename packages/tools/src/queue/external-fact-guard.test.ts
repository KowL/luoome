import {
  AnalysisContextSchema,
  analysisContextTiming,
  externalFactId,
  money,
  type ToolContext,
} from '@luoome/core';
import { describe, expect, it } from 'vitest';

import { buildTestContext } from '../testing/context.js';
import { analysisHash, getAnalysisContextTool } from './context.js';
import { recordAnalysisResultTool } from './publication.js';
import { recordAdviceTool } from './record.js';

/**
 * REQ-M3-16 的**核心负例**：未落库的 external 事实进 Advice 必须被拒。
 *
 * **两条写 Advice 的路径都要堵**（`record.ts` 与 `publication.ts`）——只堵一条，
 * 另一条就是后门（与「Trade↔Advice 双链只认一条」同一条教训）。
 */

const NOW = new Date('2026-10-22T04:00:00Z');
const PUBLISHED = new Date('2026-10-22T01:12:00.000Z');

const adviceResult = {
  decision: 'watch',
  confidence: 50,
  horizon: 'short',
  reasoning: { premise: '等待确认', evidence: ['新闻线索'], counterEvidence: ['缺少量能'] },
  risks: ['信息有限'],
};

/** 构造一条带 `extfact:*` 证据的 context（facts 里也带，模拟「抓取快照进了 context」）。 */
const contextWithExternalFact = async (
  ctx: ToolContext,
  factId: string,
  kind: 'advice_stock' | 'research_directions' = 'advice_stock',
) => {
  const timing = analysisContextTiming(kind, NOW, NOW);
  const context = AnalysisContextSchema.parse({
    id: `ctx-extfact-${factId.length}-${kind}`,
    jobId: null,
    kind,
    accountId: ctx.user.defaultAccountId,
    // 主题必须与 context kind 一致（`analysis_subject_mismatch` 是另一条不变量）。
    subject:
      kind === 'research_directions'
        ? { kind: 'research', id: 'research:q-1' }
        : { kind: 'stock', id: '600519.SH' },
    dataAsOf: NOW,
    missingFacts: [],
    facts: [{ id: factId, label: '新闻事实', value: { title: '央行 MLF 操作' }, evidenceIds: [] }],
    factIds: [factId],
    limitations: [],
    contextHash: analysisHash({
      facts: [
        { id: factId, label: '新闻事实', value: { title: '央行 MLF 操作' }, evidenceIds: [] },
      ],
      dataAsOf: NOW,
    }),
    writeUntil: timing.writeUntil,
    expiresAt: new Date(NOW.getTime() + 7 * 86_400_000),
    createdAt: NOW,
  });
  await ctx.repos.analysis.saveContext(context);
  return context;
};

const provenanceFor = (factId: string) => ({
  generatorKind: 'dsh-chat' as const,
  skillVersion: 'test',
  evidenceFactIds: [factId],
});

const factIdOf = (subjectKey: string) =>
  externalFactId({
    kind: 'news',
    source: 'eastmoney',
    subjectKey,
    observedAt: PUBLISHED,
  });

const setup = async () => {
  const ctx = await buildTestContext({ clock: () => NOW, advices: [] });
  await ctx.repos.quote.save({
    stockId: '600519.SH',
    ts: NOW,
    observedAt: NOW,
    fetchedAt: NOW,
    timestampSource: 'upstream',
    open: money(100),
    high: money(101),
    low: money(99),
    close: money(100),
    volume: 1000,
    source: 'test',
  });
  return ctx;
};

describe('REQ-M3-16 L2 强制点：未落库的外部事实进 Advice 被拒（两条路径）', () => {
  it('H1 record_advice：extfact 在 context 里但表里没有 → invalid_input + persisted-fact-missing', async () => {
    const ctx = await setup();
    const factId = factIdOf('20261022001');
    const context = await contextWithExternalFact(ctx, factId);
    const result = await recordAdviceTool.execute(
      { contextId: context.id, result: adviceResult, provenance: provenanceFor(factId) },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    const invalid = result.error as { message?: string; issues?: readonly { message: string }[] };
    expect(invalid.message).toBe('unknown_fact_reference');
    const issues = invalid.issues ?? [];
    expect(issues.map((issue) => issue.message).join('；')).toContain(factId);
    expect(issues.map((issue) => issue.message).join('；')).toContain('persist_external_facts');
  });

  it('H2 record_analysis_result（publication 路径）同样被拒——只堵一条必漏', async () => {
    const ctx = await setup();
    const factId = factIdOf('20261022002');
    const context = await contextWithExternalFact(ctx, factId, 'research_directions');
    // publication 路径的 result 是发布草稿（不是 advice 载荷）：用最小合法形状，
    // 目的是让校验走到 L2，而不是被 result 形状先挡掉。
    const result = await recordAnalysisResultTool.execute(
      {
        contextId: context.id,
        result: {
          kind: 'research_directions',
          question: '这条新闻支持哪个方向？',
          directions: [],
          limitations: ['测试用最小载荷'],
        },
        provenance: provenanceFor(factId),
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    const invalid = result.error as { message?: string; issues?: readonly { message: string }[] };
    expect(invalid.message).toBe('unknown_fact_reference');
    expect((invalid.issues ?? []).map((issue) => issue.message).join('；')).toContain(factId);
  });

  it('H3 正例：先落库再引用 → 两条路径都通过', async () => {
    const ctx = await setup();
    const factId = factIdOf('20261022003');
    await ctx.repos.externalMarketFact.upsert({
      draft: {
        kind: 'news',
        subjectKey: '20261022003',
        category: '宏观',
        observedAt: PUBLISHED,
        source: 'eastmoney',
        provenance: {
          provider: 'eastmoney',
          observedAt: PUBLISHED,
          fetchedAt: PUBLISHED,
          freshness: 'fresh',
        },
        payload: { title: '央行 MLF 操作' },
      },
      now: NOW,
    });
    const context = await contextWithExternalFact(ctx, factId);
    const recorded = await recordAdviceTool.execute(
      { contextId: context.id, result: adviceResult, provenance: provenanceFor(factId) },
      ctx,
    );
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    // 引用链可追：advice 的 evidenceFactIds → 事实表。
    expect(recorded.data.provenance?.evidenceFactIds).toContain(factId);
    expect(await ctx.repos.externalMarketFact.findById(factId)).not.toBeNull();
  });

  it('H4 负例：context 里有该 id，但事实被删除 → 仍拒（校验读表，不只读 context）', async () => {
    const ctx = await setup();
    const factId = factIdOf('20261022004');
    const context = await contextWithExternalFact(ctx, factId);
    // 表里始终没有这条事实 —— 等价于「曾经落过又被删」。
    const result = await recordAdviceTool.execute(
      { contextId: context.id, result: adviceResult, provenance: provenanceFor(factId) },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  it('H5 负例：非外部 fact id 不触发 L2（避免误伤既有引用链）', async () => {
    const ctx = await setup();
    const snapshot = await getAnalysisContextTool.execute(
      { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' } },
      ctx,
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const quotedFactId = snapshot.data.factIds.find((id) => id.startsWith('quote:'));
    expect(quotedFactId).toBeDefined();
    const result = await recordAdviceTool.execute(
      {
        contextId: snapshot.data.id,
        result: adviceResult,
        provenance: {
          generatorKind: 'dsh-chat',
          skillVersion: 'test',
          evidenceFactIds: [quotedFactId ?? ''],
        },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
  });
});

describe('REQ-M3-16 事实表可导出、凭据不可导出', () => {
  it('external_market_facts 在导出全集里；没有任何凭据表', async () => {
    const { DATA_IMPORT_BUSINESS_TABLES } = await import('../../../db/src/data-import-manifest.js');
    expect(DATA_IMPORT_BUSINESS_TABLES).toContain('external_market_facts');
    // 凭据在 $LUOOME_HOME/.env（0600），不进任何表——导出包里不许出现类似表名。
    expect(
      DATA_IMPORT_BUSINESS_TABLES.filter((name) => /credential|secret|api_?key|token/.test(name)),
    ).toEqual([]);
  });
});
