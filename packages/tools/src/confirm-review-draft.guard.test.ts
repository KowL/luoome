import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * REQ-M4-11：「**草稿不写复盘**」的结构性保证。
 *
 * ## 为什么需要守卫，而不是只靠「现在没写」
 *
 * 有人验证过 `daily-review.ts` 当前零命中 `save_decision_review` ——
 * 但那只是「**现在**没写」。将来有人在 workflow 里顺手加一句写复盘，
 * 没有任何测试会红。**这条守卫防的是那个将来。**
 *
 * ## 正向 + 反向（本会话的教训）
 *
 * 只查名字会被别名绕过。所以：
 * - 反向：草稿生成路径**不得出现**写复盘的能力
 * - 正向：真正写复盘的地方**必须**是 `confirm_review_draft`（它调 `save_decision_review`）
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('草稿生成路径不写复盘（反向）', () => {
  it('daily-review workflow 不得出现写复盘/回填结果的能力', () => {
    const source = stripComments(read('packages/workflows/src/daily-review.ts'));
    for (const forbidden of [
      'save_decision_review',
      'saveDecisionReviewTool',
      'record_advice_outcome',
      'recordAdviceOutcomeTool',
    ])
      expect(source, `daily-review.ts 出现了写复盘调用：${forbidden}`).not.toContain(forbidden);
  });

  it('报告产物写盘路径同样不得写复盘', () => {
    const source = stripComments(read('packages/tools/src/tools/write-report-artifact.ts'));
    expect(source).not.toContain('save_decision_review');
    expect(source).not.toContain('record_advice_outcome');
  });
});

describe('只有确认工具能写复盘（正向）', () => {
  it('confirm_review_draft **复用** save_decision_review（不复制逻辑）', () => {
    const source = stripComments(read('packages/tools/src/tools/confirm-review-draft.ts'));
    // 正向：必须调用既有工具
    expect(source).toContain('saveDecisionReviewTool.execute');
    // 反向：不得自己调仓储写复盘（那是复制逻辑）
    expect(source).not.toContain('repos.decisionReview.save');
  });

  it('来源草稿 id 不进入 contextHash 的摘要输入', () => {
    const source = stripComments(read('packages/tools/src/tools/decision-review.ts'));
    // `contextHash` 只摘要 `{ subject, source }`；`sourceDraftId` 放在
    // `context.confirmationSourceDraftId`，因此两条路径算出的 hash 天然一致。
    expect(source).not.toContain('source: source.source, sourceDraftId');
    expect(source).toContain('confirmationSourceDraftId');
  });
});
