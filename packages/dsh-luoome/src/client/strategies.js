import { createElement as h, useCallback, useEffect, useRef, useState } from 'react';
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
  tradeDate,
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
  Pill,
  Refresh,
  Section,
  SkeletonLines,
  Stamp,
  Stat,
} from './primitives.js';
import { ResearchDiagnosis, ResearchOnboarding, ResearchWorkbench } from './research.js';
import { useResearchOperation, useResearchRead } from './research-data.js';
import { OperationReceipt, RunComparison } from './research-results.js';
import { researchUrl } from './research-transport.js';
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
      .map((run) => ({ id: run.id, label: `事实时间 ${tradeDate(run.dataAsOf)} 的运行` })),
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
  if (!definition) return h(Card, { title }, h(Empty, { title: '尚无已发布的策略定义' }));
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
            `${versionLabel(workspace.currentRunVersion)} · 事实时间 ${tradeDate(run.dataAsOf)}`,
          ),
        )
      : null,
    !matches
      ? h(Empty, { title: '尚无已发布的匹配结果' })
      : matches.total === 0
        ? h(Empty, { title: '本次没有匹配标的' })
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
          `前 ${int(matches.rows.length)} / ${int(matches.total)} 只 · 更多见选股诊断`,
        )
      : null,
    h('p', { className: 'luo-strategy-note' }, '规则评分≠成功概率，仅供研究。'),
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
            run ? h(Pill, null, `最近结果 ${tradeDate(run.dataAsOf)}`) : null,
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
            ? `已订阅 ${activeSubscriptions.length} 个关注列表。`
            : '未订阅关注列表。',
        ),
    h(
      'button',
      {
        type: 'button',
        className: 'luo-btn',
        'data-strategy-operation': strategy.id,
        onClick: () => onManage?.(strategy.id, { strategyName: strategy.name }),
      },
      '管理运行',
    ),
  );
};

const StrategyChanges = ({ strategy }) => {
  const read = useResearchRead(researchUrl('updates', strategy.id));
  const comparison = read.data?.comparison;
  if (read.loading && !read.data) return h(SkeletonLines, { lines: 3 });
  if (read.error) return h(ErrorNote, { error: read.error });
  if (comparison?.ok !== true) return h(Empty, { title: '无可比基准' });
  const data = comparison.data;
  return h(RunComparison, {
    title: '较上次变化',
    diff: data.diff,
    from: data.fromRun.dataAsOf,
    to: data.toRun.dataAsOf,
  });
};

