import { describe, expect, it } from 'vitest';

import {
  assertResearchHypothesisVersionInvariants,
  type ResearchHypothesisVersion,
} from './research-hypothesis.js';

const base = (overrides: Partial<ResearchHypothesisVersion> = {}): ResearchHypothesisVersion => ({
  id: 'hypothesis_one',
  topicId: 'topic_industry',
  documentId: 'doc_thesis',
  documentContentHash: 'a'.repeat(64),
  version: 1,
  status: 'active',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  ...overrides,
});

describe('ResearchHypothesisVersion', () => {
  it('accepts a first active version and a linked successor', () => {
    expect(() => assertResearchHypothesisVersionInvariants(base())).not.toThrow();
    expect(() =>
      assertResearchHypothesisVersionInvariants(
        base({
          id: 'hypothesis_two',
          version: 2,
          supersedesId: 'hypothesis_one',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects an invalid content hash and an incomplete successor link', () => {
    expect(() =>
      assertResearchHypothesisVersionInvariants(base({ documentContentHash: 'invalid' })),
    ).toThrow();
    expect(() => assertResearchHypothesisVersionInvariants(base({ version: 2 }))).toThrow(
      /supersedesId/,
    );
  });
});
