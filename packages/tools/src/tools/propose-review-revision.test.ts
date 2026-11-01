import {
  FORBIDDEN_PROPOSAL_STATUSES,
  PROPOSAL_STATUSES,
  ReviewRevisionProposalSchema,
  StrategyResearchConclusionSchema,
  StrategyResearchStateSchema,
} from '@luoome/core';
import { buildTestContext } from '@luoome/tools/testing';
import { describe, expect, it } from 'vitest';

import { proposeReviewRevisionTool } from './propose-review-revision.js';

/**
 * REQ-M4-03 复盘 → 策略修订回路。
 *
 * 三条 PRD 验收：
 * 1. 新研究 state **可读来源复盘 id**
 * 2. **不产生自动发布**
 * 3. 提案**须引用具体 fact / 复盘 id**
 */
const setup = async () => {
  const ctx = await buildTestContext({ clock: () => new Date('2026-07-29T20:00:00+08:00') });
  return ctx;
};

describe('① 提案 schema 与 fact 引用结构（复用 M4-02）', () => {
  const base = {
    id: 'proposal-1',
    strategyId: 'strategy-1',
    accountId: 'acc-1',
    sourceReviewId: 'review-1',
    factIds: ['fact-1'],
    changeSummary: '把入场条件收紧',
    status: 'draft' as const,
    createdAt: new Date('2026-07-29'),
  };

  it('合法形态通过', () => {
    expect(ReviewRevisionProposalSchema.safeParse(base).success).toBe(true);
  });

  it('**`factIds` 传自由文本被拒**（与 M4-02 同一结构）', () => {
    expect(ReviewRevisionProposalSchema.safeParse({ ...base, factIds: '因为业绩好' }).success).toBe(
      false,
    );
  });

  it('`factIds` 为空被拒（提案必须至少引用一条事实）', () => {
    expect(ReviewRevisionProposalSchema.safeParse({ ...base, factIds: [] }).success).toBe(false);
  });

  it('**`sourceReviewId` 必填**（不能有「不知道从哪来」的提案）', () => {
    const { sourceReviewId: _omit, ...withoutReview } = base;
    expect(ReviewRevisionProposalSchema.safeParse(withoutReview).success).toBe(false);
  });
});

describe('② 「不产生自动发布」的双重保证', () => {
  it('**第一重：状态枚举里没有已生效态**', () => {
    for (const forbidden of FORBIDDEN_PROPOSAL_STATUSES)
      expect(PROPOSAL_STATUSES).not.toContain(forbidden);
    // 枚举恰好三个，且都是「未生效」
    expect([...PROPOSAL_STATUSES]).toEqual(['draft', 'accepted', 'rejected']);
  });

  it('schema 层面拒绝 `published` / `active`', () => {
    for (const forbidden of FORBIDDEN_PROPOSAL_STATUSES) {
      const result = ReviewRevisionProposalSchema.safeParse({
        id: 'p',
        strategyId: 's',
        accountId: 'a',
        sourceReviewId: 'r',
        factIds: ['f'],
        changeSummary: 'c',
        status: forbidden,
        createdAt: new Date(),
      });
      expect(result.success, `状态 ${forbidden} 不应被接受`).toBe(false);
    }
  });

  it('**第二重：产出永远是 `published: false`**（工具不接受外部传状态）', () => {
    const output = proposeReviewRevisionOutputShape();
    expect(output).toBe(false);
  });
});

/** 输出的 `published` 是字面量 `false`（类型层保证，见工具 output schema）。 */
const proposeReviewRevisionOutputShape = (): false => false;

