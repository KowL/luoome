import { createElement as h } from 'react';

import { dataOf, errorOf, useFactPanels } from './data.js';
import {
  clock,
  int,
  OBSERVATION_HORIZON,
  OBSERVATION_STATUS,
  OWNER,
  RUN_STATUS,
  ratio,
  relative,
  STRATEGY_STATUS,
  versionTag,
  WATCH_STATE,
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
  Stat,
} from './primitives.js';

const StrategyRow = ({ strategy }) => {
  const status = STRATEGY_STATUS[strategy.status] ?? { label: strategy.status, tone: 'quiet' };
  return h(
    'div',
    { className: 'luo-strategy-row' },
    h(
      'div',
      null,
      h(
        'div',
        { className: 'luo-strategy-name' },
        strategy.name,
        h(Pill, { tone: status.tone === 'quiet' ? 'quiet' : status.tone }, status.label),
        h(Pill, { tone: 'quiet' }, OWNER[strategy.owner] ?? strategy.owner),
      ),
      h('div', { className: 'luo-strategy-desc' }, strategy.description),
      h(
        'div',
        { className: 'luo-strategy-tags' },
        h(Pill, { tone: 'quiet' }, strategy.id),
        strategy.currentVersionId
          ? h(Pill, { tone: 'quiet' }, versionTag(strategy.currentVersionId))
          : h(Pill, { tone: 'warn' }, '未发布'),
      ),
    ),
    h(
      'div',
      { className: 'luo-strategy-side' },
      h('div', null, relative(strategy.updatedAt)),
      h('div', null, `建 ${when(strategy.createdAt)}`),
    ),
  );
};

const StrategyCatalog = ({ strategies, loading, error }) => {
  if (!strategies) {
    return h(
      Card,
      { title: '策略目录', meta: loading ? '读取中' : null },
      loading ? h(SkeletonLines, { lines: 6 }) : h(ErrorNote, { label: '策略目录', error }),
    );
  }
  const rows = strategies.strategies ?? [];
  if (rows.length === 0) {
    return h(
      Card,
      { title: '策略目录', meta: '0 个' },
      h(Empty, {
        mark: '◇',
        title: '还没有策略',
        hint: '前置：策略定义与版本发布仍由既有工具面完成。',
      }),
    );
  }
  return h(
    Card,
    { title: '策略目录', meta: `${strategies.total} 个` },
    h(
      'div',
      { className: 'luo-list' },
      rows.map((strategy) => h(StrategyRow, { key: strategy.id, strategy })),
    ),
  );
};

const WatchHealthCard = ({ watch, loading, error }) => {
  if (!watch) {
    return h(
      Card,
      { title: '盯盘健康', meta: loading ? '读取中' : null },
      loading ? h(SkeletonLines, { lines: 4 }) : h(ErrorNote, { label: '盯盘健康', error }),
    );
  }
  const state = WATCH_STATE[watch.state] ?? { label: watch.state, tone: 'quiet' };
  const latest = watch.latest;
  return h(
    Card,
    {
      title: '盯盘健康',
      meta: latest ? `最近 ${relative(latest.finishedAt ?? latest.startedAt)}` : '尚未运行',
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } },
      h(Pill, { tone: state.tone === 'quiet' ? 'quiet' : state.tone, dot: true }, state.label),
      latest
        ? h(
            Pill,
            { tone: latest.status === 'failed' ? 'bad' : 'quiet' },
            `状态 ${RUN_STATUS[latest.status] ?? latest.status}`,
          )
        : null,
      h('span', { className: 'luo-fine' }, `心跳阈值 ${int(watch.staleAfterSeconds)} 秒`),
    ),
    latest
      ? h(
          'div',
          null,
          h('div', { className: 'luo-divider' }),
          h(
            'div',
            { className: 'luo-stats' },
            h(Stat, { k: '评估股票', v: int(latest.evaluatedStocks) }),
            h(Stat, {
              k: '触发',
              v: int(latest.triggered),
              tone: latest.triggered > 0 ? 'up' : undefined,
            }),
            h(Stat, { k: '投递尝试', v: int(latest.notified) }),
            h(Stat, {
              k: '投递失败',
              v: int(latest.notifyFailed),
              tone: latest.notifyFailed > 0 ? 'down' : undefined,
            }),
            h(Stat, { k: '冷却抑制', v: int(latest.suppressedByCooldown) }),
            h(Stat, { k: '日限抑制', v: int(latest.suppressedByDailyLimit) }),
          ),
          latest.error
            ? h('p', { className: 'luo-err', style: { marginTop: '12px' } }, latest.error)
            : null,
        )
      : h(Empty, { mark: '○', title: '还没有 WatchRun 心跳', hint: '定时工具触发后会更新这里。' }),
  );
};

