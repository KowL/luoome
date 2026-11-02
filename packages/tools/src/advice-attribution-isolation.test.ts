import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { getAdviceAttributionTool } from './tools/get-advice-attribution.js';
import { getAdviceStatsTool } from './tools/get-advice-stats.js';

/**
 * REQ-M5-03 第 2 项：**主观评分表 ↔ 成交表不互写**。
 *
 * ## 为什么要双向断言
 *
 * 只查「查评分后成交表没变」只能证明**这一侧不写那一侧**。
 * 反向再查一次，才证明**两边互相隔离**——
 * 否则可能 A→B 不写、但 B→A 会写，合起来仍然在互相污染。
 *
 * ## 为什么用「逐字段 dump 对比」而不是「没报错」
 *
 * 查询不报错是最低标准；它证明不了数据没被改。
 * 这与 M4-05「层 3 不得写 revisions」是同一条纪律。
 */
const ACCOUNT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

/** 两张表的完整快照（**逐字段**比较，不是条数）。 */
const dumpSide = async (
  ctx: Awaited<ReturnType<typeof buildTestContext>>,
  side: 'reported' | 'trade',
): Promise<string> => {
  const records = await ctx.repos.decisionReview.list({
    accountId: ACCOUNT,
    subjectKind: 'advice',
    limit: 1000,
  });
  if (side === 'reported')
    // 主观评分表 =`adviceFeedback`（用户说了什么）
    return JSON.stringify(records.map((item) => item.revision.content.adviceFeedback));
  // 成交表 = `tradeIds`（真实成交链接）
  return JSON.stringify(records.map((item) => item.revision.content.tradeIds));
};

describe('主观评分表 ↔ 成交表：不互写', () => {
  it('查评分一侧 → 成交一侧**逐字段不变**', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-07-29T20:00:00+08:00') });
    const before = await dumpSide(ctx, 'trade');
    await getAdviceStatsTool.execute({ accountId: ACCOUNT }, ctx);
    expect(await dumpSide(ctx, 'trade')).toBe(before);
  });

  it('查成交一侧 → 评分一侧**逐字段不变**（反向）', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-07-29T20:00:00+08:00') });
    const before = await dumpSide(ctx, 'reported');
    await getAdviceAttributionTool.execute({ accountId: ACCOUNT }, ctx);
    expect(await dumpSide(ctx, 'reported')).toBe(before);
  });

  it('两侧**同时查**，两边都不变（互相隔离）', async () => {
    const ctx = await buildTestContext({ clock: () => new Date('2026-07-29T20:00:00+08:00') });
    const trades = await dumpSide(ctx, 'trade');
    const reported = await dumpSide(ctx, 'reported');
    await getAdviceStatsTool.execute({ accountId: ACCOUNT }, ctx);
    await getAdviceAttributionTool.execute({ accountId: ACCOUNT }, ctx);
    expect(await dumpSide(ctx, 'trade')).toBe(trades);
    expect(await dumpSide(ctx, 'reported')).toBe(reported);
  });
});
