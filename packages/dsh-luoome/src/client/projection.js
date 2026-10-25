// dsh-luoome client 纯投影函数（不 import react，便于 Node/vitest 单测）。
//
// 只把宿主 /api/luoome/state 的 ToolResult 投影成展示模型：不重算业务数字、
// 不推断用户跟随、不把未知写成零。组件与 data.js 复用同一实现。

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export const PANEL_STATE_PATH = '/api/luoome/state';

/** 一次面板状态请求的 URL（只带 panel 名，不携带工具/账户参数）。 */
export const stateUrl = (panel) => `${PANEL_STATE_PATH}?panel=${encodeURIComponent(panel)}`;

/**
 * 把宿主状态响应投影成旧面板使用的 results map。
 *
 * 只做形状转换：成功保留 data，失败原样保留 error；服务端返回的 strategies 派生
 * workspace 也按 strategyId 建索引，供策略面板展示当前版本/运行/健康。
 */
export const mapStateBody = (body) => {
  if (!isRecord(body)) throw new Error('面板响应无效');
  const results = {};
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const entry of tools) {
    if (!isRecord(entry) || typeof entry.name !== 'string') continue;
    results[entry.name] =
      entry.ok === true
        ? { ok: true, data: entry.data }
        : { ok: false, error: isRecord(entry.error) ? entry.error : { kind: 'unavailable' } };
  }
  const strategies = [];
  if (Array.isArray(body.strategies)) {
    for (const item of body.strategies) {
      if (!isRecord(item) || typeof item.strategyId !== 'string') continue;
      const workspace = isRecord(item.workspace) ? item.workspace : null;
      strategies.push({
        strategyId: item.strategyId,
        workspace:
          workspace === null
            ? null
            : workspace.ok === true
              ? { ok: true, data: workspace.data }
              : { ok: false, error: workspace.error ?? { kind: 'unavailable' } },
      });
    }
  }
  return {
    panel: typeof body.panel === 'string' ? body.panel : '',
    asOf: typeof body.asOf === 'string' ? body.asOf : null,
    results,
    strategies,
  };
};

export const resultOf = (results, tool) => results?.[tool] ?? null;
export const dataOf = (results, tool) => {
  const result = results?.[tool];
  return result && result.ok === true ? result.data : null;
};
export const errorOf = (results, tool) => {
  const result = results?.[tool];
  return result && result.ok !== true ? (result.error ?? { message: '读取失败' }) : null;
};

// ---------- 纯投影函数（客户端展示 + 单测共用；不重算业务数字） ----------

export const workspaceOf = (state, strategyId) =>
  state?.strategies?.find((item) => item.strategyId === strategyId)?.workspace ?? null;

export const workspaceDataOf = (state, strategyId) => {
  const workspace = workspaceOf(state, strategyId);
  return workspace && workspace.ok === true ? workspace.data : null;
};

export const workspaceErrorOf = (state, strategyId) => {
  const workspace = workspaceOf(state, strategyId);
  return workspace && workspace.ok !== true ? (workspace.error ?? { kind: 'unavailable' }) : null;
};

const FEEDBACK_LABELS = {
  followed: { label: '已跟随', tone: 'accent' },
  partially_followed: { label: '部分跟随', tone: 'warn' },
  ignored: { label: '已忽略', tone: 'quiet' },
};

/** 逐条 Advice 的用户明确反馈；没有回填时返回 null（不推断跟随）。 */
export const adviceFeedbackOf = (advice) => {
  const outcome = advice?.outcome;
  if (!isRecord(outcome) || typeof outcome.outcome !== 'string') return null;
  const meta = FEEDBACK_LABELS[outcome.outcome] ?? { label: outcome.outcome, tone: 'quiet' };
  return {
    ...meta,
    outcome: outcome.outcome,
    pnl: typeof outcome.pnl === 'number' ? outcome.pnl : null,
    notes: typeof outcome.notes === 'string' ? outcome.notes : null,
    recordedAt: typeof outcome.recordedAt === 'string' ? outcome.recordedAt : null,
  };
};

