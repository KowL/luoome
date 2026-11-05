import { money, RiskVetoSchema } from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { getAnalysisContextTool } from './context.js';
import { recordAdviceTool } from './record.js';

/**
 * REQ-M5-04：**写在否决之后真的被挡住**（端到端，不是只看判据函数）。
 *
 * ## 为什么这条必须有
 *
 * 先前的 `risk-veto-write.test.ts` 只验证「判据函数返回非 null」——
 * 那证明的是**判据本身对**，不是「写入路径真的调了它」。
 *
 * 实测过：把 `recordAdvice` 事务里的检查整段删掉，那组测试**全绿** ⇒ 它们没覆盖写入路径。
 * 这条直接驱动 `record_advice`，删检查就会红。
 */
// 2026-07-29 12:00 Asia/Shanghai（盘中）—— `advice_stock` 的写窗口在这里有效。
// 盘后（08:00Z = 16:00 CST）写建议会 `context_expired`，那是另一条规则，不是本测试要验的。
const now = new Date('2026-07-29T04:00:00Z');

const setup = async () => {
  const ctx = await buildTestContext({ clock: () => now, advices: [] });
  await ctx.repos.quote.save({
    stockId: '600519.SH',
    ts: now,
    observedAt: now,
    fetchedAt: now,
    timestampSource: 'upstream',
    open: money(100),
    high: money(101),
    low: money(99),
    close: money(100),
    volume: 1000,
    source: 'test',
  });
  const snapshot = await getAnalysisContextTool.execute(
    { kind: 'advice_stock', subject: { kind: 'stock', id: '600519.SH' } },
    ctx,
  );
  if (!snapshot.ok) throw new Error(`快照失败：${JSON.stringify(snapshot.error)}`);
  return { ctx, contextId: snapshot.data.id };
};

// 照搬 `analysis.test.ts:22-28` 的形状（`reasoning` 是结构化对象，不是字符串）
const result = {
  decision: 'watch' as const,
  confidence: 50,
  horizon: 'short' as const,
  reasoning: {
    premise: '等待确认',
    evidence: ['已保存行情'],
    counterEvidence: ['缺少量能'],
  },
  risks: ['信息有限'],
};
const provenance = {
  generatorKind: 'dsh-chat' as const,
  model: 'test:model',
  skillVersion: 'test',
  evidenceFactIds: ['quote:600519.SH'],
};

describe('否决后写建议被拒（端到端）', () => {
  it('**无否决 → 写入成功**（对照）', async () => {
    const { ctx, contextId } = await setup();
    const recorded = await recordAdviceTool.execute({ contextId, result, provenance }, ctx);
    if (!recorded.ok) throw new Error(`写入失败：${JSON.stringify(recorded.error)}`);
  });

  it('**有否决 → 写入被拒**，且错误信息带出 veto 的 reason', async () => {
    const { ctx, contextId } = await setup();
    await ctx.repos.riskVeto.save(
      RiskVetoSchema.parse({
        id: 'veto-1',
        accountId: ctx.user.defaultAccountId,
        subject: { kind: 'stock', id: '600519.SH' },
        reason: '趋势已破坏且量能萎缩',
        factIds: ['quote:600519.SH'],
        contextId,
        createdAt: now,
      }),
    );
    const recorded = await recordAdviceTool.execute({ contextId, result, provenance }, ctx);
    expect(recorded.ok).toBe(false);
    if (recorded.ok) return;
    const message = 'message' in recorded.error ? recorded.error.message : '';
    // **用户必须知道为什么写不进去**，不是只说「被否决」
    expect(message).toContain('risk_officer_veto');
    expect(message).toContain('趋势已破坏且量能萎缩');
    expect(message).toContain('override_risk_veto');
  });

  it('**override 之后又能写**（解除路径有效）', async () => {
    const { ctx, contextId } = await setup();
    await ctx.repos.riskVeto.save(
      RiskVetoSchema.parse({
        id: 'veto-1',
        accountId: ctx.user.defaultAccountId,
        subject: { kind: 'stock', id: '600519.SH' },
        reason: '趋势已破坏',
        factIds: ['quote:600519.SH'],
        contextId,
        createdAt: now,
      }),
    );
    expect((await recordAdviceTool.execute({ contextId, result, provenance }, ctx)).ok).toBe(false);

    await ctx.repos.riskVeto.saveOverride({
      id: 'o1',
      vetoId: 'veto-1',
      overriddenBy: 'user',
      reason: '看到新产量数据',
      newFactIds: ['earnings:600519.SH:2026Q2'],
      overriddenAt: now,
    });
    // 推翻后放行
    expect((await recordAdviceTool.execute({ contextId, result, provenance }, ctx)).ok).toBe(true);
  });
});