const StrategyDetails = ({
  strategy,
  state,
  onResearch,
  onManage,
  onAnalyzeStock,
  onGuardChange,
  guardSummary,
}) => {
  const [selectedStock, setSelectedStock] = useState(null);
  const [chosenMode, setChosenMode] = useState(null);
  const [researchOpened, setResearchOpened] = useState(false);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const [changesOpened, setChangesOpened] = useState(false);
  const workspace = workspaceDataOf(state, strategy.id);
  const error = workspaceErrorOf(state, strategy.id);
  const references = referenceLabels(strategy, workspace);
  const text = (value) => strategyText(value, references);
  const status = STRATEGY_STATUS[strategy.status] ?? { label: '状态待核对', tone: 'quiet' };
  const version = workspace?.currentVersion;
  const run = workspace?.currentRun;
  const latest = workspace?.latestAttempt;
  const runVersion = workspace?.currentRunVersion;
  const previous = workspace?.previousRun;
  const drift = run && version && run.strategyVersionId !== version.id;
  const mode =
    chosenMode ?? (workspace && strategy.status === 'draft' && !run ? 'research' : 'overview');
  const continuity = state.strategies.find((entry) => entry.strategyId === strategy.id)?.continuity;
  const health = STRATEGY_HEALTH[workspace?.overview.health];
  const showResearch = researchOpened || mode === 'research';
  useEffect(() => {
    if (mode === 'research') setResearchOpened(true);
  }, [mode]);
  const setMode = (next) => {
    if (next === 'research') setResearchOpened(true);
    setChosenMode(next);
  };
  const continuityLabel = {
    disabled: '持续观察未启用',
    paused: '策略已暂停',
    'not-configured': '尚未配置',
    blocked: '任务待补齐',
    waiting: '等待业务回执',
    running: '正在执行',
    healthy: '运行已核对',
    partial: '数据部分可用',
    stale: '事实待更新',
    unknown: '状态待核对',
  }[continuity?.status];
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
        { className: 'luo-strategy-heading' },
        h(
          'div',
          null,
          h(
            'div',
            { className: 'luo-strategy-tags' },
            h(Pill, { tone: status.tone, dot: true }, status.label),
            h(Pill, null, OWNER[strategy.owner]),
          ),
          h('h2', null, text(strategy.name)),
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
          'AI 研究',
        ),
      ),
      h('p', { className: 'luo-strategy-intro' }, text(strategy.description)),
      h(
        'nav',
        { className: 'luo-strategy-modes', 'aria-label': '策略视图', role: 'tablist' },
        [
          ['overview', '结果总览'],
          ['research', '研究工作台'],
        ].map(([id, label]) =>
          h(
            'button',
            {
              key: id,
              type: 'button',
              role: 'tab',
              id: `strategy-tab-${id}`,
              'aria-selected': mode === id,
              'aria-controls': `strategy-view-${id}`,
              'data-strategy-mode': id,
              tabIndex: mode === id ? 0 : -1,
              onKeyDown: (event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 'overview'
                    : event.key === 'End'
                      ? 'research'
                      : id === 'overview'
                        ? 'research'
                        : 'overview';
                setMode(next);
                event.currentTarget.parentElement
                  .querySelector(`[data-strategy-mode="${next}"]`)
                  .focus();
              },
              onClick: () => setMode(id),
            },
            label,
            id === 'research' && guardSummary.dirty ? h(Pill, { tone: 'warn' }, '未保存') : null,
            id === 'research' && guardSummary.busy ? h(Pill, { tone: 'accent' }, '执行中') : null,
          ),
        ),
      ),
    ),
    h(
      'section',
      {
        id: 'strategy-view-overview',
        role: 'tabpanel',
        'aria-labelledby': 'strategy-tab-overview',
        hidden: mode !== 'overview',
        className: 'luo-strategy-view',
      },
      error ? h(ErrorNote, { label: '策略详情', error: safeError(error) }) : null,
      !workspace && !error ? h(Empty, { title: '详情待读取' }) : null,
      workspace
        ? h(
            'div',
            { className: 'luo-strategy-identity' },
            h(
              'div',
              null,
              h('span', null, '当前定义'),
              h('strong', null, version ? versionLabel(version) : '未发布'),
              version
                ? h('small', null, `发布于 ${when(version.publishedAt ?? version.createdAt)}`)
                : null,
            ),
            h(
              'div',
              null,
              h('span', null, '结果版本'),
              h('strong', null, run ? versionLabel(runVersion) : '尚无正式结果'),
              run ? h('small', null, '已发布 · 正式运行') : null,
            ),
            h(
              'div',
              null,
              h('span', null, '事实日期'),
              h('strong', null, run ? tradeDate(run.dataAsOf) : '—'),
              run
                ? h(
                    'small',
                    null,
                    { complete: '数据完整', partial: '数据部分可用', unavailable: '数据不可用' }[
                      run.summary?.dataHealth
                    ] ?? '数据未标注',
                  )
                : null,
            ),
            h(
              'div',
              null,
              h('span', null, '最近尝试'),
              h('strong', null, health ? health.label : '尚未运行'),
              latest ? h('small', null, when(latest.finishedAt ?? latest.startedAt)) : null,
            ),
          )
        : null,
      drift
        ? h(
            'p',
            { className: 'luo-strategy-alert', role: 'status' },
            `定义已更新为${versionLabel(version)}，当前结果仍来自${versionLabel(runVersion)}。`,
          )
        : null,
      run && latest && latest.id !== run.id
        ? h(
            'p',
            { className: 'luo-strategy-alert', role: 'status' },
            `最近尝试${health?.label ?? '未发布'}；仍显示 ${tradeDate(run.dataAsOf)} 的已发布结果。`,
          )
        : null,
      workspace?.warnings.length
        ? h(
            'details',
            { className: 'luo-strategy-detail' },
            h('summary', null, '数据提示', h('span', null, workspace.warnings.length)),
            h('p', { className: 'luo-err' }, workspace.warnings.map(text).join('；')),
          )
        : null,
      workspace
        ? h(
            'div',
            { className: 'luo-strategy-summary luo-stats' },
            h(Stat, { k: '匹配标的', v: int(workspace.overview.selectedCount) }),
            h(Stat, { k: '新入选', v: previous ? int(workspace.overview.enteredCount) : '—' }),
            h(Stat, { k: '退出', v: previous ? int(workspace.overview.exitedCount) : '—' }),
            h(Stat, { k: '数据不完整', v: int(workspace.overview.incompleteCount) }),
          )
        : null,
      workspace
        ? h(
            'p',
            { className: 'luo-strategy-baseline' },
            previous
              ? `对比 ${tradeDate(previous.dataAsOf)} → ${tradeDate(run.dataAsOf)}${previous.strategyVersionId !== run.strategyVersionId ? ' · 定义也有变化' : ''}`
              : '无可比基准',
          )
        : null,
      workspace
        ? h(MatchesCard, {
            workspace,
            text,
            onSelectStock: (match) => setSelectedStock({ ...match, strategy }),
          })
        : null,
      run
        ? h(
            'details',
            {
              className: 'luo-strategy-detail',
              open: diagnosisOpen,
              onToggle: (event) => setDiagnosisOpen(event.currentTarget.open),
            },
            h('summary', null, '选股诊断'),
            diagnosisOpen
              ? h(ResearchDiagnosis, {
                  key: run.id,
                  strategy,
                  workspace,
                  formalOnly: true,
                  onAnalyzeStock,
                })
              : null,
          )
        : null,
      previous
        ? h(
            'details',
            {
              className: 'luo-strategy-detail',
              onToggle: (event) => {
                if (event.currentTarget.open) setChangesOpened(true);
              },
            },
            h('summary', null, '较上次变化'),
            changesOpened ? h(StrategyChanges, { strategy }) : null,
          )
        : null,
      workspace
        ? h(
            'details',
            { className: 'luo-strategy-detail', 'data-strategy-rules': true },
            h(
              'summary',
              null,
              '策略规则',
              h('span', null, `当前定义 · ${version ? versionLabel(version) : '未发布'}`),
            ),
            h(DefinitionCard, { version, text, title: '当前定义' }),
            drift
              ? h(DefinitionCard, { version: runVersion, text, title: '结果使用的历史规则' })
              : null,
          )
        : null,
      continuity &&
        ['blocked', 'waiting', 'partial', 'stale', 'unknown'].includes(continuity.status)
        ? h(
            'p',
            { className: 'luo-strategy-alert', role: 'status' },
            `当前策略 · ${continuityLabel}`,
          )
        : null,
      h(
        'details',
        { className: 'luo-strategy-detail', 'data-strategy-runtime': true },
        h('summary', null, '持续运行', continuityLabel ? h('span', null, continuityLabel) : null),
        h(StrategyRunCard, { strategy, state, workspace, onManage }),
        continuity
          ? h(
              'div',
              { className: 'luo-strategy-continuity' },
              h(
                'p',
                { className: 'luo-fine' },
                `${continuityLabel} · 事实截止 ${when(continuity.factCutoff)}`,
              ),
              [...continuity.reasons, ...continuity.limitations].length
                ? h(
                    'p',
                    { className: 'luo-fine' },
                    [...continuity.reasons, ...continuity.limitations].map(text).join('；'),
                  )
                : null,
            )
          : null,
      ),
    ),
    h(
      'section',
      {
        id: 'strategy-view-research',
        role: 'tabpanel',
        'aria-labelledby': 'strategy-tab-research',
        hidden: mode !== 'research',
        className: 'luo-strategy-view',
      },
      showResearch
        ? h(ResearchWorkbench, {
            strategy,
            workspace,
            onResearch,
            onManage,
            onAnalyzeStock,
            active: mode === 'research',
            onGuardChange,
          })
        : null,
    ),
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
    { title: '日循环', meta: '全部已发布策略' },
    h('p', { className: 'luo-fine' }, '作用于全部已发布策略。'),
    h(
      'button',
      {
        type: 'button',
        className: 'luo-btn is-primary',
        disabled: !available || control.locked,
        onClick: () => control.prepare('run_strategy_daily_cycle', {}),
      },
      control.operation?.state === 'executing' ? '运行中' : '运行日循环',
    ),
    !available && profile !== null ? h('p', { className: 'luo-fine' }, '日循环未启用。') : null,
    profileError ? h('p', { className: 'luo-fine' }, '配置读取失败。') : null,
    result
      ? h('p', { className: `luo-fine is-${result.tone}`, 'aria-live': 'polite' }, result.text)
      : null,
    h(OperationReceipt, { control }),
  );
};

