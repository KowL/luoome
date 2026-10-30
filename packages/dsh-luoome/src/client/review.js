import { Fragment, createElement as h } from 'react';

import {
  adviceFeedbackOf,
  calibrationRows,
  dataOf,
  decisionLoopSummary,
  decisionReviewRows,
  errorOf,
  usePanelState,
} from './data.js';
import {
  clock,
  DECISION,
  HORIZON,
  int,
  money,
  OBSERVATION_HORIZON,
  OBSERVATION_STATUS,
  points,
  ratio,
  relative,
  shortId,
  subjectTitle,
  when,
} from './format.js';
import {
  Card,
  Empty,
  ErrorNote,
  Footer,
  Head,
  Kpi,
  Meter,
  Pill,
  Refresh,
  Section,
  SkeletonLines,
  Stamp,
  Stat,
} from './primitives.js';

const OutcomeCard = ({ stats }) => {
  const outcome = stats.outcomeRate ?? {};
  const rows = [
    { key: 'followed', label: '跟随', value: outcome.followed, tone: 'accent' },
    { key: 'partially', label: '部分跟随', value: outcome.partiallyFollowed, tone: 'warn' },
    { key: 'ignored', label: '忽略', value: outcome.ignored, tone: 'quiet' },
  ];
  return h(
    Card,
    { title: '回填结果分布', meta: `${int(stats.feedbackCount)} 条明确回填` },
    h(
      'div',
      { style: { display: 'grid', gap: '12px' } },
      rows.map((row) =>
        h(
          'div',
          { key: row.key },
          h(
            'div',
            { className: 'luo-meter-row' },
            h('span', { className: 'luo-stat-k', style: { flex: '0 0 64px' } }, row.label),
            h(Meter, { value: (row.value ?? 0) * 100, tone: row.tone }),
            h('span', { className: 'luo-meter-cap' }, ratio(row.value, 1, false)),
          ),
        ),
      ),
      h(
        'p',
        { className: 'luo-fine', style: { margin: 0 } },
        '按用户明确回填的 outcome 统计；缺失盈亏不计为零。',
      ),
    ),
  );
};

const DecisionTable = ({ stats }) => {
  const entries = Object.entries(stats.byDecision ?? {});
  if (entries.length === 0) {
    return h(Card, { title: '按决策分层' }, h(Empty, { mark: '○', title: '还没有可分层的建议' }));
  }
  return h(
    Card,
    { title: '按决策分层', meta: `${entries.length} 类` },
    h(
      'div',
      { className: 'luo-table-wrap' },
      h(
        'table',
        { className: 'luo-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '决策'),
            h('th', null, '条数'),
            h('th', null, '均信心'),
            h('th', null, '回填'),
            h('th', null, '盈利占比'),
          ),
        ),
        h(
          'tbody',
          null,
          entries.map(([decision, item]) => {
            const meta = DECISION[decision] ?? { label: decision, tone: 'quiet' };
            const hitRate = typeof item.hitRate === 'number' ? item.hitRate : null;
            return h(
              'tr',
              { key: decision },
              h(
                'td',
                null,
                h(Pill, { tone: meta.tone === 'quiet' ? 'quiet' : meta.tone }, meta.label),
              ),
              h('td', null, int(item.totalAdvices)),
              h('td', null, points(item.avgConfidence, 1, false)),
              h('td', null, int(item.feedbackCount)),
              h(
                'td',
                { className: hitRate !== null && hitRate > 0 ? 'luo-up' : undefined },
                hitRate === null ? '样本不足' : ratio(hitRate, 1, false),
              ),
            );
          }),
        ),
      ),
    ),
  );
};

