import { createElement as h, useEffect, useState } from 'react';
import { dailyCycleAvailable, dailyCycleResult } from './daily-cycle.js';
import {
  dataOf,
  errorOf,
  strategyExpression,
  strategyPartDataOf,
  strategyPartErrorOf,
  strategyText,
  usePanelState,
  workspaceDataOf,
  workspaceErrorOf,
} from './data.js';
import {
  clock,
  HORIZON,
  int,
  money,
  OBSERVATION_HORIZON,
  OBSERVATION_STATUS,
  OWNER,
  points,
  RUN_STATUS,
  ratio,
  relative,
  STRATEGY_STATUS,
  WATCH_STATE,
  when,
} from './format.js';
import {
  Card,
  Empty,
  ErrorNote,
  Footer,
  Head,
  Meter,
  Panel,
  Pill,
  Refresh,
  Section,
  SkeletonLines,
  Stamp,
  Stat,
} from './primitives.js';
import { ResearchOnboarding, ResearchWorkbench } from './research.js';
import { useResearchOperation } from './research-data.js';
import { OperationReceipt } from './research-results.js';
import { StockDetail } from './stock.js';

const safeError = (error) =>
  error
    ? {
        message:
          strategyText(typeof error === 'string' ? error : error.message) ||
          '暂时无法读取，请刷新重试。',
      }
    : null;

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
            ? h(
                'p',
                { className: 'luo-err', style: { marginTop: '12px' } },
                strategyText(latest.error),
              )
            : null,
        )
      : h(Empty, { mark: '○', title: '尚无盯盘记录', hint: '执行盯盘后会更新运行状态。' }),
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
          k: '运行中断',
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

const STRATEGY_HEALTH = {
  ready: { label: '运行完成', tone: 'ok' },
  'never-run': { label: '尚未运行', tone: 'quiet' },
  running: { label: '正在运行', tone: 'accent' },
  partial: { label: '数据部分可用', tone: 'warn' },
  withheld: { label: '最近结果未发布', tone: 'warn' },
  failed: { label: '最近运行失败', tone: 'bad' },
};
const RULE_STATUS = {
  matched: { label: '满足', tone: 'ok' },
  'not-matched': { label: '未满足', tone: 'quiet' },
  unknown: { label: '数据不足', tone: 'warn' },
  error: { label: '计算失败', tone: 'bad' },
};
const DIRECTIONS = { bullish: '看多', bearish: '看空', neutral: '中性' };
const versionLabel = (version) => (version?.version ? `第 ${version.version} 版` : '版本待核对');

const referenceLabels = (strategy, workspace) => {
  const versions = [workspace?.currentVersion, workspace?.currentRunVersion].filter(Boolean);
  const rules = versions.flatMap((version) => [
    ...version.definition.selection.rules,
    ...Object.values(version.definition.signals).flat(),
  ]);
  return [
    { id: strategy.id, label: strategyText(strategy.name) || '此策略' },
    ...versions.map((version) => ({ id: version.id, label: versionLabel(version) })),
    ...[workspace?.currentRun, workspace?.latestAttempt, workspace?.previousRun]
      .filter(Boolean)
      .map((run) => ({ id: run.id, label: `事实时间 ${when(run.dataAsOf)} 的运行` })),
    ...rules.map((rule, index) => ({
      id: rule.id,
      label: rule.name === rule.id ? `条件 ${index + 1}` : strategyText(rule.name),
    })),
  ];
};

const StrategyCatalog = ({ rows, state, selectedId, onSelect }) =>
  h(
    'nav',
    { className: 'luo-strategy-nav', 'aria-label': '策略列表' },
    h(
      'div',
      { className: 'luo-strategy-nav-title' },
      '我的策略',
      h('span', null, `${rows.length} 个`),
    ),
    rows.map((strategy) => {
      const workspace = workspaceDataOf(state, strategy.id);
      const status = STRATEGY_STATUS[strategy.status] ?? { label: '状态待核对', tone: 'quiet' };
      const text = (value) => strategyText(value, referenceLabels(strategy, workspace));
      return h(
        'button',
        {
          key: strategy.id,
          type: 'button',
          className: `luo-strategy-choice${selectedId === strategy.id ? ' is-selected' : ''}`,
          'aria-pressed': selectedId === strategy.id,
          'data-strategy-choice': strategy.id,
          onClick: () => onSelect(strategy.id),
        },
        h(
          'div',
          { className: 'luo-strategy-choice-head' },
          h('strong', null, text(strategy.name)),
          h(Pill, { tone: status.tone }, status.label),
        ),
        h('p', null, text(strategy.description)),
        h(
          'div',
          { className: 'luo-strategy-choice-meta' },
          h(
            'span',
            null,
            workspace?.overview.selectedCount === undefined
              ? workspace
                ? '尚无匹配结果'
                : '详情待读取'
              : `${int(workspace.overview.selectedCount)} 只匹配`,
          ),
          h(
            'span',
            null,
            workspace?.currentVersion ? versionLabel(workspace.currentVersion) : '未发布',
          ),
        ),
      );
    }),
  );

