// 组合回测面板的渲染判定（REQ-M1-05 §4 + T22 语义）。
//
// 两个字段回答两个不同问题，不能混用：
// - `gateAudit.status` 答「有没有已披露缺口」（T22 起 corporate-actions 恒 unavailable，
//   所以它通常是 partial；partial 只表示有缺口，不表示结果无效）；
// - `resultAvailability` 答「这次运行的结果能不能用」（执行确实产出 metrics 时为 complete）。
// 只有 `resultAvailability === 'complete'` 才渲染收益数字；门禁 partial 只影响披露。
//
// 为什么把判定抽到这个模块：client 组件依赖 `react`（由 DSH 宿主注入，本仓不安装，
// 测试环境无法渲染），所以「什么该显示」必须是一份不依赖 react 的纯数据判定，
// 组件与测试读同一份结果 —— 否则断言只能抄一遍组件的 if，抄错了也不会红。
import { int, ratio } from './format.js';

/** 门禁态下的固定文案；组件只做排版，不自己拼数值条件。 */
export const STRICT_BACKTEST_COPY = Object.freeze({
  title: '组合回测（门禁审计）',
  empty: {
    title: '尚无组合回测记录',
    hint: '门禁完备后才会计算组合绩效；可在对话中发起检查。',
  },
  gate: {
    complete: '数据门禁完备',
    incomplete: '数据门禁存在缺口',
    missing: '门禁审计缺失：没有可比对的逐项事实。',
  },
  auditTitle: '门禁审计',
  blockerTitle: '阻塞项',
});

/** 只有门禁完备时才允许出现的指标（标签与取值同源，避免各写一份）。 */
const metricRows = (metrics) => [
  { key: 'netReturn', label: '净收益', value: ratio(metrics.netReturnPct) },
  { key: 'maxDrawdown', label: '最大回撤', value: ratio(metrics.maxDrawdownPct, 2, false) },
  { key: 'benchmarkReturn', label: '基准收益', value: ratio(metrics.benchmarkReturnPct) },
  { key: 'tradeCount', label: '成交笔数', value: int(metrics.tradeCount) },
];

/**
 * 一次运行的渲染视图。
 *
 * - `gateComplete`：门禁是否没有缺口（`gateAudit.status === 'complete'`），只影响文案；
 * - `metrics`：唯一判定源是 `resultAvailability === 'complete'`，且必须真的带 metrics；
 *   两者缺一就 fail-closed 为 `null`（不看门禁 partial——那是缺口披露，不是无效）；
 * - `auditRows` / `blockers`：任何状态都带审计表；阻塞项 = 门禁未 complete 时的逐项原因
 *   + `run.limitations`（机制级缺口，例如未考虑分红送转）。
 */
export const strictBacktestView = (run) => {
  const gateAudit = run?.gateAudit ?? null;
  const gateStatus = gateAudit?.status ?? 'unavailable';
  const gateComplete = gateStatus === 'complete';
  const resultComplete = run?.resultAvailability === 'complete';
  const auditRows = (gateAudit?.items ?? []).map((item) => ({
    key: item.key,
    status: item.status,
    reason: item.reason,
  }));
  const gateBlockers = auditRows
    .filter((row) => row.status !== 'complete')
    .map((row) => row.reason);
  return {
    gateStatus,
    gateComplete,
    gateLabel: gateComplete
      ? STRICT_BACKTEST_COPY.gate.complete
      : STRICT_BACKTEST_COPY.gate.incomplete,
    auditRows,
    blockers: [
      ...(gateComplete
        ? []
        : gateBlockers.length === 0
          ? [STRICT_BACKTEST_COPY.gate.missing]
          : gateBlockers),
      ...(run?.limitations ?? []),
    ],
    metrics: resultComplete && run?.metrics ? metricRows(run.metrics) : null,
  };
};
