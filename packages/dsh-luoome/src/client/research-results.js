import { createElement as h } from 'react';
import { int, money, ratio, when } from './format.js';
import { Card, Empty, ErrorNote, Pill, Stat } from './primitives.js';
import { strategyExpression, strategyText } from './projection.js';
import { DIAGNOSIS_KIND, evidenceValue, RESEARCH_STATUS } from './research-model.js';
import { operationIsUnsettled, researchErrorText } from './research-transport.js';

export const ResearchStatus = ({ status }) => {
  const [label, tone] = RESEARCH_STATUS[status] ?? ['待核对', 'quiet'];
  return h(Pill, { tone }, label);
};

export const ResearchLimitations = ({ items = [], title = '数据与研究限制' }) =>
  items.length
    ? h(
        'div',
        { className: 'luo-research-limitations' },
        h('strong', null, title),
        h(
          'ul',
          null,
          items.map((item, index) => h('li', { key: index }, strategyText(item))),
        ),
      )
    : null;

export const PreflightFacts = ({ preflight }) =>
  h(
    'div',
    { className: 'luo-research-snapshot' },
    h(
      'p',
      { className: 'luo-fine' },
      `检查区间 ${when(preflight.from)} → ${when(preflight.to)} · 修订截止 ${when(preflight.revisionCutoff)} · ${int(preflight.stockIds.length)} 只样本 · 规则需回看 ${int(preflight.requiredLookback)} 日`,
    ),
    h(
      'div',
      { className: 'luo-preflight-grid' },
      [
        ['trial', '即时试跑'],
        ['historicalEvaluation', '历史选股评估'],
        ['strictBacktest', '严格组合回测'],
      ].map(([key, label]) =>
        h(
          'div',
          { key },
          h('strong', null, label),
          h(ResearchStatus, { status: preflight.layers[key].status }),
        ),
      ),
    ),
    Object.entries(preflight.layers).map(([key, layer]) =>
      h(ResearchLimitations, {
        key,
        title: {
          trial: '即时试跑资格',
          historicalEvaluation: '历史评估资格',
          strictBacktest: '严格回测资格',
        }[key],
        items: layer.reasons,
      }),
    ),
    h(
      'p',
      { className: 'luo-fine' },
      `基准 ${preflight.benchmark.stockId}：本地 ${int(preflight.benchmark.availableDays)} / ${int(preflight.benchmark.totalDays)} 日；当时已知 ${int(preflight.benchmark.pitAvailableDays)} 日。股票池历史 ${int(preflight.universe.availableDays)} / ${int(preflight.universe.totalDays)} 日。`,
    ),
    h(
      'details',
      { className: 'luo-research-scope', open: true },
      h('summary', null, '按规则字段检查覆盖'),
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
              ['字段', '本地可求值', '当时已知', '首末可用日'].map((label) =>
                h('th', { key: label }, label),
              ),
            ),
          ),
          h(
            'tbody',
            null,
            preflight.fields.map((field) =>
              h(
                'tr',
                { key: field.path },
                h('td', null, strategyExpression(field.path)),
                h('td', null, `${int(field.availableSamples)} / ${int(field.totalSamples)}`),
                h('td', null, ratio(field.pitCoverageRatio, 1, false)),
                h(
                  'td',
                  null,
                  field.firstAvailableAt
                    ? `${when(field.firstAvailableAt)} → ${when(field.lastAvailableAt)}`
                    : '无可用日期',
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        'p',
        { className: 'luo-fine' },
        '首末可用日不表示中间连续；同时查看样本计数。PIT 覆盖表示对应交易日当时已知的事实。',
      ),
    ),
    h(
      'details',
      { className: 'luo-research-scope' },
      h('summary', null, '逐股缺口'),
      h(
        'ul',
        { className: 'luo-comparison-list' },
        preflight.stocks
          .slice(0, 50)
          .map((stock) =>
            h(
              'li',
              { key: stock.stockId },
              h('strong', null, stock.stockId),
              h(
                'span',
                null,
                `${int(stock.availableDays)} / ${int(stock.totalDays)} 日完整 · 当时已知 ${int(stock.pitAvailableDays)} 日${stock.missingFields.length ? ` · 缺 ${stock.missingFields.map(strategyExpression).join('、')}` : ''}`,
              ),
            ),
          ),
      ),
      preflight.stocks.length > 50
        ? h(
            'p',
            { className: 'luo-fine' },
            `当前显示前 50 / ${int(preflight.stocks.length)} 只；可缩小样本再检查。`,
          )
        : null,
    ),
    h(ResearchLimitations, { items: preflight.limitations }),
  );

export const ValidationFacts = ({ data, loading, error, operation, strategyId, sessionId }) => {
  const session = data?.session?.ok ? data.session.data.session : null;
  const progress = data?.progress?.ok ? data.progress.data : null;
  const counts = progress?.progress;
  const days = progress?.days ?? (data?.days?.ok ? data.days.data.days : []);
  const issue =
    error ?? (data?.progress?.ok === false ? researchErrorText(data.progress.error) : null);
  if (!session)
    return issue
      ? h(ErrorNote, { error: issue })
      : h(
          'p',
          { className: 'luo-fine', role: 'status' },
          loading ? '读取验证进度…' : '未读到验证任务。',
        );
  return h(
    'div',
    { className: 'luo-validation-progress' },
    h(
      'div',
      { className: 'luo-rule-heading' },
      h(ResearchStatus, { status: progress?.cancelled ? 'cancelled' : session.status }),
      h(
        Pill,
        { tone: data.worker === 'running' ? 'accent' : 'quiet' },
        data.worker === 'running' ? '后台正在推进' : '当前无执行进程',
      ),
    ),
    h(
      'p',
      { className: 'luo-fine' },
      `${when(session.from)} → ${when(session.to)} · ${session.stockIds ? `${int(session.stockIds.length)} 只固定样本` : '各交易日 PIT 股票集合'}`,
    ),
    counts
      ? h(
          'div',
          null,
          h('progress', {
            value: counts.complete,
            max: counts.total || 1,
            'aria-label': '完成的历史评估交易日',
          }),
          h(
            'div',
            { className: 'luo-stats' },
            [
              ['complete', '已结束日期'],
              ['total', '总交易日'],
              ['failed', '失败日期'],
              ['pending', '未执行'],
              ['vintageAvailable', '当时已知事实完整'],
            ].map(([key, label]) => h(Stat, { key, k: label, v: int(counts[key]) })),
          ),
          h(
            'p',
            { className: 'luo-fine' },
            `逐股求值 ${int(progress.summary.evaluatedCount)} · 入选记录 ${int(progress.summary.selectedCount)} · 信号 ${int(progress.summary.signalCount)}。缺少汇总时显示“—”。`,
          ),
        )
      : null,
    issue ? h(ErrorNote, { error: issue }) : null,
    session.error ? h('p', { className: 'luo-err' }, strategyText(session.error)) : null,
    session.status === 'running' && data.worker === 'idle'
      ? h(
          'p',
          { className: 'luo-err' },
          '保存的任务仍在进行，但当前宿主没有推进进程。续跑后会从已有日期继续。',
        )
      : null,
    h(
      'div',
      { className: 'luo-actions' },
      progress?.resumable && data.worker !== 'running'
        ? h(
            'button',
            {
              type: 'button',
              className: 'luo-btn',
              disabled: operation.locked,
              onClick: () =>
                operation.prepare('resume_strategy_evaluation_session', {
                  accountId: data.accountId,
                  strategyId,
                  versionId: session.strategyVersionId,
                  sessionId,
                }),
            },
            '从断点续跑',
          )
        : null,
      session.status === 'running'
        ? h(
            'button',
            {
              type: 'button',
              className: 'luo-btn',
              disabled: operation.locked,
              onClick: () =>
                operation.prepare('cancel_strategy_evaluation_session', {
                  accountId: data.accountId,
                  strategyId,
                  versionId: session.strategyVersionId,
                  sessionId,
                }),
            },
            '取消评估',
          )
        : null,
    ),
    h(
      'details',
      { className: 'luo-research-scope' },
      h('summary', null, '逐日记录'),
      h(
        'ul',
        { className: 'luo-comparison-list' },
        days
          .slice(0, 50)
          .map((item) =>
            h(
              'li',
              { key: item.dataAsOf },
              h('strong', null, when(item.dataAsOf)),
              h(
                'span',
                null,
                `${{ complete: '执行结束', running: '进行中', failed: '失败' }[item.status]} · 入选 ${int(item.selectedCount)} · ${item.vintageStatus === 'available' ? '当时已知' : '当时事实不完整'}`,
              ),
              item.error ? h('span', null, strategyText(item.error)) : null,
            ),
          ),
      ),
      days.length > 50
        ? h('p', { className: 'luo-fine' }, `当前显示前 50 / ${int(days.length)} 日。`)
        : null,
    ),
    h(ResearchLimitations, { items: progress?.limitations }),
  );
};

export const RobustnessFacts = ({ comparison, versions }) =>
  h(
    'div',
    { className: 'luo-research-snapshot' },
    h(
      'p',
      { className: 'luo-fine' },
      `共享事实时间 ${when(comparison.inputIdentity.dataAsOf)} · ${comparison.candidates.length} 个候选全部保留 · ${comparison.trainingValidation.status === 'isolated' ? '训练/验证已核对隔离，验证未用于选参' : '未配置独立训练/验证，不代表样本外验证'}`,
    ),
    comparison.candidates.map((candidate) =>
      h(
        'details',
        {
          key: candidate.candidateVersionId,
          className: 'luo-research-scope',
          open: candidate.status === 'failed',
        },
        h(
          'summary',
          null,
          `第 ${versions.find((version) => version.id === candidate.candidateVersionId)?.version ?? '?'} 版`,
          h(ResearchStatus, { status: candidate.status }),
        ),
        candidate.error ? h(ErrorNote, { error: researchErrorText(candidate.error) }) : null,
        candidate.comparison?.diff
          ? h(RunComparison, { title: '该候选的规则敏感性', diff: candidate.comparison.diff })
          : null,
        candidate.assessment
          ? h(ResearchLimitations, {
              title: '独立验证门禁',
              items: candidate.assessment.limitations ?? [],
            })
          : null,
      ),
    ),
    h(ResearchLimitations, { items: comparison.limitations }),
  );

export const RuleEvidence = ({ result, version }) => {
  const rules = [
    ...(version?.definition.selection.rules ?? []),
    ...Object.values(version?.definition.signals ?? {}).flat(),
  ];
  const name = (id) => strategyText(rules.find((rule) => rule.id === id)?.name ?? '历史条件');
  const evaluations = result.ruleEvaluations ?? [];
  return h(
    'div',
    { className: 'luo-research-evidence' },
    evaluations.length
      ? h(
          'ul',
          null,
          evaluations.map((evaluation, index) =>
            h(
              'li',
              { key: `${evaluation.ruleId}:${index}` },
              h(
                'div',
                { className: 'luo-rule-heading' },
                h('strong', null, name(evaluation.ruleId)),
                h(
                  Pill,
                  {
                    tone:
                      { matched: 'ok', unknown: 'warn', error: 'bad' }[evaluation.status] ??
                      'quiet',
                  },
                  {
                    matched: '满足',
                    'not-matched': '未满足',
                    unknown: '数据缺失',
                    error: '计算失败',
                  }[evaluation.status],
                ),
              ),
              evaluation.expression
                ? h(
                    'p',
                    { className: 'luo-rule-expression' },
                    strategyExpression(evaluation.expression),
                  )
                : null,
              h(
                'dl',
                { className: 'luo-rule-inputs' },
                (evaluation.inputs ?? []).map((input, i) =>
                  h(
                    'div',
                    { key: i },
                    h('dt', null, strategyExpression(input.path)),
                    h(
                      'dd',
                      null,
                      input.status === 'missing' ? '数据缺失' : evidenceValue(input.value),
                    ),
                  ),
                ),
              ),
              evaluation.explanation
                ? h('p', { className: 'luo-fine' }, strategyText(evaluation.explanation.message))
                : null,
              evaluation.error
                ? h('p', { className: 'luo-fine' }, strategyText(evaluation.error))
                : null,
              (evaluation.evidence ?? []).map((item, i) =>
                h('p', { key: i, className: 'luo-fine' }, strategyText(item)),
              ),
            ),
          ),
        )
      : h('p', { className: 'luo-fine' }, '此运行未保存逐条规则事实。'),
    result.scoringBreakdown?.length
      ? h(
          'div',
          { className: 'luo-score-breakdown' },
          h('h4', null, '评分贡献'),
          result.scoringBreakdown.map((item, i) =>
            h(
              'div',
              { key: i, className: 'luo-score-contribution' },
              h('strong', null, name(item.ruleId)),
              h(
                'span',
                null,
                item.status === 'available'
                  ? `${money(item.rawScore)} × ${evidenceValue(item.weight)} = ${money(item.contribution)}`
                  : item.status === 'missing'
                    ? '评分输入缺失'
                    : '评分计算失败',
              ),
              h('p', { className: 'luo-rule-expression' }, strategyExpression(item.expression)),
            ),
          ),
        )
      : null,
  );
};

export function DiagnosisRows({ rows, version, onSelectStock }) {
  return rows.length
    ? h(
        'ul',
        { className: 'luo-diagnosis-list' },
        rows.map((row) => {
          if (row.missingReason)
            return h(
              'li',
              { key: row.stockId },
              h(
                'div',
                { className: 'luo-diagnosis-head' },
                h('strong', null, strategyText(row.stockName)),
                h('span', { className: 'luo-fine' }, row.stockId),
                h(Pill, { tone: 'warn' }, '数据缺失'),
              ),
              h('p', { className: 'luo-fine' }, row.missingReason),
            );
          const view = row.view ?? row;
          const result = view.result;
          const stock = row.stock ?? {
            stockId: result.stockId,
            stockName: row.stockName ?? result.stockId,
          };
          const [label, tone] = DIAGNOSIS_KIND[view.kind] ?? ['待核对', 'quiet'];
          return h(
            'li',
            { key: result.stockId },
            h(
              'div',
              { className: 'luo-diagnosis-head' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'luo-stock-link',
                  onClick: () => onSelectStock({ stock, result, version }),
                },
                h('strong', null, strategyText(stock.stockName)),
                h('span', null, stock.stockId),
              ),
              h(Pill, { tone }, label),
              h(
                'span',
                { className: 'luo-fine' },
                `评分 ${result.score === undefined ? '未提供' : money(result.score)} · 排名 ${int(result.rank)}`,
              ),
            ),
            view.distance
              ? h(
                  'p',
                  { className: 'luo-fine' },
                  view.distance.kind === 'rank'
                    ? `距前 ${int(view.distance.top)} 名差 ${int(view.distance.positionsAway)} 位`
                    : '仍有一条选股条件未满足；不是价格接近门槛的推断。',
                )
              : null,
            h(
              'details',
              { className: 'luo-research-evidence-detail' },
              h('summary', null, '规则值、门槛与评分贡献'),
              h(RuleEvidence, { result, version }),
            ),
          );
        }),
      )
    : h(Empty, {
        title: '当前条件下没有诊断记录',
        hint: '空分类不代表数据完整，也不表示规则已验证。',
      });
}