const RuleList = ({ rules, text, scoring }) =>
  h(
    'ol',
    { className: 'luo-strategy-rules' },
    rules.map((rule, index) =>
      h(
        'li',
        { key: rule.id },
        h(
          'span',
          { className: 'luo-rule-number', 'aria-hidden': true },
          String(index + 1).padStart(2, '0'),
        ),
        h(
          'div',
          null,
          h(
            'div',
            { className: 'luo-rule-heading' },
            h('strong', null, text(rule.name)),
            rule.direction ? h(Pill, null, DIRECTIONS[rule.direction]) : null,
          ),
          h('p', { className: 'luo-rule-expression' }, text(strategyExpression(rule.when))),
          rule.emission
            ? h(
                'p',
                { className: 'luo-fine' },
                `${rule.emission.mode === 'edge' ? '条件首次满足时产生信号' : '条件持续满足时产生信号'} · 冷却 ${int(rule.emission.cooldownTradingDays)} 个交易日`,
              )
            : null,
          scoring
            ? h('p', { className: 'luo-fine' }, `信号评分：${text(strategyExpression(rule.score))}`)
            : null,
        ),
      ),
    ),
  );

const DefinitionCard = ({ version, title = '策略要求', text }) => {
  const definition = version?.definition;
  if (!definition)
    return h(
      Card,
      { title },
      h(Empty, { title: '尚无已发布的策略定义', hint: '可在对话中完善条件，校验后再确认发布。' }),
    );
  const universe = definition.universe;
  return h(
    Card,
    { title, meta: versionLabel(version), className: 'luo-strategy-definition' },
    h(
      'dl',
      { className: 'luo-strategy-facts' },
      h('div', null, h('dt', null, '覆盖范围'), h('dd', null, '沪深 A 股')),
      h(
        'div',
        null,
        h('dt', null, '研究周期'),
        h('dd', null, HORIZON[definition.metadata.horizon] ?? '未限定'),
      ),
      h(
        'div',
        null,
        h('dt', null, '筛选方式'),
        h('dd', null, definition.selection.logic === 'all' ? '全部条件满足' : '任一条件满足'),
      ),
      h(
        'div',
        null,
        h('dt', null, '排序规则'),
        h(
          'dd',
          null,
          definition.scoring
            ? `加权评分${definition.scoring.top ? ` · 取前 ${int(definition.scoring.top)} 名` : ''}`
            : '未设置评分排序',
        ),
      ),
    ),
    universe.includeStockIds
      ? h(
          'p',
          { className: 'luo-fine' },
          `指定范围：${universe.includeStockIds.length ? universe.includeStockIds.join('、') : '空股票池'}`,
        )
      : null,
    universe.excludeStockIds.length
      ? h('p', { className: 'luo-fine' }, `排除：${universe.excludeStockIds.join('、')}`)
      : null,
    h('h4', { className: 'luo-strategy-subtitle' }, '筛选条件'),
    definition.selection.rules.length
      ? h(RuleList, { rules: definition.selection.rules, text })
      : h('p', { className: 'luo-fine' }, '未配置筛选条件。'),
    definition.scoring
      ? h(
          'details',
          { className: 'luo-strategy-detail' },
          h('summary', null, '评分方式'),
          h(
            'ul',
            { className: 'luo-strategy-score' },
            definition.scoring.components.map((component) => {
              const rule = definition.selection.rules.find((item) => item.id === component.ruleId);
              return h(
                'li',
                { key: component.ruleId },
                h('strong', null, rule ? text(rule.name) : '评分项'),
                h('span', null, `权重 ${points(component.weight * 100, 0, false)}`),
                h(
                  'p',
                  { className: 'luo-rule-expression' },
                  text(strategyExpression(component.score)),
                ),
              );
            }),
          ),
        )
      : null,
    h(
      'div',
      { className: 'luo-strategy-signal-groups' },
      [
        ['entry', '入场信号'],
        ['exit', '退出条件'],
        ['risk', '风险条件'],
      ].map(([kind, label]) =>
        h(
          'details',
          { key: kind, className: 'luo-strategy-detail', open: true },
          h('summary', null, label, h('span', null, `${definition.signals[kind].length} 条`)),
          definition.signals[kind].length
            ? h(RuleList, { rules: definition.signals[kind], text, scoring: true })
            : h('p', { className: 'luo-fine' }, '未配置。'),
        ),
      ),
    ),
  );
};

