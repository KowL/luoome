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
  // 两个清单语义不同，标题必须分开：阻塞项 = 门禁为什么不完备；
  // 披露 = 这次结果已经产出，但存在已知偏差（例如未考虑分红送转）。
  blockerTitle: '阻塞项',
  disclosureTitle: '结果已知偏差披露',
});

/** 指标缺失的具体原因；只在 `metrics` 为 null 时出现，绝不用于放宽 fail-closed。 */
export const METRICS_UNAVAILABLE_COPY = Object.freeze({
  missingAvailability: '该 run 缺少 resultAvailability 字段，无法判定结果可用性',
  incomplete: (status) => `resultAvailability 为 ${status}：本次运行未产出可用结果`,
  missingMetrics: 'resultAvailability 为 complete 但缺少 metrics：没有可渲染的绩效数字',
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
 * - `metricsUnavailableReason`：`metrics` 为 null 时的具体原因，保证「数字不见了」有解释；
 *   判定不放宽——旧 run 没有 resultAvailability 就如实说无法判定；
 * - `auditRows`：任何状态都带审计表；
 * - `blockers`：只装门禁未 complete 时的逐项原因（回答「为什么门禁不完备」）；
 * - `disclosures`：只装 `run.limitations`（回答「这次结果已知有哪些偏差」）。
 *   两者混在一个字段里会让 UI 把「已产出但有偏差」误读成「被挡住没跑」。
 */
export const strictBacktestView = (run) => {
  const gateAudit = run?.gateAudit ?? null;
  const gateStatus = gateAudit?.status ?? 'unavailable';
  const gateComplete = gateStatus === 'complete';
  const availability = run?.resultAvailability;
  const resultComplete = availability === 'complete';
  const auditRows = (gateAudit?.items ?? []).map((item) => ({
    key: item.key,
    status: item.status,
    reason: item.reason,
  }));
  const gateBlockers = auditRows
    .filter((row) => row.status !== 'complete')
    .map((row) => row.reason);
  const metricList = resultComplete && run?.metrics ? metricRows(run.metrics) : null;
  const unavailableReason = (() => {
    if (availability === undefined || availability === null) {
      return METRICS_UNAVAILABLE_COPY.missingAvailability;
    }
    if (!resultComplete) return METRICS_UNAVAILABLE_COPY.incomplete(availability);
    return METRICS_UNAVAILABLE_COPY.missingMetrics;
  })();
  return {
    gateStatus,
    gateComplete,
    gateLabel: gateComplete
      ? STRICT_BACKTEST_COPY.gate.complete
      : STRICT_BACKTEST_COPY.gate.incomplete,
    auditRows,
    blockers: gateComplete
      ? []
      : gateBlockers.length === 0
        ? [STRICT_BACKTEST_COPY.gate.missing]
        : gateBlockers,
    disclosures: [...(run?.limitations ?? [])],
    metrics: metricList,
    metricsUnavailableReason: metricList ? undefined : unavailableReason,
  };
};