const ObservationsTable = ({ pending, loading, error }) => {
  if (!pending) {
    return h(
      Section,
      { title: '待补观察', meta: loading ? '读取中' : null },
      loading ? h(SkeletonLines, { lines: 3 }) : h(ErrorNote, { label: '待补观察', error }),
    );
  }
  const rows = pending.observations ?? [];
  if (rows.length === 0) {
    return h(
      Section,
      { title: '待补观察', meta: '0 条' },
      h(Card, null, h(Empty, { mark: '✓', title: '没有到期待补的信号观察' })),
    );
  }
  return h(
    Section,
    { title: '待补观察', meta: `${rows.length} 条` },
    h(
      Card,
      null,
      h(
        'div',
        { className: 'luo-table-wrap', style: { maxHeight: '320px' } },
        h(
          'table',
          { className: 'luo-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, '标的'),
              h('th', null, '周期'),
              h('th', null, '应完成'),
              h('th', null, '尝试'),
              h('th', null, '状态'),
            ),
          ),
          h(
            'tbody',
            null,
            rows
              .slice(0, 40)
              .map((item) =>
                h(
                  'tr',
                  { key: item.id },
                  h('td', null, h('span', { className: 'luo-stock-name' }, item.stockId)),
                  h('td', null, OBSERVATION_HORIZON[item.horizon] ?? item.horizon),
                  h('td', null, when(item.dueAt)),
                  h('td', null, int(item.attemptCount ?? 0)),
                  h('td', null, OBSERVATION_STATUS[item.status] ?? item.status),
                ),
              ),
          ),
        ),
      ),
      rows.length > 40
        ? h(
            'p',
            { className: 'luo-fine', style: { margin: '10px 0 0' } },
            `仅显示前 40 条，共 ${rows.length} 条。`,
          )
        : null,
    ),
  );
};

const CalibrationCard = ({ calibration, loading, error }) => {
  if (!calibration) {
    return h(
      Card,
      { title: '信心校准', meta: loading ? '读取中' : null },
      loading ? h(SkeletonLines, { lines: 4 }) : h(ErrorNote, { label: '信心校准', error }),
    );
  }
  const rows = calibrationRows(calibration);
  const meta = `${int(calibration.totalAdvices)} 条建议 · ${int(calibration.totalWithOutcome)} 条明确回填`;
  if (rows.length === 0) {
    return h(
      Card,
      { title: '信心校准', meta },
      h(Empty, { mark: '○', title: '还没有可校准的样本' }),
    );
  }
  return h(
    Card,
    { title: '信心校准', meta },
    h(
      'div',
      { className: 'luo-table-wrap', style: { maxHeight: '320px' } },
      h(
        'table',
        { className: 'luo-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '信心桶'),
            h('th', null, '建议'),
            h('th', null, '明确回填'),
            h('th', null, '跟随且有盈亏'),
            h('th', null, '命中率'),
            h('th', null, '平均信心'),
          ),
        ),
        h(
          'tbody',
          null,
          rows.map((row) =>
            h(
              'tr',
              { key: row.key },
              h('td', null, row.range),
              h('td', null, int(row.total)),
              h('td', null, int(row.withOutcome)),
              h('td', null, int(row.followedWithPnl)),
              h(
                'td',
                null,
                row.hitRate === null
                  ? '—'
                  : row.followedWithPnl < 20
                    ? '样本不足'
                    : ratio(row.hitRate, 1, false),
              ),
              h('td', null, points(row.avgConfidence, 1, false)),
            ),
          ),
        ),
      ),
    ),
    h(
      'p',
      { className: 'luo-fine', style: { margin: '10px 0 0' } },
      '按信心桶投影工具输出；只有明确回填且跟随并有盈亏的样本进入命中率，少于 20 条不提供比例结论。',
    ),
  );
};

const DecisionReviewCard = ({ reviewList, loading, error }) => {
  if (!reviewList) {
    return h(
      Card,
      { title: '最近决策复盘', meta: loading ? '读取中' : null },
      loading ? h(SkeletonLines, { lines: 4 }) : h(ErrorNote, { label: '决策复盘', error }),
    );
  }
  const rows = decisionReviewRows(reviewList);
  if (rows.length === 0) {
    return h(
      Card,
      { title: '最近决策复盘', meta: '0 条' },
      h(Empty, { mark: '○', title: '还没有决策复盘记录' }),
    );
  }
  return h(
    Card,
    { title: '最近决策复盘', meta: `${rows.length} 条 · 按 fact 时间` },
    h(
      'div',
      { className: 'luo-table-wrap', style: { maxHeight: '320px' } },
      h(
        'table',
        { className: 'luo-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '对象'),
            h('th', null, '来源'),
            h('th', null, '来源时点'),
            h('th', null, '修订'),
            h('th', null, '记录时点'),
            h('th', null, '备注'),
          ),
        ),
        h(
          'tbody',
          null,
          rows.map((row) =>
            h(
              'tr',
              { key: row.key },
              h('td', null, h('span', { className: 'luo-stock-name' }, row.subjectId)),
              h('td', null, h(Pill, { tone: 'quiet' }, row.kindLabel)),
              h('td', null, when(row.sourceOccurredAt)),
              h('td', null, int(row.currentRevision)),
              h('td', null, when(row.recordedAt)),
              h('td', null, row.changeNote ?? '—'),
            ),
          ),
        ),
      ),
    ),
  );
};

