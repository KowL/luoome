import { describe, expect, it } from 'vitest';
import { EvidenceRefSchema, ResearchBriefSchema } from './research-brief.js';

describe('ResearchBrief schema', () => {
  it('要求 document chunk 具备真实定位字段和受限 quote', () => {
    expect(
      EvidenceRefSchema.safeParse({ kind: 'document-chunk', id: 'free-text', quote: '伪引用' })
        .success,
    ).toBe(false);
    expect(
      EvidenceRefSchema.safeParse({
        kind: 'document-chunk',
        id: 'doc_1:0',
        documentId: 'doc_1',
        ordinal: 0,
        relativePath: 'Research/doc.md',
        headingPath: '摘要',
        quote: '事实',
      }).success,
    ).toBe(true);
  });

  it('ResearchBrief 保留 unknowns/sourceStatus，不允许超长自由文本', () => {
    const result = ResearchBriefSchema.safeParse({
      scope: '库存周期',
      conclusion: '结论',
      facts: [],
      inferences: [],
      counterEvidence: [],
      risks: [],
      unknowns: ['尚无可验证资料'],
      dataAsOf: new Date('2026-08-01T00:00:00.000Z'),
      sourceStatus: 'unavailable',
      suggestedFollowUps: ['同步资料'],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(
      ResearchBriefSchema.safeParse({
        ...result.data,
        conclusion: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });
});
