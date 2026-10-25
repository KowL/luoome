import { describe, expect, it } from 'vitest';
import {
  type AnalysisContext,
  AnalysisContextSchema,
  analysisContextTiming,
  analysisContextTimingError,
  analysisContextWriteError,
  analysisTimingRules,
  isAnalysisContextStale,
} from './analysis-context.js';
import { type AnalysisKind, analysisSubjectKinds } from './analysis-job.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 2026-10-22 是周四；下列时刻均为 Asia/Shanghai = UTC+8。 */
const shanghai = {
  preOpen: new Date('2026-10-22T00:30:00Z'), // 08:30
  open: new Date('2026-10-22T02:00:00Z'), // 10:00
  lateAfternoon: new Date('2026-10-22T06:45:00Z'), // 14:45
  close: new Date('2026-10-22T07:00:00Z'), // 15:00
  postClose: new Date('2026-10-22T08:00:00Z'), // 16:00
};

const contextFor = (kind: AnalysisKind, dataAsOf: Date, now: Date): AnalysisContext => {
  const { writeUntil } = analysisContextTiming(kind, dataAsOf, now);
  return AnalysisContextSchema.parse({
    id: 'context-1',
    jobId: null,
    kind,
    accountId: 'account-1',
    subject: { kind: analysisSubjectKinds[kind], id: 'subject-1' },
    dataAsOf,
    facts: [{ id: 'fact-1', label: '已保存事实', value: 1, evidenceIds: [] }],
    factIds: ['fact-1'],
    limitations: ['仅使用已持久化事实'],
    contextHash: 'a'.repeat(64),
    writeUntil,
    expiresAt: new Date(now.getTime() + 180 * DAY),
    createdAt: now,
  });
};

const timingErrorAt = (
  kind: AnalysisKind,
  dataAsOf: Date,
  assembledAt: Date,
  now: Date,
): ReturnType<typeof analysisContextTimingError> => {
  const context = contextFor(kind, dataAsOf, assembledAt);
  return analysisContextTimingError(
    { ...context, expiresAt: new Date(now.getTime() + 180 * DAY) },
    now,
  );
};

const intradayKinds: readonly AnalysisKind[] = [
  'advice_stock',
  'advice_position',
  'advice_strategy_candidate',
];
const researchKinds: readonly AnalysisKind[] = [
  'research_directions',
  'strategy_version_proposal',
  'strategy_insight_narrative',
];

