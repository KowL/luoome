import { createElement as h } from 'react';

import { dataOf, errorOf, useFactPanels } from './data.js';
import {
  clock,
  DECISION,
  int,
  OBSERVATION_HORIZON,
  OBSERVATION_STATUS,
  points,
  ratio,
  relative,
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
  Panel,
  Pill,
  Refresh,
  Section,
  SkeletonLines,
  Stamp,
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

export function ReviewPanel() {
  const { results, loading, panelErrors, loadedAt, refresh } = useFactPanels('review');
  const stats = dataOf(results, 'get_advice_stats');
  const pending = dataOf(results, 'list_pending_strategy_observations');

  return h(
    Panel,
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
    panelErrors.review
      ? h(
          'div',
          { style: { marginTop: '16px' } },
          h(ErrorNote, { label: '事实读取', error: panelErrors.review }),
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
