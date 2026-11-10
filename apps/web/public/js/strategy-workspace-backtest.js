import {
  badge,
  callApi,
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
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 30);
  const values = await promptDialog({
    title: `严格回测 · ${strategy.name}`,
    fields: [
      { key: 'from', label: '开始日期（YYYY-MM-DD）', value: from.toISOString().slice(0, 10) },
      { key: 'to', label: '结束日期（YYYY-MM-DD）', value: to.toISOString().slice(0, 10) },
      { key: 'initialCash', label: '初始资金', value: '1000000' },
      { key: 'commissionBps', label: '佣金（bps）', value: '3' },
      { key: 'minimumCommission', label: '最低佣金', value: '5' },
      { key: 'sellStampDutyBps', label: '卖出印花税（bps）', value: '5' },
      { key: 'buySlippageBps', label: '买入滑点（bps）', value: '2' },
      { key: 'sellSlippageBps', label: '卖出滑点（bps）', value: '2' },
    ],
    confirmLabel: '创建严格回测',
    note: '基于该策略版本在所选区间内的历史运行逐日装配。任一 PIT、日线、费用、滑点、可交易性、基准或求值器身份门禁缺失时，只返回不可用/部分结果，不生成收益指标。',
  });
  if (values === null) return;
  if (typeof strategy.currentVersionId !== 'string') return;
  await runStrictStrategyBacktest(
    strategy,
    {
      strategyVersionId: strategy.currentVersionId,
      from: values.from,
      to: values.to,
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
    const sample = el('button', 'btn btn-outline btn-sm', '样本试跑');
    sample.type = 'button';
    sample.addEventListener('click', () => void runAction(strategy, false, setStatus, refresh));
    const formal = el('button', 'btn btn-primary btn-sm', '正式运行');
    formal.type = 'button';
    formal.addEventListener('click', () => void runAction(strategy, true, setStatus, refresh));
    headerActions.append(strictBacktest, sample, formal);
  }
  return headerActions;
};