describe('analysis context timing rules', () => {
  it('declares an explicit rule for every AnalysisKind', () => {
    expect(Object.keys(analysisTimingRules).sort()).toEqual(
      [
        'advice_market',
        'advice_position',
        'advice_stock',
        'advice_strategy_candidate',
        'research_directions',
        'strategy_insight_narrative',
        'strategy_version_proposal',
      ].sort(),
    );
    for (const kind of intradayKinds) {
      expect(analysisTimingRules[kind]).toEqual({
        writeWindowMs: 30 * MINUTE,
        dataMaxAgeMs: 30 * MINUTE,
        closesAtSessionEnd: true,
      });
    }
    expect(analysisTimingRules.advice_market).toEqual({
      writeWindowMs: 24 * HOUR,
      dataMaxAgeMs: 7 * DAY,
      closesAtSessionEnd: false,
    });
    for (const kind of researchKinds) {
      expect(analysisTimingRules[kind]).toEqual({
        writeWindowMs: 24 * HOUR,
        dataMaxAgeMs: 30 * DAY,
        closesAtSessionEnd: false,
      });
    }
  });

  it('keeps the 15:00 close truncation for intraday action kinds only', () => {
    const open = analysisContextTiming('advice_stock', shanghai.open, shanghai.open);
    expect(open.writeUntil).toEqual(new Date(shanghai.open.getTime() + 30 * MINUTE));
    const nearClose = analysisContextTiming(
      'advice_position',
      shanghai.lateAfternoon,
      shanghai.lateAfternoon,
    );
    expect(nearClose.writeUntil).toEqual(shanghai.close);
    for (const kind of [...researchKinds, 'advice_market'] as const) {
      const late = analysisContextTiming(kind, shanghai.lateAfternoon, shanghai.lateAfternoon);
      expect(late.writeUntil).toEqual(new Date(shanghai.lateAfternoon.getTime() + 24 * HOUR));
    }
  });

  it('expires intraday action contexts after the close while the write window is open', () => {
    for (const kind of intradayKinds) {
      expect(timingErrorAt(kind, shanghai.close, shanghai.postClose, shanghai.postClose)).toBe(
        'context_expired',
      );
      expect(timingErrorAt(kind, shanghai.open, shanghai.open, shanghai.open)).toBeUndefined();
      expect(
        timingErrorAt(
          kind,
          shanghai.open,
          shanghai.open,
          new Date(shanghai.open.getTime() + 30 * MINUTE),
        ),
      ).toBe('context_expired');
    }
  });

  it('marks intraday action facts older than 30 minutes stale inside the write window', () => {
    const assembledAt = shanghai.open;
    const dataAsOf = new Date(assembledAt.getTime() - 10 * MINUTE);
    expect(timingErrorAt('advice_stock', dataAsOf, assembledAt, assembledAt)).toBeUndefined();
    expect(
      timingErrorAt(
        'advice_stock',
        dataAsOf,
        assembledAt,
        new Date(assembledAt.getTime() + 15 * MINUTE),
      ),
    ).toBeUndefined();
    expect(
      timingErrorAt(
        'advice_stock',
        dataAsOf,
        assembledAt,
        new Date(assembledAt.getTime() + 25 * MINUTE),
      ),
    ).toBe('stale_context');
  });

  it('allows advice_market writes after the close within 24h while the facts stay within 7 days', () => {
    const context = contextFor('advice_market', shanghai.close, shanghai.postClose);
    expect(context.writeUntil).toEqual(new Date(shanghai.postClose.getTime() + 24 * HOUR));
    expect(analysisContextTimingError(context, shanghai.postClose)).toBeUndefined();
    expect(
      analysisContextTimingError(context, new Date(shanghai.postClose.getTime() + 24 * HOUR - 1)),
    ).toBeUndefined();
    expect(
      analysisContextTimingError(context, new Date(shanghai.postClose.getTime() + 24 * HOUR)),
    ).toBe('context_expired');
    expect(
      analysisContextTimingError(context, new Date(shanghai.postClose.getTime() + 25 * HOUR)),
    ).toBe('context_expired');
  });

  it('marks stale market facts and keeps the 7 day boundary exclusive', () => {
    const assembledAt = shanghai.postClose;
    const staleData = new Date(assembledAt.getTime() - 8 * DAY);
    expect(timingErrorAt('advice_market', staleData, assembledAt, assembledAt)).toBe(
      'stale_context',
    );
    expect(
      timingErrorAt(
        'advice_market',
        new Date(assembledAt.getTime() - 7 * DAY + MINUTE),
        assembledAt,
        assembledAt,
      ),
    ).toBeUndefined();
    const exact = contextFor(
      'advice_market',
      new Date(assembledAt.getTime() - 7 * DAY),
      assembledAt,
    );
    expect(isAnalysisContextStale('advice_market', exact.dataAsOf, assembledAt)).toBe(false);
    expect(exact.writeUntil).toEqual(assembledAt);
    expect(analysisContextTimingError(exact, assembledAt)).toBe('context_expired');
  });

  it('allows research and strategy writes after the close within 24h and stale after 30 days', () => {
    for (const kind of researchKinds) {
      const context = contextFor(kind, shanghai.close, shanghai.postClose);
      expect(context.writeUntil).toEqual(new Date(shanghai.postClose.getTime() + 24 * HOUR));
      expect(analysisContextTimingError(context, shanghai.postClose)).toBeUndefined();
      expect(
        analysisContextTimingError(context, new Date(shanghai.postClose.getTime() + 24 * HOUR)),
      ).toBe('context_expired');
      const staleData = new Date(shanghai.postClose.getTime() - 31 * DAY);
      expect(timingErrorAt(kind, staleData, shanghai.postClose, shanghai.postClose)).toBe(
        'stale_context',
      );
      expect(
        timingErrorAt(
          kind,
          new Date(shanghai.postClose.getTime() - 30 * DAY + MINUTE),
          shanghai.postClose,
          shanghai.postClose,
        ),
      ).toBeUndefined();
    }
  });

  it('treats future data as fresh and caps write windows consistently', () => {
    const future = new Date(shanghai.open.getTime() + DAY);
    expect(isAnalysisContextStale('research_directions', future, shanghai.open)).toBe(false);
    expect(analysisContextTiming('research_directions', future, shanghai.open).writeUntil).toEqual(
      new Date(shanghai.open.getTime() + 24 * HOUR),
    );
    expect(
      analysisContextTimingError(
        {
          kind: 'research_directions',
          dataAsOf: future,
          writeUntil: new Date(shanghai.open.getTime() + 24 * HOUR),
          expiresAt: new Date(shanghai.open.getTime() + 180 * DAY),
        },
        shanghai.open,
      ),
    ).toBeUndefined();
    expect(analysisContextTiming('advice_stock', future, shanghai.open).writeUntil).toEqual(
      new Date(shanghai.open.getTime() + 30 * MINUTE),
    );
  });

  it('keeps unknown fact references ahead of timing errors for the audited write check', () => {
    const expired = contextFor('advice_market', shanghai.close, shanghai.postClose);
    expect(
      analysisContextWriteError(expired, new Date(shanghai.postClose.getTime() + 25 * HOUR), []),
    ).toBe('context_expired');
    expect(
      analysisContextWriteError(expired, new Date(shanghai.postClose.getTime() + 25 * HOUR), [
        'invented',
      ]),
    ).toBe('unknown_fact_reference');
    const stale = contextFor(
      'research_directions',
      new Date(shanghai.postClose.getTime() - 31 * DAY),
      shanghai.postClose,
    );
    expect(analysisContextWriteError(stale, shanghai.postClose, ['fact-1'])).toBe('stale_context');
    expect(analysisContextWriteError(stale, shanghai.postClose, [])).toBe('stale_context');
  });
});
