import { buildStrategyHash } from './strategy-workspace-route.js';
import {
  badge,
  callApi,
  closeModal,
  confirmDialog,
  createFeatureCache,
  DATA_HEALTH,
  el,
  errorText,
  fmtNum,
  fmtSigned,
  metric,
  openModal,
  post,
  promptDialog,
  RUN_STATUS,
} from './strategy-workspace-shared.js';

const featureCache = createFeatureCache();
export const invalidateBacktestCache = () => featureCache.clear();

export const parseBacktestStockIds = (value) => {
  const stockIds = [
    ...new Set(
      String(value ?? '')
        .split(/[\s,，;；]+/)
        .map((stockId) => stockId.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  return stockIds.length === 0 ? undefined : stockIds;
};

const BACKTEST_STATUS = {
  complete: ['完成', 'badge-active'],
  partial: ['部分完成', 'badge-important'],
  failed: ['失败', 'badge-pos'],
};

const VINTAGE_STATUS = {
  available: ['版本可用', 'badge-active'],
  unavailable: ['版本不可用', 'badge-important'],
  'not-applicable': ['不适用', 'badge-neutral'],
};

const STRICT_GATE_STATUS = {
  complete: ['完整', 'badge-active'],
  partial: ['部分可用', 'badge-important'],
  unavailable: ['不可用', 'badge-pos'],
};

export const buildStrictBacktestResultContent = (run) => {
  const gateRows = (run.gateAudit?.items ?? []).map((item) =>
    el('tr', null, [
      el('td', 'mono', item.key),
      el('td', null, badge(STRICT_GATE_STATUS[item.status], item.status)),
      el(
        'td',
        'muted',
        [item.reason ?? item.detail ?? '', ...(item.evidenceRefs ?? [])]
          .filter(Boolean)
          .join(' · '),
      ),
    ]),
  );
  const metrics = run.metrics;
  const metricNodes =
    metrics === undefined
      ? [
          el(
            'p',
            'status warning',
            '数据门禁未完整通过，净值、收益、回撤等指标暂不可用；不会输出伪造 Sharpe 或胜率。',
          ),
        ]
      : [
          el('div', 'strategy-summary-grid', [
            metric('最终净值', fmtNum(metrics.finalEquity)),
            metric('净收益', `${fmtSigned(metrics.netReturnPct)}%`),
            metric('最大回撤', `${fmtSigned(metrics.maxDrawdownPct)}%`),
            metric('基准收益', `${fmtSigned(metrics.benchmarkReturnPct)}%`),
            metric('超额收益', `${fmtSigned(metrics.excessReturnPct)}%`),
            metric('成交笔数', metrics.tradeCount),
          ]),
        ];
  return el('div', 'strategy-backtest-result', [
    el(
      'p',
      'muted',
      `严格回测 ${run.id} · ${run.status} · 输入指纹 ${String(run.inputFingerprint ?? '').slice(0, 12) || '--'}${run.inputFingerprint ? '…' : ''}`,
    ),
    ...metricNodes,
    el('h4', null, '门禁审计'),
    ...(gateRows.length === 0
      ? [el('p', 'placeholder', '暂无门禁审计。')]
      : [
          el('div', 'table-wrap', [
            el('table', 'table', [
              el(
                'thead',
                null,
                el(
                  'tr',
                  null,
                  ['门禁', '状态', '证据'].map((label) => el('th', null, label)),
                ),
              ),
              el('tbody', null, gateRows),
            ]),
          ]),
        ]),
    ...(run.error === undefined ? [] : [el('p', 'status error', run.error)]),
    el('p', 'muted', '严格回测与生产运行、历史评估隔离，不生成 Advice、Trade 或通知。'),
  ]);
};

export const runStrictStrategyBacktest = async (strategy, input, setStatus) => {
  setStatus('正在检查严格回测数据门禁…');
  const created = await post(
    `/api/strategies/${encodeURIComponent(strategy.id)}/strict-backtests`,
    input,
  );
  if (!created.ok) {
    setStatus(errorText(created), true);
    return created;
  }
  const initial = created.data?.run;
  const runId = initial?.id;
  if (typeof runId !== 'string') return created;
  let run = initial;
  for (
    let attempt = 0;
    attempt < 360 && (run.status === 'queued' || run.status === 'running');
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const snapshot = await callApi(
      `/api/strategies/${encodeURIComponent(strategy.id)}/strict-backtests/${encodeURIComponent(runId)}`,
    );
    if (!snapshot.ok) {
      setStatus(errorText(snapshot), true);
      return snapshot;
    }
    run = snapshot.data.run;
    setStatus(`严格回测：${run.status}，门禁 ${run.gateAudit?.status ?? 'unknown'}`);
  }
  openModal(`严格回测 · ${strategy.name}`, buildStrictBacktestResultContent(run));
  setStatus(
    run.metrics === undefined
      ? `严格回测${run.resultAvailability === 'unavailable' ? '不可用' : '部分完成'}：请查看门禁审计`
      : `严格回测完成：净收益 ${fmtSigned(run.metrics.netReturnPct)}%`,
    run.metrics === undefined,
  );
  return { ...created, data: { run } };
};

const openStrictBacktestDialog = async (strategy, setStatus) => {
  const values = await promptDialog({
    title: `严格回测 · ${strategy.name}`,
    fields: [
      { key: 'evaluationSessionId', label: '历史评估 session ID', value: '' },
      { key: 'initialCash', label: '初始资金', value: '1000000' },
      { key: 'commissionBps', label: '佣金（bps）', value: '3' },
      { key: 'minimumCommission', label: '最低佣金', value: '5' },
      { key: 'sellStampDutyBps', label: '卖出印花税（bps）', value: '5' },
      { key: 'buySlippageBps', label: '买入滑点（bps）', value: '2' },
      { key: 'sellSlippageBps', label: '卖出滑点（bps）', value: '2' },
    ],
    confirmLabel: '创建严格回测',
    note: '必须提供已完成的历史评估 session。任一 PIT、修订、费用、滑点、可交易性、公司行动、基准或求值器身份门禁缺失时，只返回不可用/部分结果，不生成收益指标。',
  });
  if (values === null) return;
  await runStrictStrategyBacktest(
    strategy,
    {
      evaluationSessionId: values.evaluationSessionId,
      initialCash: Number(values.initialCash),
      costs: {
        commissionBps: Number(values.commissionBps),
        minimumCommission: Number(values.minimumCommission),
        sellStampDutyBps: Number(values.sellStampDutyBps),
        buySlippageBps: Number(values.buySlippageBps),
        sellSlippageBps: Number(values.sellSlippageBps),
      },
    },
    setStatus,
  );
};

export const buildBacktestResultContent = (data, strategyId = '', sessionId) => {
  const summary = data.summary;
  const evaluationSessionId = sessionId ?? data.sessionId ?? data.session?.id;
  const evaluationButton = el('button', 'btn btn-outline btn-sm', '查看历史评估记录');
  evaluationButton.type = 'button';
  const evaluationHash = buildStrategyHash({
    strategyId,
    tab: 'runs',
    scope: 'evaluation',
  });
  evaluationButton.addEventListener('click', () => {
    window.location.hash = evaluationHash;
    closeModal();
  });
  const rows = (data.days ?? []).map((day) =>
    el('tr', null, [
      el('td', 'mono', String(day.dataAsOf).slice(0, 10)),
      el('td', null, badge(BACKTEST_STATUS[day.status], day.status)),
      el('td', null, badge(VINTAGE_STATUS[day.vintageStatus], day.vintageStatus)),
      el('td', 'num mono', day.evaluatedCount ?? '--'),
      el('td', 'num mono', day.selectedCount ?? '--'),
      el('td', 'num mono', day.signalCount ?? '--'),
      el('td', 'num mono', day.failedCount ?? '--'),
      el('td', 'muted', day.error ?? ''),
    ]),
  );
  return el('div', 'strategy-backtest-result', [
    el('div', 'strategy-summary-grid', [
      metric(
        '交易日',
        summary.tradingDays,
        `完成 ${summary.completedDays} · 失败 ${summary.failedDays}`,
      ),
      metric('累计求值', summary.evaluatedCount),
      metric('累计入选', summary.selectedCount),
      metric('累计信号', summary.signalCount),
    ]),
    ...(strategyId.length === 0 ? [] : [el('div', 'modal-actions', evaluationButton)]),
    el(
      'p',
      'status warning',
      '这是按历史时点逐日重放的策略模拟，只统计规则命中与信号；不含收益、费用、滑点和可交易性模拟，不构成投资建议。',
    ),
    ...(rows.length === 0
      ? [el('p', 'placeholder', '所选区间没有交易日。')]
      : [
          el('div', 'table-wrap', [
            el('table', 'table', [
              el(
                'thead',
                null,
                el(
                  'tr',
                  null,
                  ['日期', '状态', '历史数据', '求值', '入选', '信号', '失败', '说明'].map(
                    (label) => el('th', null, label),
                  ),
                ),
              ),
              el('tbody', null, rows),
            ]),
          ]),
        ]),
    ...(evaluationSessionId === undefined
      ? []
      : [el('p', 'mono muted', `Evaluation session ${evaluationSessionId}`)]),
  ]);
};

const buildBacktestProgressContent = (data, strategyId, sessionId, setStatus) => {
  const summary = data.summary ?? {
    tradingDays: 0,
    completedDays: 0,
    failedDays: 0,
    selectedCount: 0,
  };
  const cancel = el('button', 'btn btn-danger btn-sm', '取消历史评估');
  cancel.type = 'button';
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    const result = await post(
      `/api/strategies/${encodeURIComponent(strategyId)}/backtests/${encodeURIComponent(sessionId)}/cancel`,
      {},
    );
    setStatus(result.ok ? '已请求取消历史评估，已完成日期会保留' : errorText(result), !result.ok);
  });
  return el('div', 'strategy-backtest-progress', [
    el(
      'p',
      null,
      `已完成 ${summary.completedDays ?? 0}/${summary.tradingDays ?? 0} 个交易日，失败 ${summary.failedDays ?? 0}，累计入选 ${summary.selectedCount ?? 0}`,
    ),
    el('p', 'muted', '任务在后台运行，页面会按日期刷新进度；历史评估不会替换当前生产股票池。'),
    el('div', 'modal-actions', [cancel]),
  ]);
};

export const runStrategyBacktest = async (strategy, input, setStatus) => {
  setStatus('正在逐交易日运行历史模拟…');
  const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/backtests`, input);
  if (!result.ok) {
    setStatus(errorText(result), true);
    return result;
  }
  let completed = result.data?.summary === undefined ? undefined : result.data;
  const sessionId = result.data?.sessionId ?? result.data?.session?.id;
  if (completed === undefined && typeof sessionId === 'string') {
    openModal(
      `模拟回测（历史回放）· ${strategy.name}`,
      buildBacktestProgressContent(result.data, strategy.id, sessionId, setStatus),
    );
    for (let attempt = 0; attempt < 360; attempt += 1) {
      const snapshot = await callApi(
        `/api/strategies/${encodeURIComponent(strategy.id)}/backtests/${encodeURIComponent(sessionId)}`,
      );
      if (!snapshot.ok) {
        setStatus(errorText(snapshot), true);
        return snapshot;
      }
      const data = snapshot.data;
      const summary = data.summary ?? {};
      setStatus(
        `历史评估进度：${summary.completedDays ?? 0}/${summary.tradingDays ?? 0} 个交易日，已入选 ${summary.selectedCount ?? 0}`,
      );
      if (data.status !== 'running' && data.session?.status !== 'running') {
        completed = data;
        break;
      }
      openModal(
        `模拟回测（历史回放）· ${strategy.name}`,
        buildBacktestProgressContent(data, strategy.id, sessionId, setStatus),
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (completed === undefined) {
    setStatus('历史评估仍在后台运行，可在执行记录中查看进度', false);
    return result;
  }
  featureCache.clear();
  openModal(
    `模拟回测（历史回放）· ${strategy.name}`,
    buildBacktestResultContent(completed, strategy.id, sessionId),
  );
  const completionLabel =
    completed.status === 'complete'
      ? '历史模拟完成'
      : completed.status === 'partial'
        ? '历史模拟部分完成'
        : '历史模拟失败或已取消';
  setStatus(
    `${completionLabel}：${completed.summary.completedDays}/${completed.summary.tradingDays} 个交易日，累计入选 ${completed.summary.selectedCount}，信号 ${completed.summary.signalCount}`,
    completed.status !== 'complete',
  );
  return { ...result, data: completed };
};

const localDateText = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const openBacktestDialog = async (strategy, setStatus) => {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  const values = await promptDialog({
    title: `模拟回测（历史回放）· ${strategy.name}`,
    fields: [
      { key: 'from', label: '开始日期（YYYY-MM-DD）', value: localDateText(from) },
      { key: 'to', label: '结束日期（YYYY-MM-DD）', value: localDateText(to) },
      {
        key: 'stockIds',
        label: '股票代码（可选，逗号或换行分隔）',
        value: '',
        multiline: true,
        rows: 4,
      },
    ],
    confirmLabel: '开始模拟',
    note: '最长 31 个自然日；留空将按历史时点全市场运行，可能耗时。结果保存为历史评估，不会替换当前股票池。',
  });
  if (values === null) return;
  const stockIds = parseBacktestStockIds(values.stockIds);
  if (stockIds !== undefined && stockIds.length > 500) {
    setStatus('模拟范围最多包含 500 只股票', true);
    return;
  }
  await runStrategyBacktest(
    strategy,
    {
      from: values.from,
      to: values.to,
      ...(stockIds === undefined ? {} : { stockIds }),
    },
    setStatus,
  );
};

const runAction = async (strategy, persist, setStatus, refresh) => {
  let stockIds;
  if (!persist) {
    const values = await promptDialog({
      title: '样本试跑',
      fields: [{ key: 'stockId', label: '样本股票代码', value: '600519.SH' }],
      confirmLabel: '试跑',
      note: '试跑读取外部行情，但不落库、不替换当前股票池。',
    });
    if (values === null || values.stockId.length === 0) return;
    stockIds = [values.stockId];
  } else {
    const confirmed = await confirmDialog({
      title: '正式运行',
      message:
        '将执行全市场扫描并原子落库。只有运行验收通过才会替换当前股票池；验收未通过或执行失败时保留上一份股票池。',
      confirmLabel: '开始运行',
    });
    if (!confirmed) return;
  }
  setStatus(persist ? '策略正式运行中…' : '策略样本试跑中…');
  const result = await post(`/api/strategies/${encodeURIComponent(strategy.id)}/run`, {
    ...(stockIds === undefined ? {} : { stockIds }),
    persist,
  });
  if (!result.ok) {
    setStatus(errorText(result), true);
    return;
  }
  featureCache.clear();
  const dataHealth =
    result.data.run.summary?.schemaVersion === 3
      ? `，数据${DATA_HEALTH[result.data.run.summary.dataHealth] ?? result.data.run.summary.dataHealth}`
      : '';
  setStatus(
    persist
      ? `运行${RUN_STATUS[result.data.run.status]?.[0] ?? result.data.run.status}${dataHealth}；结果 ${result.data.results.length}，信号 ${result.data.signals.length}`
      : `试跑${RUN_STATUS[result.data.run.status]?.[0] ?? result.data.run.status}${dataHealth}；结果 ${result.data.results.length}（未落库）`,
  );
  await refresh();
};

/**
 * 页面头部执行动作的 Interface。shell 只负责把返回的节点挂到策略头部。
 */
export const renderStrategyActions = (workspace, setStatus, refresh) => {
  const strategy = workspace.strategy;
  const headerActions = el('div', 'row-actions');
  if (workspace.currentVersion !== undefined && strategy.status === 'active') {
    const strictBacktest = el('button', 'btn btn-outline btn-sm', '严格回测');
    strictBacktest.type = 'button';
    strictBacktest.addEventListener(
      'click',
      () => void openStrictBacktestDialog(strategy, setStatus),
    );
    const backtest = el('button', 'btn btn-outline btn-sm', '模拟回测');
    backtest.type = 'button';
    backtest.addEventListener('click', () => void openBacktestDialog(strategy, setStatus));
    const sample = el('button', 'btn btn-outline btn-sm', '样本试跑');
    sample.type = 'button';
    sample.addEventListener('click', () => void runAction(strategy, false, setStatus, refresh));
    const formal = el('button', 'btn btn-primary btn-sm', '正式运行');
    formal.type = 'button';
    formal.addEventListener('click', () => void runAction(strategy, true, setStatus, refresh));
    headerActions.append(strictBacktest, backtest, sample, formal);
  }
  return headerActions;
};