const AdviceFeedbackCard = ({ advices, loading, error }) => {
  if (!advices) {
    return h(
      Card,
      { title: '逐条建议与用户反馈', meta: loading ? '读取中' : null },
      loading ? h(SkeletonLines, { lines: 4 }) : h(ErrorNote, { label: '逐条建议', error }),
    );
  }
  const rows = advices.slice(0, 20);
  if (rows.length === 0) {
    return h(
      Card,
      { title: '逐条建议与用户反馈', meta: '0 条' },
      h(Empty, { mark: '○', title: '还没有建议记录' }),
    );
  }
  return h(
    Card,
    { title: '逐条建议与用户反馈', meta: `${advices.length} 条 · 最多展示 20 条` },
    h(
      'div',
      { className: 'luo-table-wrap', style: { maxHeight: '360px' } },
      h(
        'table',
        { className: 'luo-table' },
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, '标的'),
            h('th', null, '结论'),
            h('th', null, '信心'),
            h('th', null, '周期'),
            h('th', null, '有效期'),
            h('th', null, '用户反馈'),
            h('th', null, '备注'),
          ),
        ),
        h(
          'tbody',
          null,
          rows.map((advice) => {
            const feedback = adviceFeedbackOf(advice);
            const decision = DECISION[advice.decision] ?? { label: advice.decision, tone: 'quiet' };
            return h(
              'tr',
              { key: advice.id },
              h(
                'td',
                null,
                h('span', { className: 'luo-stock-name' }, subjectTitle(advice)),
                h('span', { className: 'luo-fine' }, ` ${shortId(advice.id)}`),
              ),
              h(
                'td',
                null,
                h(
                  Pill,
                  { tone: decision.tone === 'quiet' ? 'quiet' : decision.tone },
                  decision.label,
                ),
              ),
              h('td', null, points(advice.confidence, 1, false)),
              h('td', null, HORIZON[advice.horizon] ?? advice.horizon),
              h('td', null, when(advice.validUntil)),
              h(
                'td',
                null,
                feedback
                  ? h(
                      Pill,
                      { tone: feedback.tone === 'quiet' ? 'quiet' : feedback.tone },
                      feedback.label,
                    )
                  : h('span', { className: 'luo-fine' }, '未回填（不推断）'),
                feedback?.pnl === null || feedback?.pnl === undefined
                  ? null
                  : h('span', { className: 'luo-fine' }, ` ${money(feedback.pnl)}`),
              ),
              h('td', null, feedback?.notes ?? '—'),
            );
          }),
        ),
      ),
    ),
    h(
      'p',
      { className: 'luo-fine', style: { margin: '10px 0 0' } },
      '用户反馈只来自明确回填的 outcome；没有回填显示“未回填”，不按股价走势推断跟随或盈亏。',
    ),
  );
};

const DecisionLoopCard = ({ summary, loading, error }) => {
  if (!summary) {
    return h(
      Card,
      { title: '决策闭环摘要', meta: loading ? '读取中' : null },
      loading ? h(SkeletonLines, { lines: 4 }) : h(ErrorNote, { label: '决策闭环', error }),
    );
  }
  const records = summary.decisionRecords ?? {};
  const observations = summary.signalObservations ?? {};
  return h(
    Card,
    { title: '决策闭环摘要', meta: `事实时点 ${when(summary.dataAsOf)}` },
    h(
      'div',
      { className: 'luo-stats' },
      h(Stat, { k: '证据引用', v: int(summary.evidenceCount) }),
      h(Stat, { k: '决策记录', v: int(records.total) }),
      h(Stat, { k: '关联成交', v: int(records.linkedTrades) }),
      h(Stat, { k: '信号观察', v: int(observations.total) }),
      h(Stat, { k: '观察完成', v: int(observations.complete) }),
      h(Stat, {
        k: '观察缺口',
        v: int(observations.unavailable),
        tone: observations.unavailable > 0 ? 'warn' : undefined,
      }),
    ),
    h(
      'p',
      { className: 'luo-fine', style: { margin: '10px 0 0' } },
      `时间范围 ${summary.since ? when(summary.since) : '不限'} → ${summary.until ? when(summary.until) : '至今'}；仅描述性投影，不推断因果。`,
    ),
    summary.unknowns.length > 0
      ? h(
          'p',
          { className: 'luo-fine', style: { margin: '6px 0 0' } },
          `未知：${summary.unknowns.join('；')}`,
        )
      : null,
    summary.limitations.length > 0
      ? h(
          'p',
          { className: 'luo-fine', style: { margin: '6px 0 0' } },
          `限制：${summary.limitations.join('；')}`,
        )
      : null,
  );
};