const factValue = (value) => {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  return typeof value === 'string' ? value : '—';
};

const MatchEvidence = ({ result, version, text, expanded }) => {
  const rules = [
    ...(version?.definition.selection.rules ?? []),
    ...Object.values(version?.definition.signals ?? {}).flat(),
  ];
  return h(
    'details',
    { className: 'luo-match-evidence', open: expanded },
    h('summary', null, '查看匹配依据'),
    result.ruleEvaluations.length
      ? h(
          'ul',
          null,
          result.ruleEvaluations.map((evaluation, index) => {
            const rule = rules.find((item) => item.id === evaluation.ruleId);
            const status = RULE_STATUS[evaluation.status];
            return h(
              'li',
              { key: `${evaluation.ruleId}-${index}` },
              h(
                'div',
                { className: 'luo-rule-heading' },
                h('strong', null, rule ? text(rule.name) : '历史条件'),
                h(Pill, { tone: status.tone }, status.label),
              ),
              evaluation.expression
                ? h(
                    'p',
                    { className: 'luo-rule-expression' },
                    text(strategyExpression(evaluation.expression)),
                  )
                : null,
              evaluation.inputs?.length
                ? h(
                    'p',
                    { className: 'luo-fine' },
                    evaluation.inputs
                      .map(
                        (input) =>
                          `${strategyExpression(input.path)}：${input.status === 'missing' ? '数据缺失' : text(factValue(input.value))}`,
                      )
                      .join('；'),
                  )
                : null,
              evaluation.explanation?.message
                ? h('p', { className: 'luo-fine' }, text(evaluation.explanation.message))
                : null,
              evaluation.evidence.map((evidence, i) =>
                h('p', { key: i, className: 'luo-fine' }, text(evidence)),
              ),
            );
          }),
        )
      : h('p', { className: 'luo-fine' }, '这次历史运行未保存逐条条件解释。'),
    result.evidence.length
      ? h('p', { className: 'luo-fine' }, result.evidence.map(text).join('；'))
      : null,
  );
};

const MatchesCard = ({ workspace, text, onSelectStock }) => {
  const matches = workspace?.matches;
  const run = workspace?.currentRun;
  return h(
    Card,
    {
      title: '匹配标的',
      className: 'luo-strategy-matches',
      meta: matches ? `${int(matches.total)} 只` : null,
    },
    run
      ? h(
          'div',
          { className: 'luo-match-asof' },
          h(Pill, { tone: 'ok', dot: true }, '已发布结果'),
          h(
            'span',
            null,
            `${versionLabel(workspace.currentRunVersion)} · 事实时间 ${when(run.dataAsOf)}`,
          ),
        )
      : null,
    !matches
      ? h(Empty, {
          title: '尚无已发布的匹配结果',
          hint: '策略运行并通过发布检查后，会在这里显示匹配标的。',
        })
      : matches.total === 0
        ? h(Empty, { title: '这次运行没有匹配标的', hint: '当前策略条件下没有股票入选。' })
        : h(
            'div',
            { className: 'luo-table-wrap' },
            h(
              'table',
              { className: 'luo-table luo-matches-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  ['标的', '排名', '规则评分', '匹配依据'].map((label) =>
                    h('th', { key: label, scope: 'col' }, label),
                  ),
                ),
              ),
              h(
                'tbody',
                null,
                matches.rows.map(({ stock, result }) =>
                  h(
                    'tr',
                    { key: result.stockId },
                    h(
                      'td',
                      null,
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'luo-stock-link',
                          'data-stock-id': stock.stockId,
                          'aria-label': `查看${stock.stockName}个股详情`,
                          onClick: () =>
                            onSelectStock({
                              stock,
                              result,
                              version: workspace.currentRunVersion,
                              run: workspace.currentRun,
                            }),
                        },
                        h('strong', { className: 'luo-stock-name' }, stock.stockName),
                        h('span', { className: 'luo-stock-code' }, stock.stockId),
                      ),
                    ),
                    h('td', { 'data-label': '排名' }, int(result.rank)),
                    h(
                      'td',
                      { 'data-label': '规则评分' },
                      result.score === undefined ? '—' : money(result.score),
                    ),
                    h(
                      'td',
                      null,
                      h(MatchEvidence, { result, version: workspace.currentRunVersion, text }),
                    ),
                  ),
                ),
              ),
            ),
          ),
    matches && matches.total > matches.rows.length
      ? h(
          'p',
          { className: 'luo-fine' },
          `展示前 ${int(matches.rows.length)} 只，共 ${int(matches.total)} 只；其余标的可在对话中查询。`,
        )
      : null,
    h(
      'p',
      { className: 'luo-strategy-note' },
      '评分来自策略规则，不代表成功概率。匹配标的仅供研究。',
    ),
  );
};