function UnsavedResearchDialog({ pending, guard, onStay, onDiscard, onSave, saving }) {
  const dialog = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current.showModal();
    dialog.current.querySelector('[data-continue-editing]').focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return h(
    'dialog',
    {
      ref: dialog,
      className: 'luo-strategy-leave',
      'aria-label': '未保存研究',
      onCancel: (event) => {
        event.preventDefault();
        onStay();
      },
    },
    h('h3', null, '研究尚未保存'),
    h('p', null, '离开前如何处理修改？'),
    (saving || pending.saveAttempted) && guard.control
      ? h(OperationReceipt, { control: guard.control })
      : null,
    h(
      'div',
      { className: 'luo-actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'luo-btn is-primary',
          disabled: !guard.canSave || guard.busy || saving,
          onClick: onSave,
        },
        '保存并离开',
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'luo-btn',
          disabled: guard.busy || saving,
          onClick: onDiscard,
        },
        '放弃修改',
      ),
      h(
        'button',
        { type: 'button', className: 'luo-btn', onClick: onStay, 'data-continue-editing': true },
        '继续编辑',
      ),
    ),
    !guard.canSave && !saving
      ? h('p', { className: 'luo-fine' }, '请先保存候选并补齐研究必填项。')
      : null,
    pending.error ? h(ErrorNote, { error: pending.error }) : null,
  );
}

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
  const [guardSummary, setGuardSummary] = useState({
    dirty: false,
    busy: false,
    canSave: false,
    operationState: null,
  });
  const guard = useRef({ dirty: false });
  const bypass = useRef(false);
  const pendingRef = useRef(null);
  const [pending, setPending] = useState(null);
  const [saving, setSaving] = useState(false);
  const saveStart = useRef(null);
  const strategy = rows.find((row) => row.id === selected) ?? rows[0];
  const finishLeave = useCallback(() => {
    const target = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    setSaving(false);
    if (target) {
      guard.current = { dirty: false };
      setGuardSummary({ dirty: false, busy: false, canSave: false, operationState: null });
      bypass.current = true;
      try {
        target.action();
      } finally {
        bypass.current = false;
      }
    }
  }, []);
  const updateGuard = useCallback((next) => {
    guard.current = next ?? { dirty: false };
    const summary = {
      dirty: Boolean(next?.dirty),
      busy: Boolean(next?.busy),
      canSave: Boolean(next?.canSave),
      operationState: next?.operation?.state ?? null,
      operationId: next?.operation?.operationId ?? null,
      operationError: next?.control?.error ?? null,
      operationExpired: next?.control?.expired ?? false,
    };
    setGuardSummary((previous) =>
      Object.keys(summary).every((key) => previous[key] === summary[key]) ? previous : summary,
    );
  }, []);
  useEffect(() => {
    if (saving && !guardSummary.dirty) finishLeave();
    else if (
      saving &&
      guardSummary.operationId !== saveStart.current &&
      ['failed', 'cancelled'].includes(guardSummary.operationState)
    )
      setSaving(false);
  }, [
    saving,
    guardSummary.dirty,
    guardSummary.operationId,
    guardSummary.operationState,
    finishLeave,
  ]);
  const requestLeave = useCallback((action, cancel) => {
    if (!guard.current.dirty || bypass.current) return action();
    const next = { action, cancel };
    pendingRef.current = next;
    setPending(next);
    setSaving(false);
    return undefined;
  }, []);
  useEffect(() => {
    const beforeUnload = (event) => {
      if (!guard.current.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const onClick = (event) => {
      if (
        bypass.current ||
        !guard.current.dirty ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target =
        event.target instanceof Element
          ? event.target.closest('button,a,[role="tab"],[role="treeitem"]')
          : null;
      if (!target || target.closest('.luo-strategies-body')) return;
      const link = target.closest('a[href]');
      if (link?.target === '_blank' || link?.hasAttribute('download')) return;
      const label = target.getAttribute('aria-label') ?? target.textContent.trim();
      const opensPanel = ['新会话', '新建会话', '设置', '投资设置'].includes(label);
      if (
        !link &&
        !opensPanel &&
        !target.closest('nav,[role="navigation"],[role="tree"],[role="treeitem"]') &&
        !target.querySelector('[data-luoome-panel]')
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestLeave(() => {
        if (target.isConnected) target.click();
      });
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [requestLeave]);
  const guardedResearch = (strategyId, runId, context) => {
    const open = () =>
      onResearch?.(strategyId, runId, typeof context === 'function' ? context() : context);
    if (!guard.current.dirty) return open();
    return {
      completion: new Promise((resolve) =>
        requestLeave(
          async () => {
            try {
              const result = open();
              resolve((await result?.completion) ?? { ok: true });
            } catch {
              resolve({ ok: false });
            }
          },
          () => resolve({ ok: false, cancelled: true }),
        ),
      ),
    };
  };
  const selectStrategy = (id) => {
    if (id === strategy?.id) return;
    requestLeave(() => {
      guard.current = { dirty: false };
      setGuardSummary({ dirty: false, busy: false, canSave: false, operationState: null });
      setSelected(id);
      try {
        globalThis.localStorage?.setItem('luoome:research-strategy', id);
      } catch {
        /* 选择仍在当前页面生效。 */
      }
    });
  };
  return h(
    'div',
    { className: 'luo-strategies-body' },
    h(Head, {
      eyebrow: 'Strategy workspace',
      title: '策略',
      subtitle: '结果与研究',
      side: h(Refresh, { loading, onClick: refresh, label: '刷新结果' }),
    }),
    state.panelError ? h(ErrorNote, { label: '策略页', error: safeError(state.panelError) }) : null,
    errorOf(results, 'list_strategies')
      ? h(ErrorNote, { label: '策略列表', error: safeError(errorOf(results, 'list_strategies')) })
      : null,
    loading && !listed ? h(Section, null, h(SkeletonLines, { lines: 6 })) : null,
    listed && !rows.length
      ? h(Section, null, h(ResearchOnboarding, { onResearch: guardedResearch }))
      : null,
    strategy
      ? h(
          'div',
          { className: 'luo-strategy-layout' },
          h(
            'aside',
            { className: 'luo-strategy-directory' },
            h(
              'label',
              { className: 'luo-strategy-switcher' },
              h('span', null, '当前策略'),
              h(
                'select',
                {
                  'data-strategy-switcher': true,
                  value: strategy.id,
                  onChange: (event) => selectStrategy(event.target.value),
                },
                rows.map((row) =>
                  h(
                    'option',
                    { key: row.id, value: row.id },
                    `${strategyText(row.name)} · ${STRATEGY_STATUS[row.status]?.label ?? row.status}${workspaceDataOf(state, row.id)?.overview.selectedCount === undefined ? '' : ` · ${int(workspaceDataOf(state, row.id).overview.selectedCount)} 只`}`,
                  ),
                ),
              ),
            ),
            h(StrategyCatalog, { rows, state, selectedId: strategy.id, onSelect: selectStrategy }),
          ),
          h(StrategyDetails, {
            key: strategy.id,
            strategy,
            state,
            onResearch: guardedResearch,
            onManage: (...args) => requestLeave(() => onManage?.(...args)),
            onAnalyzeStock: (...args) => requestLeave(() => onAnalyzeStock?.(...args)),
            onGuardChange: updateGuard,
            guardSummary,
          }),
        )
      : null,
    listed?.total > rows.length
      ? h('p', { className: 'luo-fine' }, `${int(rows.length)} / ${int(listed.total)} 个策略`)
      : null,
    h(
      'details',
      { className: 'luo-strategy-operations' },
      h('summary', null, '整体运行与观察'),
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
    h(Footer, { left: h(Stamp, { label: '读取于', value: clock(state.asOf) }), right: null }),
    pending
      ? h(UnsavedResearchDialog, {
          pending,
          guard: guard.current,
          saving,
          onStay: () => {
            pendingRef.current?.cancel?.();
            pendingRef.current = null;
            setPending(null);
            setSaving(false);
          },
          onDiscard: () => {
            saveStart.current = guard.current.operation?.operationId ?? null;
            guard.current.discard?.();
            setSaving(true);
          },
          onSave: async () => {
            saveStart.current = guard.current.operation?.operationId ?? null;
            setPending((previous) => ({ ...previous, saveAttempted: true }));
            setSaving(true);
            try {
              await guard.current.save?.();
            } catch (error) {
              setSaving(false);
              setPending((previous) =>
                previous ? { ...previous, error: { message: error.message } } : null,
              );
            }
          },
        })
      : null,
  );
}
