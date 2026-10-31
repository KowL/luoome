import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_CONTEXT_HASH_VERSION,
  type AnalysisContext,
  AnalysisContextSchema,
  analysisContextHashPayload,
  analysisContextTiming,
  analysisContextTimingError,
  analysisContextWriteError,
  analysisTimingRules,
  checkAnalysisReportCompleteness,
  checkAnalysisReportReferences,
  isAnalysisContextStale,
  missingFactsAvailability,
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
        'advice_strategy_candidate_after_close',
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
    // 盘后策略候选：不受 15:00 截断，但仍受 24h 写回窗口与 7 天数据有效期约束。
    expect(analysisTimingRules.advice_strategy_candidate_after_close).toEqual({
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

describe('T20 structured missingFacts', () => {
  it('旧 limitations 原样保留；missingFacts 缺省为空数组（旧 context 兼容）', () => {
    const context = contextFor('advice_stock', shanghai.open, shanghai.open);
    expect(context.limitations).toEqual(['仅使用已持久化事实']);
    expect(context.missingFacts).toEqual([]);
  });

  it('blocking 缺口 → unavailable；degraded 缺口 → partial；无缺口 → complete', () => {
    expect(missingFactsAvailability([])).toBe('complete');
    expect(
      missingFactsAvailability([
        {
          kind: 'news-unavailable',
          subjectId: 'market',
          reason: '未接入新闻',
          asOf: shanghai.open,
        },
      ]),
    ).toBe('partial');
    expect(
      missingFactsAvailability([
        {
          kind: 'quote-unavailable',
          subjectId: '600519.SH',
          reason: '缺少行情',
          asOf: shanghai.open,
        },
      ]),
    ).toBe('unavailable');
  });

  it('checker 对构造报告输出具体不符项：引用不存在的 factId、重复引用、空缺口、未知 kind', () => {
    const context = contextFor('advice_stock', shanghai.open, shanghai.open);
    const issues = checkAnalysisReportReferences({
      context,
      evidenceFactIds: ['fact-1', 'fact-1', 'fact-missing'],
      missingFacts: [
        { kind: 'quote-unavailable', subjectId: '', reason: '缺少行情', asOf: shanghai.open },
        { kind: 'not-a-kind', subjectId: 'subject-1', reason: '未知缺口', asOf: shanghai.open },
      ],
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unknown-fact-id', path: 'evidenceFactIds[2]' }),
        expect.objectContaining({ code: 'duplicate-fact-id', path: 'evidenceFactIds[1]' }),
        expect.objectContaining({ code: 'empty-missing-fact', path: 'missingFacts[0]' }),
        expect.objectContaining({ code: 'unknown-missing-kind', path: 'missingFacts[1].kind' }),
      ]),
    );
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });

  // T28 验收 1：blocking 缺口是 P8 的判断输入，必须受 contextHash 保护。
  it('删掉一条 blocking 缺口 → contextHash 必变（v2 口径）', () => {
    const hashOf = (missingFacts: readonly unknown[]): string =>
      createHash('sha256')
        .update(
          JSON.stringify(
            analysisContextHashPayload({
              version: ANALYSIS_CONTEXT_HASH_VERSION,
              facts: [{ id: 'fact-1', label: '收盘价', value: 10, evidenceIds: [] }],
              dataAsOf: shanghai.open,
              missingFacts: missingFacts as never,
            }),
          ),
        )
        .digest('hex');
    const blocking = [
      {
        kind: 'quote-unavailable',
        subjectId: '600519.SH',
        reason: '缺少行情',
        asOf: shanghai.open,
      },
    ];
    expect(hashOf(blocking)).not.toBe(hashOf([]));
    expect(hashOf(blocking)).not.toBe(
      hashOf([{ ...blocking[0], kind: 'strategy-run-unavailable' }]),
    );
  });

  // T28 补充（自查第 2 项）：不只"删一条"，"改一条"也必须被两条防线各自抓到。
  it('篡改一条 blocking 缺口（改 subjectId / 改 kind）→ hash 变、声明也不再匹配', () => {
    const base = {
      kind: 'quote-unavailable',
      subjectId: '600519.SH',
      reason: '缺少行情',
      asOf: shanghai.open,
    };
    const hashOf = (missingFacts: readonly unknown[]): string =>
      createHash('sha256')
        .update(
          JSON.stringify(
            analysisContextHashPayload({
              version: ANALYSIS_CONTEXT_HASH_VERSION,
              facts: [],
              dataAsOf: shanghai.open,
              missingFacts: missingFacts as never,
            }),
          ),
        )
        .digest('hex');
    // hash 防线：改 subjectId、改 kind、改 reason 都会变
    expect(hashOf([base])).not.toBe(hashOf([{ ...base, subjectId: '000001.SZ' }]));
    expect(hashOf([base])).not.toBe(hashOf([{ ...base, kind: 'quote-stale' }]));
    expect(hashOf([base])).not.toBe(hashOf([{ ...base, reason: '另一个原因' }]));

    // 完整性防线：声明"同 kind 但不同 subjectId"不算声明过
    const context = AnalysisContextSchema.parse({
      ...contextFor('advice_stock', shanghai.open, shanghai.open),
      missingFacts: [base],
    });
    expect(
      checkAnalysisReportCompleteness({
        context,
        missingFacts: [{ kind: 'quote-unavailable', subjectId: '000001.SZ' }],
      }),
    ).toEqual([
      {
        code: 'omitted-blocking-missing-fact',
        path: 'missingFacts[0]',
        message: '报告未声明 blocking 缺口: quote-unavailable / 600519.SH',
      },
    ]);
  });

  // T28 验收 2：checker 的**完整性方向**——报告漏引 blocking 缺口必须报具体 kind 与 subjectId。
  it('报告未声明 context 里的 blocking 缺口 → omitted-blocking-missing-fact（带 kind 与 subjectId）', () => {
    const context = AnalysisContextSchema.parse({
      ...contextFor('advice_stock', shanghai.open, shanghai.open),
      missingFacts: [
        {
          kind: 'quote-unavailable',
          subjectId: '600519.SH',
          reason: '缺少行情',
          asOf: shanghai.open,
        },
        {
          kind: 'news-unavailable',
          subjectId: '600519.SH',
          reason: '新闻源失败',
          asOf: shanghai.open,
        },
      ],
    });
    const issues = checkAnalysisReportCompleteness({ context, missingFacts: [] });
    // 只有 blocking 的那条被要求声明；degraded（news-unavailable）不强制。
    expect(issues).toEqual([
      {
        code: 'omitted-blocking-missing-fact',
        path: 'missingFacts[0]',
        message: '报告未声明 blocking 缺口: quote-unavailable / 600519.SH',
      },
    ]);

    // 声明之后不再报——证明它检查的是"有没有提"，不是"有没有缺口"。
    expect(
      checkAnalysisReportReferences({
        context,
        evidenceFactIds: context.factIds,
        missingFacts: [
          {
            kind: 'quote-unavailable',
            subjectId: '600519.SH',
            reason: '缺少行情',
            asOf: shanghai.open,
          },
        ],
      }),
    ).toEqual([]);
  });
});