export const ResearchPagination = ({ offset, limit, total, onChange, disabled }) =>
  h(
    'nav',
    { className: 'luo-research-pagination', 'aria-label': '选股诊断分页' },
    h(
      'span',
      { className: 'luo-fine' },
      `${total ? int(offset + 1) : 0}–${int(Math.min(offset + limit, total))} / ${int(total)}`,
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'luo-btn',
        disabled: disabled || offset === 0,
        onClick: () => onChange(Math.max(0, offset - limit)),
      },
      '上一页',
    ),
    h(
      'button',
      {
        type: 'button',
        className: 'luo-btn',
        disabled: disabled || offset + limit >= total,
        onClick: () => onChange(offset + limit),
      },
      '下一页',
    ),
  );

const changeLabels = {
  entered: '新入选',
  exited: '退出',
  stayed: '继续入选',
  'candidate-promoted': '临界转入选',
  'selected-demoted': '入选转临界/未入选',
  'rank-changed': '排名变化',
  'score-changed': '评分变化',
  'blocking-rule-changed': '阻断条件变化',
  'data-unavailable': '数据不足以比较',
};

export const RunComparison = ({ diff, title, from, to }) =>
  h(
    Card,
    { title, meta: '规则与选股变化' },
    from && to ? h('p', { className: 'luo-fine' }, `${when(from)} → ${when(to)}`) : null,
    h(
      'div',
      { className: 'luo-stats' },
      [
        ['entered', '新入选'],
        ['exited', '退出'],
        ['stayed', '继续入选'],
        ['dataUnavailable', '不可比较'],
      ].map(([key, label]) => h(Stat, { key, k: label, v: int(diff.summary[key]) })),
    ),
    h(
      'details',
      { className: 'luo-research-scope' },
      h('summary', null, '查看变化明细'),
      h(
        'ul',
        { className: 'luo-comparison-list' },
        diff.rows
          .slice(0, 50)
          .map((row) =>
            h(
              'li',
              { key: row.stockId },
              h('strong', null, row.stock?.stockName ?? row.stockId),
              h(
                'span',
                null,
                row.changes.map((change) => changeLabels[change] ?? '变化待核对').join(' · '),
              ),
            ),
          ),
      ),
      diff.rows.length > 50
        ? h('p', { className: 'luo-fine' }, `此处显示前 50 条，共 ${int(diff.rows.length)} 条。`)
        : null,
    ),
  );