const StrategyRunCard = ({ strategy, state, workspace, onManage }) => {
  const schedule = strategyPartDataOf(state, strategy.id, 'schedule')?.schedule ?? null;
  const scheduleError = strategyPartErrorOf(state, strategy.id, 'schedule');
  const subscriptions =
    strategyPartDataOf(state, strategy.id, 'subscriptions')?.subscriptions ?? [];
  const subscriptionsError = strategyPartErrorOf(state, strategy.id, 'subscriptions');
  const activeSubscriptions = subscriptions.filter((item) => item.status === 'active');
  const run = workspace?.currentRun;
  return h(
    Card,
    { title: '持续运行', className: 'luo-strategy-runtime' },
    scheduleError
      ? h(ErrorNote, { label: '运行配置', error: safeError(scheduleError) })
      : h(
          'div',
          null,
          h(
            'div',
            { className: 'luo-strategy-tags' },
            h(
              Pill,
              { tone: schedule?.enabled ? 'accent' : 'quiet', dot: true },
              schedule?.enabled ? '策略日程已开启 · 执行待核对' : '策略日程未开启',
            ),
            run ? h(Pill, null, `最近结果 ${when(run.dataAsOf)}`) : null,
          ),
          schedule
            ? h(
                'dl',
                { className: 'luo-strategy-facts' },
                h('div', null, h('dt', null, '运行规则'), h('dd', null, schedule.cron)),
                h('div', null, h('dt', null, '时区'), h('dd', null, schedule.timezone)),
                h(
                  'div',
                  null,
                  h('dt', null, '下次到期'),
                  h('dd', null, schedule.nextRunAt ? when(schedule.nextRunAt) : '未安排'),
                ),
              )
            : h(
                'p',
                { className: 'luo-fine' },
                workspace?.currentVersion
                  ? '已发布，尚未启用持续运行。'
                  : '尚未配置持续运行；发布有效版本后可启用。',
              ),
        ),
    subscriptionsError
      ? h(ErrorNote, { label: 'Watchlist 订阅', error: safeError(subscriptionsError) })
      : h(
          'p',
          { className: 'luo-fine' },
          activeSubscriptions.length
            ? `已订阅 ${activeSubscriptions.length} 个 Watchlist；只有已发布正式运行才同步。`
            : '未配置 Watchlist 订阅，匹配结果不会自动加入关注。',
        ),
    h(
      'button',
      {
        type: 'button',
        className: 'luo-btn',
        'data-strategy-operation': strategy.id,
        onClick: () => onManage?.(strategy.id, { strategyName: strategy.name }),
      },
      '在对话中管理运行',
    ),
  );
};