/** 信心校准只展示有样本的桶；比例结论仍由工具输出（hitRate）决定，不在客户端重算。 */
export const calibrationRows = (calibration) => {
  const buckets = Array.isArray(calibration?.buckets) ? calibration.buckets : [];
  return buckets
    .filter((bucket) => isRecord(bucket) && (bucket.total ?? 0) > 0)
    .map((bucket) => ({
      key: `${bucket.range?.min ?? '?'}-${bucket.range?.max ?? '?'}`,
      range: bucket.range === undefined ? '—' : `${bucket.range.min}–${bucket.range.max}`,
      total: bucket.total ?? 0,
      withOutcome: bucket.withOutcome ?? 0,
      followedWithPnl: bucket.followedWithPnl ?? 0,
      hitRate: typeof bucket.hitRate === 'number' ? bucket.hitRate : null,
      avgConfidence: typeof bucket.avgConfidence === 'number' ? bucket.avgConfidence : null,
    }));
};

const REVIEW_SOURCE_LABELS = {
  advice: '建议',
  'watch-trigger': '盯盘触发',
  trade: '成交',
  holding: '持仓',
  position: '持仓',
  strategy: '策略',
  portfolio: '组合',
};

/** DecisionReview 最近记录：只投影 review/subject/revision，不重算修订内容。 */
export const decisionReviewRows = (reviewList) => {
  const records = Array.isArray(reviewList?.records) ? reviewList.records : [];
  return records.map((record) => {
    const review = isRecord(record?.review) ? record.review : {};
    const revision = isRecord(record?.revision) ? record.revision : {};
    const subject = isRecord(review.subject) ? review.subject : {};
    const kind = typeof subject.kind === 'string' ? subject.kind : 'unknown';
    return {
      key: typeof review.id === 'string' ? review.id : `${kind}:${subject.id ?? ''}`,
      kind,
      kindLabel: REVIEW_SOURCE_LABELS[kind] ?? kind,
      subjectId: typeof subject.id === 'string' ? subject.id : '',
      stockId: typeof review.stockId === 'string' ? review.stockId : null,
      sourceOccurredAt:
        typeof review.sourceOccurredAt === 'string' ? review.sourceOccurredAt : null,
      currentRevision: typeof review.currentRevision === 'number' ? review.currentRevision : null,
      revision: typeof revision.revision === 'number' ? revision.revision : null,
      recordedAt: typeof revision.recordedAt === 'string' ? revision.recordedAt : null,
      changeNote: typeof revision.changeNote === 'string' ? revision.changeNote : null,
    };
  });
};

/** 策略面板：最近 published operational run，按 strategyId 分组（只取工具原值）。 */
export const publishedRunsByStrategy = (runsList) => {
  const runs = Array.isArray(runsList?.runs) ? runsList.runs : [];
  const byStrategy = new Map();
  for (const run of runs) {
    if (!isRecord(run) || typeof run.strategyId !== 'string') continue;
    const group = byStrategy.get(run.strategyId) ?? [];
    group.push(run);
    byStrategy.set(run.strategyId, group);
  }
  return byStrategy;
};

/** 决策闭环摘要：窗口/未知/限制原样展示，不推断因果。 */
export const decisionLoopSummary = (review) => {
  if (!isRecord(review)) return null;
  const window = isRecord(review.window) ? review.window : {};
  const unknowns = Array.isArray(review.unknowns)
    ? review.unknowns.filter((item) => typeof item === 'string')
    : [];
  const limitations = Array.isArray(review.limitations)
    ? review.limitations.filter((item) => typeof item === 'string')
    : [];
  return {
    dataAsOf: typeof review.dataAsOf === 'string' ? review.dataAsOf : null,
    since: typeof window.since === 'string' ? window.since : null,
    until: typeof window.until === 'string' ? window.until : null,
    unknowns,
    limitations,
    evidenceCount: Array.isArray(review.evidenceIds) ? review.evidenceIds.length : 0,
    decisionRecords: isRecord(review.decisionRecords) ? review.decisionRecords : null,
    signalObservations: isRecord(review.signalObservations) ? review.signalObservations : null,
  };
};

/** 「在对话中研究此策略」请求：携带 strategyId/runId，由 client 入口导航到会话并写入草稿。 */
export const researchRequestFor = (strategyId, runId = null) => ({
  strategyId,
  runId: runId ?? null,
  prompt: `请研究策略 ${strategyId}${runId ? ` 的已发布运行 ${runId}` : ''}：先读 get_strategy_workspace / list_strategy_runs 的真实事实，给出结论、证据、反证、风险与有效期；不要自动发布或修改策略，任何写入都要先让我确认。`,
});