const operationLabels = {
  create_strategy_version: '保存不可变候选版本',
  validate_strategy_version: '校验候选版本',
  save_strategy_research_state: '保存研究问题、范围与结论',
  trial_strategy_version: '执行同快照试跑',
  run_strategy_research_comparison: '执行有界候选对照',
  start_strategy_evaluation_session: '建立历史评估任务',
  cancel_strategy_evaluation_session: '取消历史评估',
  resume_strategy_evaluation_session: '续跑历史评估',
  run_strategy_daily_cycle: '立即执行策略日循环',
};

export const OperationReceipt = ({ control }) => {
  const { operation, busy, error, expired } = control;
  if (!operation && !error) return null;
  const pending = operation?.state === 'pending';
  const uncertain = ['preparing', 'unknown', 'executing'].includes(operation?.state);
  return h(
    'aside',
    {
      className: 'luo-research-operation',
      'aria-label': '研究操作回执',
      'aria-live': 'polite',
    },
    h('strong', null, operationLabels[operation?.tool] ?? '研究操作'),
    h(
      'p',
      { className: 'luo-fine' },
      expired
        ? '操作已过期，请重新执行。'
        : {
            preparing: '正在提交操作',
            pending: '操作待执行',
            executing: '已提交，正在执行',
            unknown: '结果待核对，请勿重复执行',
            succeeded: '操作已完成',
            cancelled: '你已取消此操作',
            failed: '操作失败，研究问题仍可保留',
          }[operation?.state],
    ),
    pending && operation.expiresAt
      ? h('p', { className: 'luo-fine' }, `本次操作有效期至 ${when(operation.expiresAt)}`)
      : null,
    operation?.input
      ? h(
          'details',
          null,
          h('summary', null, '核对本次冻结内容'),
          h('pre', { tabIndex: 0 }, JSON.stringify(operation.input, null, 2)),
        )
      : null,
    error ? h(ErrorNote, { error }) : null,
    operation?.result?.ok === false
      ? h(ErrorNote, { error: researchErrorText(operation.result.error) })
      : null,
    h(
      'div',
      { className: 'luo-actions' },
      pending && !expired && operation.confirmationToken
        ? [
            h(
              'button',
              {
                key: 'confirm',
                type: 'button',
                className: 'luo-btn is-primary',
                disabled: busy,
                onClick: control.confirm,
              },
              '执行本次操作',
            ),
            h(
              'button',
              {
                key: 'cancel',
                type: 'button',
                className: 'luo-btn',
                disabled: busy,
                onClick: control.cancel,
              },
              '取消本次操作',
            ),
          ]
        : null,
      pending && !expired && !operation.confirmationToken
        ? h(
            'p',
            { className: 'luo-fine' },
            '此页已恢复操作身份，原执行凭据未保存在浏览器。请在原页面处理，或等操作过期后重新执行。',
          )
        : null,
      uncertain || pending
        ? h(
            'button',
            { type: 'button', className: 'luo-btn', disabled: busy, onClick: control.check },
            '查询原操作状态',
          )
        : null,
      ['unknown', 'executing'].includes(operation?.state)
        ? h(
            'button',
            { type: 'button', className: 'luo-btn', disabled: busy, onClick: control.reconcile },
            '核对业务回执',
          )
        : null,
      operation && (!operationIsUnsettled(operation) || expired)
        ? h(
            'button',
            { type: 'button', className: 'luo-btn', disabled: busy, onClick: control.clear },
            '收起回执',
          )
        : null,
    ),
  );
};

