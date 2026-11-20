import type { ReportEvidence, ReportMissingDimension, ReportSection } from '@luoome/core';

export const DAY_MS = 86_400_000;

export const shanghaiDate = (date: string): Date => new Date(`${date}T12:00:00+08:00`);

export const localEvidence = (
  id: string,
  dimension: string,
  now: Date,
  provider: string,
): ReportEvidence => ({
  id,
  dimension,
  provenance: {
    provider,
    observedAt: now,
    fetchedAt: now,
    freshness: 'unknown',
  },
});

export const missing = (
  dimension: string,
  reason: string,
  errorKind?: string,
): ReportMissingDimension => ({
  dimension,
  reason: reason.slice(0, 500),
  ...(errorKind === undefined ? {} : { errorKind }),
  retryable: errorKind !== 'not_implemented',
});

export const unavailableSection = (
  key: string,
  title: string,
  required: boolean,
  now: Date,
  dimension: string,
  errorKind: string,
): { section: ReportSection; evidence: ReportEvidence[] } => {
  const evidence = [
    {
      id: `${key}:0`,
      dimension,
      provenance: {
        provider: `local/${dimension}`,
        observedAt: now,
        fetchedAt: now,
        freshness: 'unavailable' as const,
        errorKind,
      },
    },
  ];
  return {
    evidence,
    section: {
      key,
      title,
      required,
      status: 'unavailable',
      blocks: [{ kind: 'text', text: `${title}不可用`, tone: 'warning' }],
      evidenceIds: evidence.map((item) => item.id),
      missingDimensions: [missing(dimension, `${title}不可用`, errorKind)],
    },
  };
};