const StrategyDetails = ({ strategy, state, onResearch, onManage, onAnalyzeStock }) => {
  const [selectedStock, setSelectedStock] = useState(null);
  const workspace = workspaceDataOf(state, strategy.id);
  const error = workspaceErrorOf(state, strategy.id);
  const references = referenceLabels(strategy, workspace);
  const text = (value) => strategyText(value, references);
  const status = STRATEGY_STATUS[strategy.status] ?? { label: '状态待核对', tone: 'quiet' };
  const health = STRATEGY_HEALTH[workspace?.overview.health];
  const version = workspace?.currentVersion;
  const run = workspace?.currentRun;
  const runVersion = workspace?.currentRunVersion;
  const drift = run && version && run.strategyVersionId !== version.id;
  const stockText = (value) =>
    strategyText(
      value,
      selectedStock
        ? referenceLabels(selectedStock.strategy, {
            currentVersion: selectedStock.version,
            currentRunVersion: selectedStock.version,
            currentRun: selectedStock.run,
          })
        : [],
    );
  return h(
    'article',
    { className: 'luo-strategy-content', 'aria-label': text(strategy.name) },
    h(
      'div',
      { className: 'luo-strategy-hero' },
      h(
        'div',
        { className: 'luo-strategy-tags' },
        h(Pill, { tone: status.tone, dot: true }, status.label),
        h(Pill, null, OWNER[strategy.owner]),
        health ? h(Pill, { tone: health.tone }, health.label) : null,
      ),
      h('h2', null, text(strategy.name)),
      h('p', { className: 'luo-strategy-intro' }, text(strategy.description)),
      h(
        'div',
        { className: 'luo-strategy-hero-bottom' },
        h(
          'div',
          { className: 'luo-fine' },
          `${version ? `当前版本 ${versionLabel(version)}` : '尚未发布'} · 更新于 ${when(strategy.updatedAt)}`,
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'luo-btn',
            'data-strategy-id': strategy.id,
            'data-run-id': run?.id,
            onClick: () =>
              onResearch?.(strategy.id, run?.id ?? null, {
                strategyName: strategy.name,
                version: (runVersion ?? version)?.version,
                dataAsOf: run?.dataAsOf,
              }),
          },
          '在对话中研究此策略',
        ),
      ),
      workspace
        ? h(
            'div',
            { className: 'luo-strategy-summary luo-stats' },
            h(Stat, { k: '匹配标的', v: int(workspace.overview.selectedCount) }),
            h(Stat, { k: '较上次新入选', v: int(workspace.overview.enteredCount) }),
            h(Stat, { k: '较上次退出', v: int(workspace.overview.exitedCount) }),
            h(Stat, { k: '数据不完整', v: int(workspace.overview.incompleteCount) }),
          )
        : null,
      error ? h(ErrorNote, { label: '策略详情', error: safeError(error) }) : null,
      !workspace && !error
        ? h('p', { className: 'luo-fine' }, '本次未加载此策略详情，请在对话中查询。')
        : null,
      workspace?.warnings.length
        ? h('p', { className: 'luo-err' }, workspace.warnings.map(text).join('；'))
        : null,
      drift
        ? h(
            'p',
            { className: 'luo-err' },
            `当前已发布${versionLabel(version)}，下方匹配结果仍使用${versionLabel(runVersion)}；新版本尚无已发布结果。`,
          )
        : null,
    ),
    h(ResearchWorkbench, { strategy, workspace, onResearch, onManage, onAnalyzeStock }),
    h(StrategyRunCard, { strategy, state, workspace, onManage }),
    workspace ? h(DefinitionCard, { version, text }) : null,
    workspace
      ? h(MatchesCard, {
          workspace,
          text,
          onSelectStock: (match) => setSelectedStock({ ...match, strategy }),
        })
      : null,
    drift
      ? h(
          'details',
          { className: 'luo-strategy-detail' },
          h('summary', null, '查看匹配结果使用的历史条件'),
          h(DefinitionCard, { version: runVersion, text, title: '结果对应的策略要求' }),
        )
      : null,
    selectedStock
      ? h(StockDetail, {
          key: `${selectedStock.run.id}:${selectedStock.stock.stockId}`,
          stock: selectedStock.stock,
          result: selectedStock.result,
          version: selectedStock.version,
          strategyName: stockText(selectedStock.strategy.name),
          evidence: h(MatchEvidence, {
            result: selectedStock.result,
            version: selectedStock.version,
            text: stockText,
            expanded: true,
          }),
          onClose: () => setSelectedStock(null),
          onAnalyze: () =>
            onAnalyzeStock({
              stockId: selectedStock.stock.stockId,
              stockName: selectedStock.stock.stockName,
              strategyId: selectedStock.strategy.id,
              strategyName: selectedStock.strategy.name,
              runId: selectedStock.run.id,
              version: selectedStock.version.version,
              dataAsOf: selectedStock.run.dataAsOf,
            }),
        })
      : null,
  );
};