const ReliabilityCard = ({ summary, loading, error }) => {
  if (!summary) {
    return h(
      Card,
      { title: '运行与发布', meta: loading ? '读取中' : null },
      loading ? h(SkeletonLines, { lines: 5 }) : h(ErrorNote, { label: '运行与发布', error }),
    );
  }
  const runs = summary.statuses ?? {};
  const publications = summary.publications ?? {};
  const checkpoints = summary.checkpoints ?? {};
  const observations = summary.observations ?? {};
  return h(
    Card,
    {
      title: '运行与发布',
      meta: `${summary.runCount} 次运行 · ${summary.tradingDays} 个交易日`,
    },
    h(
      'div',
      { className: 'luo-stats' },
      h(Stat, { k: '成功', v: int(runs.succeeded), tone: 'up' }),
      h(Stat, { k: '部分', v: int(runs.partial), tone: runs.partial > 0 ? 'warn' : undefined }),
      h(Stat, { k: '失败', v: int(runs.failed), tone: runs.failed > 0 ? 'down' : undefined }),
      h(Stat, { k: '发布', v: int(publications.published) }),
      h(Stat, { k: '暂缓', v: int(publications.withheld) }),
      h(Stat, {
        k: '缺失',
        v: int(publications.missing),
        tone: publications.missing > 0 ? 'warn' : undefined,
      }),
    ),
    h('div', { className: 'luo-divider' }),
    h(
      'div',
      { style: { display: 'grid', gap: '10px' } },
      h(
        'div',
        null,
        h(
          'div',
          { className: 'luo-meter-row' },
          h('span', { className: 'luo-stat-k', style: { flex: '0 0 auto' } }, '数据覆盖'),
          h(Meter, { value: checkpoints.coverageRatio * 100 }),
          h('span', { className: 'luo-meter-cap' }, ratio(checkpoints.coverageRatio, 1, false)),
        ),
      ),
      h(
        'div',
        { className: 'luo-stats' },
        h(Stat, {
          k: '待补观察',
          v: int(observations.pending),
          tone: observations.pending > 0 ? 'warn' : undefined,
        }),
        h(Stat, { k: '已完成观察', v: int(observations.completed) }),
        h(Stat, {
          k: '租约丢',
          v: int(summary.leases?.leaseLost),
          tone: summary.leases?.leaseLost > 0 ? 'down' : undefined,
        }),
        h(Stat, {
          k: '通知失败',
          v: int(summary.notifications?.failed),
          tone: summary.notifications?.failed > 0 ? 'down' : undefined,
        }),
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
    { title: '待补观察', meta: `${rows.length} 条 · ${pending.stockIds?.length ?? 0} 只标的` },
    h(
      Card,
      null,
      h(
        'div',
        { className: 'luo-table-wrap', style: { maxHeight: '300px' } },
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
              h('th', null, '基准价'),
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
                  h(
                    'td',
                    null,
                    item.baselinePrice === undefined ? '—' : item.baselinePrice.toFixed(2),
                  ),
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

export function StrategiesPanel() {
  const { results, loading, panelErrors, loadedAt, refresh } = useFactPanels('strategies');
  const strategies = dataOf(results, 'list_strategies');
  const watch = dataOf(results, 'get_watch_status');
  const reliability = dataOf(results, 'get_strategy_reliability_summary');
  const pending = dataOf(results, 'list_pending_strategy_observations');

  const total = strategies?.total ?? 0;
  const active = (strategies?.strategies ?? []).filter((item) => item.status === 'active').length;
  const paused = (strategies?.strategies ?? []).filter(
    (item) => item.status === 'paused' || item.status === 'draft',
  ).length;
  const pendingCount = pending?.observations?.length ?? null;

  return h(
    Panel,
    null,
    h(Head, {
      eyebrow: 'LUOOME / 策略看板',
      title: '策略看板',
      subtitle: '版本 · 运行 · 发布 · 观察，一张板看全',
      side: [
        h(Stamp, { key: 'stamp', label: '更新', value: clock(loadedAt) }),
        h(Refresh, { key: 'refresh', loading, onClick: refresh }),
      ],
    }),
    panelErrors.strategies
      ? h(
          'div',
          { style: { marginTop: '16px' } },
          h(ErrorNote, { label: '事实读取', error: panelErrors.strategies }),
        )
      : null,
    h(
      Section,
      { title: '总览', delay: 40 },
      h(
        'div',
        { className: 'luo-grid is-kpi' },
        h(Kpi, {
          label: '策略',
          value: strategies ? `${int(total)} 个` : '—',
          sub: strategies
            ? `内置 ${(strategies.strategies ?? []).filter((item) => item.owner === 'builtin').length} · 自建 ${(strategies.strategies ?? []).filter((item) => item.owner === 'user').length}`
            : '',
        }),
        h(Kpi, {
          label: '启用中',
          value: strategies ? `${int(active)} 个` : '—',
          tone: active > 0 ? 'ok' : undefined,
        }),
        h(Kpi, {
          label: '暂停 / 草稿',
          value: strategies ? `${int(paused)} 个` : '—',
          tone: paused > 0 ? 'warn' : undefined,
        }),
        h(Kpi, {
          label: '待补观察',
          value: pendingCount === null ? '—' : `${int(pendingCount)} 条`,
          tone: pendingCount > 0 ? 'warn' : undefined,
          sub: pending ? `${pending.stockIds?.length ?? 0} 只标的` : '',
        }),
      ),
    ),
    h(
      Section,
      { delay: 100 },
      h(
        'div',
        { className: 'luo-grid is-two' },
        h(StrategyCatalog, { strategies, loading, error: errorOf(results, 'list_strategies') }),
        h(
          'div',
          { className: 'luo-grid', style: { gridTemplateColumns: 'minmax(0, 1fr)' } },
          h(WatchHealthCard, { watch, loading, error: errorOf(results, 'get_watch_status') }),
          h(ReliabilityCard, {
            summary: reliability,
            loading,
            error: errorOf(results, 'get_strategy_reliability_summary'),
          }),
        ),
      ),
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
        ' · 策略发布与运行操作仍走既有工具面；看板只投影版本、运行与发布结果。',
      ),
      right: h('span', null, relative(loadedAt)),
    }),
  );
}
