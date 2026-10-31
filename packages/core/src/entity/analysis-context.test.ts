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
  classifyMarketObservation,
  isAnalysisContextStale,
  MARKET_ADVICE_SAME_DAY_ONLY,
  MARKET_OBSERVATION_HISTORICAL_LABEL,
  MARKET_OBSERVATION_PRIOR_SESSION_LABEL,
  marketObservationLabel,
  marketObservationScope,
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
        ruleVersion: 'intraday-action-v1',
        writeWindowMs: 30 * MINUTE,
        dataMaxAgeMs: 30 * MINUTE,
        closesAtSessionEnd: true,
        sameDayOnly: false,
      });
    }
    // REQ-M3-20：市场级改成当日口径——**不再用固定毫秒数**表达数据有效期。
    // 自然日不是固定时长，写死 7 天就是伪精确的来源。
    expect(analysisTimingRules.advice_market).toEqual({
      ruleVersion: 'market-analysis-same-day-v1',
      writeWindowMs: 24 * HOUR,
      closesAtSessionEnd: false,
      sameDayOnly: true,
    });
    // 盘后策略候选：不受 15:00 截断，但仍受 24h 写回窗口与 7 天数据有效期约束；
    // 它不随市场级当日口径收窄（R3：不连坐别的 kind）。
    expect(analysisTimingRules.advice_strategy_candidate_after_close).toEqual({
      ruleVersion: 'after-close-strategy-v1',
      writeWindowMs: 24 * HOUR,
      dataMaxAgeMs: 7 * DAY,
      closesAtSessionEnd: false,
      sameDayOnly: false,
    });
    for (const kind of researchKinds) {
      expect(analysisTimingRules[kind]).toEqual({
        ruleVersion: 'research-analysis-30d-v1',
        writeWindowMs: 24 * HOUR,
        dataMaxAgeMs: 30 * DAY,
        closesAtSessionEnd: false,
        sameDayOnly: false,
      });
    }
    // 版本位是口径变更的可追溯依据（R2）：每条规则都必须带，且当日口径单独一个值。
    expect(Object.values(analysisTimingRules).every((rule) => rule.ruleVersion.length > 0)).toBe(
      true,
    );
    expect(
      new Set(Object.values(analysisTimingRules).map((rule) => rule.ruleVersion)).size,
    ).toBeGreaterThanOrEqual(4);
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
    for (const kind of researchKinds) {
      const late = analysisContextTiming(kind, shanghai.lateAfternoon, shanghai.lateAfternoon);
      expect(late.writeUntil).toEqual(new Date(shanghai.lateAfternoon.getTime() + 24 * HOUR));
    }
    // 市场级：24h 窗口被上海自然日边界封顶，不再跨到次日。
    const marketLate = analysisContextTiming(
      'advice_market',
      shanghai.lateAfternoon,
      shanghai.lateAfternoon,
    );
    expect(marketLate.writeUntil).toEqual(new Date('2026-10-23T00:00:00+08:00'));
    expect(marketLate.staleAfter).toEqual(new Date('2026-10-23T00:00:00+08:00'));
    expect(marketLate.ruleVersion).toBe('market-analysis-same-day-v1');
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

  it('allows advice_market writes only inside the same Shanghai day', () => {
    // 旧语义：收盘后可写回 24h。新语义（REQ-M3-20）：当日收盘后仍可写回，
    // 但窗口在 Asia/Shanghai 自然日边界关闭——不是 now+24h。
    const context = contextFor('advice_market', shanghai.close, shanghai.postClose);
    expect(context.writeUntil).toEqual(new Date('2026-10-23T00:00:00+08:00'));
    expect(analysisContextTimingError(context, shanghai.postClose)).toBeUndefined();
    // 当日 23:59:59.999（+08:00）仍在窗口内。
    expect(
      analysisContextTimingError(context, new Date('2026-10-22T15:59:59.999Z')),
    ).toBeUndefined();
    // 边界排他：writeUntil 是排他上界，落在 00:00:00.000 即窗口关闭。
    expect(analysisContextTimingError(context, new Date('2026-10-23T00:00:00+08:00'))).toBe(
      'context_expired',
    );
    // 跨过当日边界后 stale 与 expired 同时成立；市场类先报 stale_context，
    // 提示消费者重取当日事实，而不是以为重取 context 就能写回。
    expect(analysisContextTimingError(context, new Date('2026-10-23T00:00:01+08:00'))).toBe(
      'stale_context',
    );
  });

  it('marks any cross-day market fact stale at the Shanghai day boundary', () => {
    const assembledAt = shanghai.postClose; // 2026-10-22 16:00 +08:00
    // 昨收数据：装配后立刻 stale——当日口径不看「7 天」。
    const yesterdayClose = new Date('2026-10-21T07:00:00Z'); // 2026-10-21 15:00 +08:00
    expect(timingErrorAt('advice_market', yesterdayClose, assembledAt, assembledAt)).toBe(
      'stale_context',
    );
    expect(isAnalysisContextStale('advice_market', yesterdayClose, assembledAt)).toBe(true);
    // 当日数据在当日 23:59:59.999 仍新鲜，跨过 00:00 才 stale。
    expect(
      isAnalysisContextStale('advice_market', shanghai.close, new Date('2026-10-22T15:59:59.999Z')),
    ).toBe(false);
    expect(
      isAnalysisContextStale(
        'advice_market',
        shanghai.close,
        new Date('2026-10-23T00:00:01+08:00'),
      ),
    ).toBe(true);
    // R3：研究类仍按 30 天判定，不被市场级当日口径连坐。
    expect(isAnalysisContextStale('research_directions', yesterdayClose, assembledAt)).toBe(false);
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
    // 市场级在当日口径下跨过边界即 stale（不再是 24h 后的 context_expired），
    // 但引用错误仍然抢答——错误优先级：引用 → 时序 → 完整性。
    const outOfWindow = contextFor('advice_market', shanghai.close, shanghai.postClose);
    expect(
      analysisContextWriteError(
        outOfWindow,
        new Date(shanghai.postClose.getTime() + 25 * HOUR),
        [],
      ),
    ).toBe('stale_context');
    expect(
      analysisContextWriteError(outOfWindow, new Date(shanghai.postClose.getTime() + 25 * HOUR), [
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

// REQ-M3-20 / P10：市场级判断禁止跨日引用。判定是纯函数，渲染层与事实包装共用同一实现。
describe('REQ-M3-20 market observation same-day rule', () => {
  it('classifies the same-day pre-close observation as current', () => {
    // 当日 10:00 观测，当日 16:00 复核：同一自然日、15:00 之前 → 仍是当前依据。
    expect(classifyMarketObservation(shanghai.open, shanghai.postClose)).toBe('current');
    // 当日 14:45 同理。
    expect(classifyMarketObservation(shanghai.lateAfternoon, shanghai.postClose)).toBe('current');
    // 收盘时刻本身（15:00:00.000）不算「15:00 之后」。
    expect(classifyMarketObservation(shanghai.close, shanghai.postClose)).toBe('current');
  });

  it('downgrades post-close and cross-day observations to historical', () => {
    // 当日 15:00 之后（16:00）的观察：降级，不删除。
    expect(classifyMarketObservation(shanghai.postClose, shanghai.postClose)).toBe('historical');
    // 非当日：昨日收盘观察今天不能再当依据。
    expect(classifyMarketObservation(new Date('2026-10-21T07:00:00Z'), shanghai.postClose)).toBe(
      'historical',
    );
    // 未来时点同样不能算「当前依据」。
    expect(classifyMarketObservation(new Date('2026-10-23T02:00:00Z'), shanghai.open)).toBe(
      'historical',
    );
  });

  it('labels historical observations without hiding them', () => {
    const historicalLabel = marketObservationLabel(shanghai.postClose, shanghai.postClose);
    expect(historicalLabel).toContain(MARKET_OBSERVATION_HISTORICAL_LABEL);
    // 观测时间仍在标注里——降级不是删除。
    expect(historicalLabel).toContain(shanghai.postClose.toISOString());
    const currentLabel = marketObservationLabel(shanghai.open, shanghai.postClose);
    expect(currentLabel).not.toContain(MARKET_OBSERVATION_HISTORICAL_LABEL);
    expect(currentLabel).toContain(shanghai.open.toISOString());
  });

  // 三档口径（REQ-M3-20 / R4）：当日 / 参照日的上一交易日 / 更早或未来。
  it('scopes a market observation against the reference day, not just today', () => {
    // 实时路径：参照日 = now。
    expect(marketObservationScope(shanghai.open, shanghai.postClose)).toBe('current');
    expect(marketObservationScope(shanghai.postClose, shanghai.postClose)).toBe('historical');
    // 周四收盘观察，周五盘前引用 → 参照日的上一交易日，是盘前常态数据。
    const thursdayClose = new Date('2026-10-21T07:00:00Z'); // 2026-10-22 的前一交易日
    expect(marketObservationScope(thursdayClose, shanghai.preOpen)).toBe('prior-session');
    // 跨周末：周一参照日的前一交易日是上周五，不是「昨天」（周日）。
    const fridayClose = new Date('2026-10-16T07:00:00Z');
    const mondayPreOpen = new Date('2026-10-19T00:30:00Z');
    expect(marketObservationScope(fridayClose, mondayPreOpen)).toBe('prior-session');
    // 补跑历史报告：参照日取报告期（2026-10-23），不是 now。
    const reportDay = new Date('2026-10-23T04:00:00Z');
    expect(marketObservationScope(new Date('2026-10-22T07:00:00Z'), reportDay)).toBe(
      'prior-session',
    );
    // 同一参照日下 5 个交易日前的数据仍然是降级——第三档不是死代码。
    expect(marketObservationScope(new Date('2026-10-16T07:00:00Z'), reportDay)).toBe('historical');
    // 未来时点不是盘前常态数据，不能描述成「收盘观察」。
    expect(marketObservationScope(new Date('2026-10-26T02:00:00Z'), shanghai.open)).toBe(
      'historical',
    );
    // 分类器口径不变：能不能当参照日依据仍然只有一个答案。
    expect(classifyMarketObservation(thursdayClose, shanghai.preOpen)).toBe('historical');

    const priorLabel = marketObservationLabel(thursdayClose, shanghai.preOpen);
    expect(priorLabel).toContain(MARKET_OBSERVATION_PRIOR_SESSION_LABEL);
    expect(priorLabel).not.toContain(MARKET_OBSERVATION_HISTORICAL_LABEL);
    // 观测时间仍在标注里——区分措辞不是删除。
    expect(priorLabel).toContain(thursdayClose.toISOString());
    // 第三档措辞与第二档不同，否则读者分不清「盘前背景」和「陈旧数据」。
    expect(marketObservationLabel(new Date('2026-10-16T07:00:00Z'), reportDay)).toContain(
      MARKET_OBSERVATION_HISTORICAL_LABEL,
    );
  });

  it('treats the cross-day reason code as blocking so the context reads unavailable', () => {
    const gap = {
      kind: MARKET_ADVICE_SAME_DAY_ONLY,
      subjectId: 'market',
      reason: '市场级分析只接受当日事实；已排除跨日事实：market:limit-up:2026-10-21',
      asOf: shanghai.postClose,
    };
    expect(MARKET_ADVICE_SAME_DAY_ONLY).toBe('market-advice-same-day-only');
    expect(missingFactsAvailability([gap])).toBe('unavailable');
    // degraded 缺口与它同时存在时仍然是 unavailable（blocking 优先）。
    expect(
      missingFactsAvailability([
        {
          kind: 'news-unavailable',
          subjectId: 'market',
          reason: '未接入新闻',
          asOf: shanghai.open,
        },
        gap,
      ]),
    ).toBe('unavailable');
  });

  it('keeps a same-day market context writable and versioned', () => {
    const timing = analysisContextTiming('advice_market', shanghai.close, shanghai.postClose);
    expect(timing.ruleVersion).toBe('market-analysis-same-day-v1');
    expect(timing.writeUntil).toEqual(new Date('2026-10-23T00:00:00+08:00'));
    expect(timing.staleAfter).toEqual(new Date('2026-10-23T00:00:00+08:00'));
    // 旧 7 天规则会给出 2026-10-29 15:00 的 staleAfter；当日口径必须更早。
    expect(timing.staleAfter.getTime()).toBeLessThan(shanghai.close.getTime() + 7 * DAY);
  });
});
