import { buildStrategyHash, parseStrategyHash } from './strategy-workspace-route.js';
import {
  badge,
  createFeatureCache,
  el,
  errorText,
  fmtDateTime,
  fmtNum,
  metric,
} from './strategy-workspace-shared.js';

const featureCache = createFeatureCache();
const { cachedGet } = featureCache;
export const invalidateInsightsCache = () => featureCache.clear();

const pct = (value) => (value === undefined ? '--' : `${String(fmtNum(value * 100, 2))}%`);

export const renderInsights = async (
  strategyId,
  _setStatus = () => {},
  scope = 'operational',
  state = parseStrategyHash(typeof window === 'undefined' ? '' : window.location.hash),
) => {
  const path = `/api/strategies/${encodeURIComponent(strategyId)}/insights?scope=${encodeURIComponent(scope)}`;
  const result = await cachedGet(path);
  if (!result.ok) return el('p', 'status error', errorText(result));
  const facts = result.data;
  const observationRows = facts.observations.map((item) =>
    el('tr', null, [
      el('td', 'mono', item.horizon.toUpperCase()),
      el('td', null, `${item.complete}/${item.total}`),
      el('td', null, item.uniqueStocks ?? '--'),
      el('td', null, pct(item.averageReturnPct)),
      el('td', null, pct(item.medianReturnPct)),
      el('td', null, pct(item.p25ReturnPct)),
      el('td', null, pct(item.p75ReturnPct)),
      el('td', null, pct(item.averageExcessReturnPct)),
      el('td', null, pct(item.averageMaxFavorableExcursionPct)),
      el('td', null, pct(item.averageMaxAdverseExcursionPct)),
      el('td', null, item.total === 0 ? '--' : pct(item.missingRate)),
      el('td', null, item.benchmarkStatus === 'complete' ? '可用' : '不可用'),
      el('td', null, item.observedAsOf ? fmtDateTime(item.observedAsOf) : '--'),
    ]),
  );
  const groupedRows = (facts.groupedObservations ?? [])
    .slice(0, 36)
    .map((item) =>
      el('tr', null, [
        el('td', null, item.dimension),
        el('td', null, item.group),
        el('td', 'mono', item.horizon.toUpperCase()),
        el('td', null, `${item.complete}/${item.total}`),
        el('td', null, item.uniqueStocks ?? '--'),
        el('td', null, pct(item.averageReturnPct)),
        el('td', null, pct(item.medianReturnPct)),
        el('td', null, pct(item.p25ReturnPct)),
        el('td', null, pct(item.p75ReturnPct)),
        el('td', null, pct(item.averageMaxFavorableExcursionPct)),
        el('td', null, pct(item.averageMaxAdverseExcursionPct)),
        el('td', null, item.total === 0 ? '--' : pct(item.missingRate)),
        el('td', null, item.benchmarkStatus === 'complete' ? '可用' : '不可用'),
        el('td', null, item.observedAsOf ? fmtDateTime(item.observedAsOf) : '--'),
      ]),
    );
  return el('div', 'strategy-insight-grid', [
    el('div', 'strategy-tab-heading', [
      el('div', null, [
        el('span', 'section-kicker', 'FACT-BASED INSIGHTS'),
        el('h3', null, '策略事实与真实表现'),
        el(
          'p',
          'muted',
          `范围：${facts.scope === 'evaluation' ? '历史评估' : '生产'} · 近 ${facts.window.days} 天 · 事实截止 ${fmtDateTime(facts.factsAsOf)} · 观察截止 ${facts.observationAsOf ? fmtDateTime(facts.observationAsOf) : '暂无'}`,
        ),
      ]),
      el('div', 'row-actions', [
        ...['operational', 'evaluation'].map((candidate) => {
          const button = el(
            'button',
            `btn btn-outline btn-sm${candidate === scope ? ' active' : ''}`,
            candidate === 'evaluation' ? '历史评估' : '生产事实',
          );
          button.type = 'button';
          button.addEventListener('click', () => {
            window.location.hash = buildStrategyHash({ ...state, scope: candidate });
          });
          return button;
        }),
      ]),
    ]),
    el('div', 'strategy-summary-grid', [
      metric('运行次数', facts.runs.total, `可用 ${facts.runs.usable} · 失败 ${facts.runs.failed}`),
      metric('当前明确命中', facts.currentSelection.selectedCount),
      metric(
        '平均评分',
        facts.currentSelection.averageScore === undefined
          ? '--'
          : fmtNum(facts.currentSelection.averageScore, 2),
      ),
      metric('关联预警', facts.alertPlans.length),
    ]),
    el('section', 'strategy-insight-section', [
      el('h4', null, '真实信号观察'),
      el(
        'p',
        'muted',
        '样本口径：同一股票、同一基准交易日、同一观察周期只保留一个可追溯事实；缺失 benchmark 保持不可用，不回填为 0。',
      ),
      el('div', 'table-wrap', [
        el('table', 'table', [
          el(
            'thead',
            null,
            el(
              'tr',
              null,
              [
                '周期',
                '完整样本',
                '唯一股票',
                '平均收益',
                '中位收益',
                'P25',
                'P75',
                '平均超额',
                '平均最大有利',
                '平均最大不利',
                '缺失率',
                '基准',
                '观察截止',
              ].map((label) => el('th', null, label)),
            ),
          ),
          el('tbody', null, observationRows),
        ]),
      ]),
      el('p', 'muted', '事后事实观察不是回测；未包含成交、费用、滑点和可交易性假设。'),
    ]),
    ...(groupedRows.length === 0
      ? []
      : [
          el('section', 'strategy-insight-section', [
            el('h4', null, '去相关分组统计'),
            el('div', 'table-wrap', [
              el('table', 'table', [
                el(
                  'thead',
                  null,
                  el(
                    'tr',
                    null,
                    [
                      '维度',
                      '分组',
                      '周期',
                      '完整样本',
                      '唯一股票',
                      '平均收益',
                      '中位收益',
                      'P25',
                      'P75',
                      '平均最大有利',
                      '平均最大不利',
                      '缺失率',
                      '基准',
                      '观察截止',
                    ].map((label) => el('th', null, label)),
                  ),
                ),
                el('tbody', null, groupedRows),
              ]),
            ]),
          ]),
        ]),
    el('div', 'strategy-insight-columns', [
      el('section', 'strategy-insight-section', [
        el('h4', null, '高频规则阻断'),
        ...(facts.blockers.length === 0
          ? [el('p', 'placeholder', '暂无明确阻断事实。')]
          : facts.blockers.map((item) =>
              el('article', 'entity-item', [
                el('strong', null, item.ruleName),
                el('span', 'mono muted', `${item.count} 次`),
              ]),
            )),
      ]),
      el('section', 'strategy-insight-section', [
        el('h4', null, '当前行业分布'),
        ...(facts.currentSelection.industries.length === 0
          ? [el('p', 'placeholder', '当前没有明确命中标的。')]
          : facts.currentSelection.industries.map((item) =>
              el('article', 'entity-item', [
                el('strong', null, item.name),
                el('span', 'mono muted', `${item.count} 只 · ${pct(item.share)}`),
              ]),
            )),
      ]),
      el('section', 'strategy-insight-section', [
        el('h4', null, '关联 AlertPlan'),
        ...(facts.alertPlans.length === 0
          ? [el('p', 'placeholder', '尚未关联预警方案。')]
          : facts.alertPlans.map((item) =>
              el('article', 'entity-item', [
                el('strong', null, item.name),
                badge(item.enabled ? ['已启用', 'badge-active'] : ['已停用', 'badge-neutral'], ''),
                el('span', 'mono muted', `${item.ruleCount} 条策略信号规则`),
              ]),
            )),
      ]),
    ]),
    el(
      'div',
      'strategy-health-banner warning',
      facts.limitations.map((limitation) => el('p', null, limitation)),
    ),
  ]);
};