export const ObservationSummary = ({ observations, version, title = '真实信号观察' }) =>
  h(
    Card,
    { title, meta: observations ? h(ResearchStatus, { status: observations.status }) : null },
    h(
      'p',
      { className: 'luo-fine' },
      'T+1 / T+3 / T+5 跟踪信号发生后的个股表现。观察均值不是组合净收益，也不是严格回测。',
    ),
    h(
      'p',
      { className: 'luo-fine' },
      version
        ? `观察来自第 ${version.version} 版的已发布正式运行；可能与当前研究候选不同。`
        : '观察所用版本尚未核对。',
    ),
    observations?.horizons?.length
      ? h(
          'div',
          { className: 'luo-observation-horizons' },
          observations.horizons.map((item) =>
            h(
              'div',
              { key: item.horizon },
              h('strong', null, { t1: 'T+1', t3: 'T+3', t5: 'T+5' }[item.horizon]),
              h(
                'dl',
                { className: 'luo-strategy-facts' },
                [
                  ['完整 / 总样本', `${int(item.complete)} / ${int(item.total)}`],
                  ['待完成', int(item.pending)],
                  ['数据缺失', int(item.missing)],
                  ['个股平均变化', ratio(item.averageReturnPct)],
                  ['基准覆盖', ratio(item.benchmarkCoverageRatio, 1, false)],
                  ['个股平均超额', ratio(item.averageExcessReturnPct)],
                ].map(([label, value]) =>
                  h('div', { key: label }, h('dt', null, label), h('dd', null, value)),
                ),
              ),
              h('p', { className: 'luo-fine' }, `观察截止 ${when(item.observedAsOf)}`),
            ),
          ),
        )
      : h(Empty, { title: '尚无真实观察样本', hint: '等待正式信号和后续事实，未提供收益。' }),
    h(ResearchLimitations, { items: observations?.limitations ?? [] }),
  );