const DailyCycleCard = ({ refresh }) => {
  const [profile, setProfile] = useState(null);
  const [profileError, setProfileError] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('api/luoome/profile', {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (!controller.signal.aborted) setProfile(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setProfileError(String(error));
      });
    return () => controller.abort();
  }, []);
  const accountId = profile?.accountId;
  const available = dailyCycleAvailable(profile);
  const control = useResearchOperation({
    accountId,
    strategyId: 'daily-cycle',
    onCompleted: refresh,
  });
  const result = dailyCycleResult(control.operation);
  return h(
    Card,
    { title: '策略日循环', meta: '全市场 · 手动执行' },
    h(
      'p',
      { className: 'luo-fine' },
      '按当前已发布策略执行完整日循环。不使用 force；未满足交易日等门槛时会明确跳过。',
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'luo-btn is-primary',
        disabled: !available || control.locked,
        onClick: () => control.prepare('run_strategy_daily_cycle', {}),
      },
      control.operation?.state === 'executing' ? '正在执行日循环' : '立即执行日循环',
    ),
    !available && profile !== null
      ? h('p', { className: 'luo-fine' }, '批处理入口未启用，当前只能查看既有结果。')
      : null,
    profileError
      ? h('p', { className: 'luo-fine' }, '批处理配置读取失败，请刷新页面后重试。')
      : null,
    result
      ? h('p', { className: `luo-fine is-${result.tone}`, 'aria-live': 'polite' }, result.text)
      : null,
    h(OperationReceipt, { control }),
  );
};

export function StrategiesPanel({ onResearch, onManage, onAnalyzeStock }) {
  const state = usePanelState('strategies');
  const { results, loading, refresh } = state;
  const listed = dataOf(results, 'list_strategies');
  const rows = listed?.strategies ?? [];
  const [selected, setSelected] = useState(() => {
    try {
      return globalThis.localStorage?.getItem('luoome:research-strategy') ?? null;
    } catch {
      return null;
    }
  });
  const strategy = rows.find((row) => row.id === selected) ?? rows[0];
  return h(
    Panel,
    null,
    h(Head, {
      eyebrow: 'Personal strategy research',
      title: '策略',
      subtitle: '提出问题，验证规则，保存每一次研究的发现',
      side: h(Refresh, { loading, onClick: refresh }),
    }),
    state.panelError ? h(ErrorNote, { label: '策略页', error: safeError(state.panelError) }) : null,
    errorOf(results, 'list_strategies')
      ? h(ErrorNote, { label: '策略列表', error: safeError(errorOf(results, 'list_strategies')) })
      : null,
    loading && !listed ? h(Section, null, h(SkeletonLines, { lines: 6 })) : null,
    listed && !rows.length ? h(Section, null, h(ResearchOnboarding, { onResearch })) : null,
    strategy
      ? h(
          'div',
          { className: 'luo-strategy-layout' },
          h(StrategyCatalog, {
            rows,
            state,
            selectedId: strategy.id,
            onSelect: (id) => {
              setSelected(id);
              try {
                globalThis.localStorage?.setItem('luoome:research-strategy', id);
              } catch {
                /* 页面仍可继续研究。 */
              }
            },
          }),
          h(StrategyDetails, {
            key: strategy.id,
            strategy,
            state,
            onResearch,
            onManage,
            onAnalyzeStock,
          }),
        )
      : null,
    listed?.total > rows.length
      ? h(
          'p',
          { className: 'luo-fine' },
          `当前显示 ${int(rows.length)} / ${int(listed.total)} 个策略，其余可在对话中查询。`,
        )
      : null,
    h(
      'details',
      { className: 'luo-strategy-operations' },
      h('summary', null, '运行与观察', h('span', null, '查看整体运行状态与待补观察')),
      h(
        Section,
        null,
        h(DailyCycleCard, { refresh }),
        h(
          'div',
          { className: 'luo-grid is-two' },
          h(WatchHealthCard, {
            watch: dataOf(results, 'get_watch_status'),
            loading,
            error: safeError(errorOf(results, 'get_watch_status')),
          }),
          h(ReliabilityCard, {
            summary: dataOf(results, 'get_strategy_reliability_summary'),
            loading,
            error: safeError(errorOf(results, 'get_strategy_reliability_summary')),
          }),
        ),
      ),
      h(ObservationsTable, {
        pending: dataOf(results, 'list_pending_strategy_observations'),
        loading,
        error: safeError(errorOf(results, 'list_pending_strategy_observations')),
      }),
    ),
    h(Footer, {
      left: h(Stamp, { label: '读取于', value: clock(state.asOf) }),
      right: '条件与结果来自已保存的策略事实；刷新仅更新展示。',
    }),
  );
}