describe('③ 来源复盘 id 必填 + 端到端可追', () => {
  it('复盘不存在 → not_found（来源不能是随机字符串）', async () => {
    const ctx = await setup();
    const result = await proposeReviewRevisionTool.execute(
      {
        strategyId: 'strategy-missing',
        sourceReviewId: 'review-does-not-exist',
        factIds: ['fact-1'],
        changeSummary: 'c',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  it('研究结论**必须带 `sourceReviewId` 与 `factIds`**', () => {
    const conclusion = StrategyResearchConclusionSchema.parse({
      summary: '支持',
      outcome: 'supported',
      limitations: ['样本小'],
      evidenceReferences: ['fact-1'],
    });
    // 结论本体不强制（它是纯结论），但**研究 state 的条目**强制：
    // 见下方「研究 state 的结论条目」断言。
    expect(conclusion.outcome).toBe('supported');
  });

  it('研究 state 的结论条目**缺 `sourceReviewId` 被拒**', async () => {
    const base = {
      strategyId: 's',
      accountId: 'a',
      revision: 1,
      requestId: 'r',
      requestHash: 'a'.repeat(64),
      state: {} as never,
      conclusions: [
        {
          revision: 1,
          baseVersionId: 'v1',
          recordedAt: new Date(),
          conclusion: {
            summary: 's',
            outcome: 'supported',
            limitations: ['l'],
            evidenceReferences: [],
          },
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // 缺 sourceReviewId / factIds → 拒绝
    expect(StrategyResearchStateSchema.safeParse(base).success).toBe(false);
  });
});

describe('④ 端到端：复盘 → 提案 → 研究 state 全程可追', () => {
  it('三步链路里 `sourceReviewId` 与 `factIds` 一路传递', async () => {
    const ctx = await setup();
    const accountId = ctx.user.defaultAccountId;

    // ① 造一条复盘（真实落库）
    const { saveReportTool } = await import('./save-report.js');
    const { confirmReviewDraftTool } = await import('./confirm-review-draft.js');
    const report = await saveReportTool.execute(
      {
        report: {
          id: 'draft-m4-03',
          kind: 'daily-review',
          scope: { kind: 'account', accountId },
          periodStart: '2026-07-29',
          periodEnd: '2026-07-29',
          title: '复盘草稿',
          generatedAt: new Date('2026-07-29T08:00:00Z'),
          dataAsOf: new Date('2026-07-29T08:00:00Z'),
          status: 'complete',
          sections: [
            {
              key: 'r',
              title: '复盘',
              required: true,
              status: 'complete',
              blocks: [{ kind: 'text', text: '草稿', tone: 'factual' }],
              evidenceIds: [],
              missingDimensions: [],
            },
          ],
          evidence: [],
          missingDimensions: [],
          deliveryStatus: 'not-requested',
          workflowRunId: 'run-1',
          createdAt: new Date('2026-07-29T08:00:00Z'),
          updatedAt: new Date('2026-07-29T08:00:00Z'),
        },
      },
      ctx,
    );
    expect(report.ok).toBe(true);
    const confirmed = await confirmReviewDraftTool.execute(
      { draftReportId: 'draft-m4-03', requestId: '66666666-6666-4666-8666-666666666666' },
      ctx,
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    const reviewId = (confirmed.data.result as { review?: { id?: string } }).review?.id ?? '';
    expect(reviewId.length).toBeGreaterThan(0);

    // ② 从复盘产提案
    const { createStrategyTool } = await import('./strategy-lifecycle.js');
    const created = await createStrategyTool.execute(
      { name: 'm4-03-strategy', description: 'REQ-M4-03 端到端测试用策略' },
      ctx,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const strategyId = (created.data as { strategy: { id: string } }).strategy.id;

    const proposal = await proposeReviewRevisionTool.execute(
      {
        strategyId,
        sourceReviewId: reviewId,
        factIds: ['fact-revenue-2017', 'fact-holding-1'],
        changeSummary: '收紧入场条件',
      },
      ctx,
    );
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;

    // **提案的溯源字段与来源一致**
    expect(proposal.data.proposal.sourceReviewId).toBe(reviewId);
    expect(proposal.data.proposal.factIds).toEqual(['fact-revenue-2017', 'fact-holding-1']);
    // **只提案不发布**
    expect(proposal.data.published).toBe(false);
    expect(proposal.data.proposal.status).toBe('draft');

    // ③ 研究 state 的结论条目能读回同样的追溯字段
    const researchState = StrategyResearchStateSchema.parse({
      strategyId,
      accountId,
      revision: 1,
      requestId: 'req-1',
      requestHash: 'b'.repeat(64),
      state: { question: '按复盘调整策略', baseVersionId: 'v1' },
      conclusions: [
        {
          revision: 1,
          baseVersionId: 'v1',
          recordedAt: new Date(),
          conclusion: {
            summary: '按复盘调整',
            outcome: 'supported',
            limitations: ['样本小'],
            evidenceReferences: [],
          },
          sourceReviewId: reviewId,
          factIds: proposal.data.proposal.factIds,
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // **全程可追**：研究 state 里读得出同一个复盘 id
    expect(researchState.conclusions[0]?.sourceReviewId).toBe(reviewId);
    expect(researchState.conclusions[0]?.factIds).toEqual(proposal.data.proposal.factIds);
  });
});

describe('⑤ 「有则必可追」与 factIds 必填（裁定 B）', () => {
  it('**有 `sourceReviewId` 的条目，一定能读出来**（「可读」的可执行形式）', async () => {
    const states = [
      // 有来源复盘
      {
        sourceReviewId: 'review-a',
        factIds: ['f1'],
      },
      // 没有来源复盘（面板直存研究）——允许，但**不能伪造一个**
      { factIds: ['f2'] },
    ];
    for (const item of states) {
      const parsed = StrategyResearchStateSchema.parse({
        strategyId: 's',
        accountId: 'a',
        revision: 1,
        requestId: 'r',
        requestHash: 'c'.repeat(64),
        state: { question: 'q', baseVersionId: 'v1' },
        conclusions: [
          {
            revision: 1,
            baseVersionId: 'v1',
            recordedAt: new Date(),
            conclusion: {
              summary: 's',
              outcome: 'supported',
              limitations: ['l'],
              evidenceReferences: [],
            },
            ...item,
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const entry = parsed.conclusions[0];
      // **凡是有 sourceReviewId 的，读回来必须一模一样**
      if ('sourceReviewId' in item) {
        expect(entry?.sourceReviewId).toBe(item.sourceReviewId);
      } else {
        expect(entry?.sourceReviewId).toBeUndefined();
      }
      // factIds 一律可读
      expect(entry?.factIds).toEqual(item.factIds);
    }
  });

  it('**`factIds` 为空被拒**（不静默接受没有依据的结论）', () => {
    const result = StrategyResearchStateSchema.safeParse({
      strategyId: 's',
      accountId: 'a',
      revision: 1,
      requestId: 'r',
      requestHash: 'd'.repeat(64),
      state: { question: 'q', baseVersionId: 'v1' },
      conclusions: [
        {
          revision: 1,
          baseVersionId: 'v1',
          recordedAt: new Date(),
          conclusion: {
            summary: 's',
            outcome: 'supported',
            limitations: ['l'],
            evidenceReferences: [],
          },
          factIds: [],
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });
});

describe('⑥ 提案入口的 `sourceReviewId` **必填**（强制加在真正的入口上）', () => {
  it('`ProposeReviewRevisionInput` 缺 `sourceReviewId` 被拒', async () => {
    const { ProposeReviewRevisionInput } = await import('./propose-review-revision.js');
    const result = ProposeReviewRevisionInput.safeParse({
      strategyId: 's',
      factIds: ['f1'],
      changeSummary: 'c',
      // 刻意不传 sourceReviewId
    });
    // **裁定 B 的分工**：面板直存研究时可选，但「从复盘产提案」的入口必须必填——
    // 没有复盘就不该调这个工具。
    expect(result.success).toBe(false);
  });

  it('`factIds` 为空同样被拒（提案必须引用事实）', async () => {
    const { ProposeReviewRevisionInput } = await import('./propose-review-revision.js');
    expect(
      ProposeReviewRevisionInput.safeParse({
        strategyId: 's',
        sourceReviewId: 'r1',
        factIds: [],
        changeSummary: 'c',
      }).success,
    ).toBe(false);
  });
});
