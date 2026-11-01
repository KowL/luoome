import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { runClosingReportCutoffTool } from './index.js';

/**
 * REQ-M4-11：**收盘档产出复盘草稿，且到此为止**。
 *
 * ## 为什么必须在「真实收盘档路径」上验
 *
 * `confirm_review_draft` 的单测证明的是「确认才写」。但 PRD 还要证明
 * **收盘档跑完之后复盘计数没变** —— 那是另一条路径，单测覆盖不到。
 *
 * ## 为什么断言「文件存在」而不只断言「workflow 被调用」
 *
 * 本会话吃过十次「函数调用了但没接线」的亏（allowlist、`/execute`、`selected`、
 * `configuration()` 读常量…）。**草稿的价值在于它落成了文件**，
 * 只断言调用等于没验。
 */
const memoryArtifacts = () => {
  const files = new Map<string, { content: string }>();
  return {
    files,
    writer: {
      directory: '/memory/reports',
      async write(input: { fileName: string; content: string }) {
        files.set(input.fileName, { content: input.content });
        return {
          path: `/memory/reports/${input.fileName}`,
          written: true,
          bytes: input.content.length,
        };
      },
      async read(fileName: string) {
        return files.get(fileName)?.content ?? null;
      },
    },
  };
};

describe('收盘档产出复盘草稿', () => {
  it('草稿真的落盘，且**复盘计数不变**（到此为止）', async () => {
    const artifacts = memoryArtifacts();
    const ctx = await buildTestContext({
      // 交易日 15:30（收盘后）
      clock: () => new Date('2026-07-29T15:30:00+08:00'),
      reportArtifacts: artifacts.writer as never,
    });

    const countReviews = async () => {
      const { listDecisionReviewsTool } = await import('@luoome/tools');
      const listed = await listDecisionReviewsTool.execute(
        { accountId: ctx.user.defaultAccountId },
        ctx,
      );
      if (!listed.ok) throw new Error(JSON.stringify(listed.error));
      return (listed.data as { records?: unknown[] }).records?.length ?? 0;
    };

    const before = await countReviews();
    const result = await runClosingReportCutoffTool.execute(
      { accountId: ctx.user.defaultAccountId },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // ① 草稿文件**真的落盘了**（不是「workflow 被调用了」）
    const summary = result.data.summary as {
      draft?: { reportId: string | null; path: string | null } | null;
      draftError?: string | null;
    };
    expect(artifacts.files.size).toBeGreaterThan(0);
    const [fileName, file] = [...artifacts.files.entries()][0] ?? ['', { content: '' }];
    expect(fileName.length).toBeGreaterThan(0);
    expect(file.content.length).toBeGreaterThan(0);
    expect(summary.draft?.path ?? summary.draftError).toBeTruthy();

    // ② **到此为止**：收盘档跑完后复盘计数**不变**
    const after = await countReviews();
    if (after !== before)
      throw new Error(`收盘档后复盘计数变了：${before} → ${after}（草稿不该写复盘）`);
  });
});