export function ReviewPanel() {
  const { results, loading, panelError, loadedAt, refresh } = usePanelState('review');
  const stats = dataOf(results, 'get_advice_stats');
  const calibration = dataOf(results, 'get_confidence_calibration');
  const reviews = dataOf(results, 'list_decision_reviews');
  const adviceList = dataOf(results, 'get_advice')?.advices ?? null;
  const loop = decisionLoopSummary(dataOf(results, 'get_decision_loop_review'));
  const pending = dataOf(results, 'list_pending_strategy_observations');

  return h(
    Fragment,
    null,
    h(Head, {
      eyebrow: 'LUOOME / 复盘',
      title: '复盘',
      subtitle: '建议表现 · 信心校准 · 待补观察',
      side: [
        h(Stamp, { key: 'stamp', label: '更新', value: clock(loadedAt) }),
        h(Refresh, { key: 'refresh', loading, onClick: refresh }),
      ],
    }),
    panelError
      ? h(
          'div',
          { style: { marginTop: '16px' } },
          h(ErrorNote, { label: '事实读取', error: panelError }),
        )
      : null,
    h(
      Section,
      { title: '建议表现', delay: 40 },
      stats
        ? h(
            'div',
            { className: 'luo-grid is-kpi' },
            h(Kpi, { label: '建议总数', value: int(stats.totalAdvices), sub: '在期与历史' }),
            h(Kpi, {
              label: '平均信心',
              value: points(stats.avgConfidence, 1, false),
              sub: '信心度不是概率',
            }),
            h(Kpi, {
              label: '明确回填',
              value: `${int(stats.feedbackCount)} 条`,
              sub: `有盈亏样本 ${int(stats.followedWithPnl)} 条`,
            }),
            h(Kpi, {
              label: '填报盈利占比',
              value:
                typeof stats.hitRate === 'number' ? ratio(stats.hitRate, 1, false) : '样本不足',
              tone: typeof stats.hitRate === 'number' && stats.hitRate > 0 ? 'up' : undefined,
              sub: '仅统计明确跟随且有盈亏的样本',
            }),
          )
        : h(
            Card,
            null,
            loading
              ? h(SkeletonLines, { lines: 3 })
              : h(ErrorNote, { label: '建议表现', error: errorOf(results, 'get_advice_stats') }),
          ),
    ),
    stats
      ? h(
          Section,
          { delay: 100 },
          h(
            'div',
            { className: 'luo-grid is-two' },
            h(DecisionTable, { stats }),
            h(OutcomeCard, { stats }),
          ),
        )
      : null,
    h(
      Section,
      { title: '信心校准', delay: 140 },
      h(CalibrationCard, {
        calibration,
        loading,
        error: errorOf(results, 'get_confidence_calibration'),
      }),
    ),
    h(
      Section,
      { title: '最近决策复盘', delay: 170 },
      h(DecisionReviewCard, {
        reviewList: reviews,
        loading,
        error: errorOf(results, 'list_decision_reviews'),
      }),
    ),
    h(
      Section,
      { title: '逐条建议与用户反馈', delay: 200 },
      h(AdviceFeedbackCard, {
        advices: adviceList,
        loading,
        error: errorOf(results, 'get_advice'),
      }),
    ),
    h(
      Section,
      { title: '决策闭环摘要', delay: 230 },
      h(DecisionLoopCard, {
        summary: loop,
        loading,
        error: errorOf(results, 'get_decision_loop_review'),
      }),
    ),
    h(ObservationsTable, {
      pending,
      loading,
      error: errorOf(results, 'list_pending_strategy_observations'),
    }),
    h(Footer, {
      left: h(
        'span',
        null,
        h('b', null, '只读事实投影'),
        ' · 准确率不等于收益承诺；缺失盈亏不计为零，样本不足不提供校准结论。',
      ),
      right: h('span', null, relative(loadedAt)),
    }),
  );
}