export const StrictBacktests = ({ runs = [] }) =>
  h(
    Card,
    { title: '严格组合回测', meta: `${runs.length} 份记录` },
    h(
      'p',
      { className: 'luo-fine' },
      '执行模型：下一交易日开盘全量调仓、等权配置；费用、滑点、可交易性、公司行动、基准和 PIT 数据分别检查。',
    ),
    runs.length
      ? runs.map((run) =>
          h(
            'div',
            { key: run.id, className: 'luo-strict-result' },
            h(
              'div',
              { className: 'luo-rule-heading' },
              h(ResearchStatus, { status: run.status }),
              h(
                Pill,
                { tone: run.resultAvailability === 'complete' ? 'accent' : 'warn' },
                run.resultAvailability === 'complete' ? '数据门禁完备' : '数据门禁存在缺口',
              ),
              h('span', { className: 'luo-fine' }, `${when(run.spec.from)} → ${when(run.spec.to)}`),
            ),
            h(
              'p',
              { className: 'luo-fine' },
              `基准 ${run.spec.benchmark.stockId} · 初始资金 ${money(run.spec.initialCash)} · 最大持仓 ${int(run.spec.execution.maxPositions)}`,
            ),
            run.resultAvailability === 'complete' && run.metrics
              ? h(
                  'div',
                  { className: 'luo-stats' },
                  h(Stat, { k: '净收益', v: ratio(run.metrics.netReturnPct) }),
                  h(Stat, { k: '最大回撤', v: ratio(run.metrics.maxDrawdownPct, 2, false) }),
                  h(Stat, { k: '基准收益', v: ratio(run.metrics.benchmarkReturnPct) }),
                  h(Stat, { k: '成交笔数', v: int(run.metrics.tradeCount) }),
                )
              : h('p', { className: 'luo-fine' }, '未产生完整组合绩效；请先补齐下方证据。'),
            run.error ? h(ErrorNote, { error: strategyText(run.error) }) : null,
            h(ResearchLimitations, {
              items: [
                ...(run.gateAudit?.items ?? [])
                  .filter((item) => item.status !== 'complete')
                  .map((item) => item.reason),
                ...(run.limitations ?? []),
              ],
            }),
          ),
        )
      : h(Empty, {
          title: '尚无严格回测记录',
          hint: '数据门禁完备后才能计算组合绩效；可在对话中发起检查。',
        }),
  );
