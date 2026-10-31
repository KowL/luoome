// 面板「数据健康」的唯一实现（REQ-M3-09 / S1）。
//
// 语义（Lead 裁定 Q1）：**服务端算**，三档 `available / partial / unavailable` + 原因码 +
// 聚合 `asOf` **取最旧**（角标时间 ≤ 任何行内时间）。
//
// 判定吃**两层**输入，缺一不可：
// 1. 工具调用成败（`ToolResult.ok`）——客户端能观测的只有这一层；
// 2. 工具**输出里的可用性字段**（`status` / `coverage` / `sampleStatus` …）——
//    `ok:true` 但输出 `status:'unavailable'`（例如缺价导致 TWR 算不出来）必须算降级，
//    否则角标会在「面板上根本没有那个数字」的时候显示健康。
//
// 客户端只渲染本文件产出的结果，不再自己判断「这块能不能信」。

export const PANEL_HEALTH_STATUSES = ['available', 'partial', 'unavailable'] as const;
export type PanelHealthStatus = (typeof PANEL_HEALTH_STATUSES)[number];

export const PANEL_HEALTH_REASONS = [
  'tool-failed',
  'output-partial',
  'output-unavailable',
  'missing-data-as-of',
] as const;
export type PanelHealthReason = (typeof PANEL_HEALTH_REASONS)[number];

export interface PanelHealthIssue {
  readonly tool: string;
  readonly reason: PanelHealthReason;
  /** 人可读的一句话，说明**缺什么**。 */
  readonly detail: string;
  /** 补法：缺口必须点名怎么补，不只说「不可用」（M3b-5 方法论）。 */
  readonly remedy: string;
}

export interface PanelHealth {
  readonly status: PanelHealthStatus;
  /**
   * 面板级聚合时点 = 参与面板的、**声明了时点**的工具输出 `dataAsOf` 的**最小值**。
   *
   * 取最旧而不是最新：角标时间必须 ≤ 任何行内时间，否则「角标说最新、某块数字是三小时前」
   * 正是本需求要消灭的现象。任一**声明了时点**的工具没给 `dataAsOf` → 整个 `asOf` 缺席
   * （无法给出上界时不给数字，也不拿请求时间顶替——`PanelStateResponse.asOf` 是请求时间）。
   */
  readonly asOf?: string;
  readonly checkedTools: readonly string[];
  readonly issues: readonly PanelHealthIssue[];
}

/** 面板工具投影的最小形状（与 `panels.ts` 的 `PanelStateTool` 结构一致）。 */
export interface PanelHealthTool {
  readonly name: string;
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const asDate = (value: unknown): Date | undefined => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : undefined;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  }
  return undefined;
};

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

interface OutputAssessment {
  /** 工具输出里**声明**的时点；`undefined` 表示该工具没声明时点（不参与聚合）。 */
  readonly dataAsOf?: Date;
  readonly declaresDataAsOf: boolean;
  readonly status: 'available' | 'partial' | 'unavailable';
  readonly detail?: string;
  readonly remedy?: string;
}

const ok: OutputAssessment = {
  status: 'available',
  declaresDataAsOf: false,
};

const partial = (detail: string, remedy: string): OutputAssessment => ({
  status: 'partial',
  declaresDataAsOf: false,
  detail,
  remedy,
});

const unavailable = (detail: string, remedy: string): OutputAssessment => ({
  status: 'unavailable',
  declaresDataAsOf: false,
  detail,
  remedy,
});

const withAsOf = (assessment: OutputAssessment, dataAsOf: Date | undefined): OutputAssessment =>
  dataAsOf === undefined
    ? { ...assessment, declaresDataAsOf: true }
    : { ...assessment, declaresDataAsOf: true, dataAsOf };

/** 逐工具的可用性映射表：**不在 client 里推断**，这里是唯一口径。 */
const OUTPUT_PROBES: Readonly<Record<string, (data: unknown) => OutputAssessment>> = {
  // 持仓缺价：`list_holdings` 现在**纯读**（task-14 已拆分；旧形态才用成本价顶替现价），
  // 缺价持仓由 `priceStatus: 'unpriced'` + `priceUnavailableReason` 如实披露。
  // 所以「有持仓但没有任何库内报价」必须在角标上体现为降级——否则面板会被当成「全都正常」。
  // 判据同时兼容两种形态：`quote === null`（旧输出）与 `priceStatus === 'unpriced'`（S3 起）。
  list_holdings: (data) => {
    const record = asRecord(data);
    const holdings = asArray(record?.holdings);
    if (holdings.length === 0) return ok;
    const unpriced = holdings.filter((item) => {
      const holding = asRecord(item);
      if (holding === null) return false;
      // 两种形态都算缺价：S3 之前的 `quote === null`，以及 S3 起的 `priceStatus: 'unpriced'`。
      return holding.quote === null || holding.priceStatus === 'unpriced';
    });
    return unpriced.length === 0
      ? ok
      : partial(
          `${String(unpriced.length)} 只持仓没有库内报价（缺价的合计字段缺席，不按 0 计）`,
          '先运行 refresh_holdings_quotes 刷新报价后重试',
        );
  },
  list_account_performance_snapshots: (data) => {
    const record = asRecord(data);
    const snapshots = asArray(record?.snapshots);
    if (snapshots.length === 0)
      return unavailable(
        '没有已落库绩效快照',
        '先运行 get_account_performance 或盘后 snapshot-account-performance',
      );
    const latest = asRecord(snapshots[0]);
    const degraded: string[] = [];
    const metrics = asRecord(latest?.metrics);
    for (const key of ['twr', 'benchmarkTwr', 'excessTwr']) {
      const metric = asRecord(metrics?.[key]);
      const status = str(metric?.status);
      if (status !== undefined && status !== 'available') degraded.push(`${key}:${status}`);
    }
    const coverage = asRecord(latest?.coverage);
    const coverageStatus = str(coverage?.status);
    if (coverageStatus !== undefined && coverageStatus !== 'complete')
      degraded.push(`coverage:${coverageStatus}`);
    const assessment =
      degraded.length === 0
        ? ok
        : partial(
            `绩效指标未全部可用（${degraded.join('、')}）`,
            '先运行 get_account_performance 补齐估值日与基准日线',
          );
    return withAsOf(assessment, asDate(latest?.dataAsOf));
  },
  get_advice_stats: (data) => {
    const record = asRecord(data);
    const sampleStatus = str(record?.sampleStatus);
    if (sampleStatus === 'insufficient')
      return partial('命中率样本不足，未给出百分比', '累积更多已回填的建议结果后重试');
    return ok;
  },
  get_confidence_calibration: (data) => {
    const record = asRecord(data);
    const assessment =
      str(record?.sampleStatus) === 'insufficient'
        ? partial('校准样本不足，未给出百分比', '累积更多已回填的建议结果后重试')
        : ok;
    return withAsOf(assessment, asDate(record?.calibratedAt));
  },
  get_decision_loop_review: (data) => {
    const record = asRecord(data);
    const unknowns = asArray(record?.unknowns).length;
    const limitations = asArray(record?.limitations).length;
    const assessment =
      unknowns + limitations === 0
        ? ok
        : partial(
            `决策闭环有 ${String(unknowns)} 条未知与 ${String(limitations)} 条限制`,
            '按决策闭环里的 unknowns / limitations 逐条补齐事实',
          );
    return withAsOf(assessment, asDate(record?.dataAsOf));
  },
  get_ashare_sentiment: (data) => {
    const snapshot = asRecord(asRecord(data)?.snapshot);
    if (snapshot === null)
      return unavailable('情绪快照缺失', '先运行 get_ashare_sentiment 或检查情绪源可用性');
    return withAsOf(ok, asDate(snapshot.dataAsOf));
  },
  get_portfolio_risk: (data) => {
    const record = asRecord(data);
    const coverage = asRecord(record?.coverage);
    const coverageStatus = str(coverage?.status);
    const assessment =
      coverageStatus === undefined || coverageStatus === 'available'
        ? ok
        : partial(
            `组合风险覆盖不完整（${coverageStatus}）`,
            '先运行 batch_quote 刷新报价，或补齐已落库绩效快照',
          );
    return withAsOf(assessment, asDate(record?.dataAsOf));
  },
  get_market_data_status: (data) => {
    const datasets = asArray(asRecord(data)?.datasets);
    const degraded = datasets.filter((item) => {
      const record = asRecord(item);
      const freshness = str(record?.freshness);
      return freshness === 'unavailable' || freshness === 'stale';
    });
    return degraded.length === 0
      ? ok
      : partial(
          `${String(degraded.length)} 个数据集不新鲜或不可用`,
          '先运行对应的 sync / fetch 工具刷新数据集',
        );
  },
};

const assessOutput = (tool: PanelHealthTool): OutputAssessment => {
  const probe = OUTPUT_PROBES[tool.name];
  if (probe === undefined) return ok;
  try {
    return probe(tool.data);
  } catch {
    // 输出形状变化不应让面板 500；降级并点名「无法判定」。
    return partial(
      '无法从工具输出判定可用性（输出形状可能已变化）',
      '检查该工具的输出契约与 panel-health 的映射表是否一致',
    );
  }
};

/**
 * 汇总一个面板的健康状态。
 *
 * - 全部 `ok` 且无输出降级 → `available`
 * - **所有**参与工具都失败 → `unavailable`
 * - 其余（有失败或有降级）→ `partial`
 */
export const assessPanelHealth = (tools: readonly PanelHealthTool[]): PanelHealth => {
  const issues: PanelHealthIssue[] = [];
  const checkedTools = tools.map((tool) => tool.name);
  const observedAt: Date[] = [];
  let declaredMissing = 0;
  let failed = 0;

  for (const tool of tools) {
    if (!tool.ok) {
      failed += 1;
      const error = asRecord(tool.error);
      const kind = str(error?.kind) ?? 'unknown';
      issues.push({
        tool: tool.name,
        reason: 'tool-failed',
        detail: `工具调用失败（${kind}）`,
        remedy: '先确认该工具依赖的数据源与账户配置，再刷新面板',
      });
      continue;
    }
    const assessment = assessOutput(tool);
    if (assessment.declaresDataAsOf) {
      if (assessment.dataAsOf === undefined) declaredMissing += 1;
      else observedAt.push(assessment.dataAsOf);
    }
    if (assessment.status === 'available') continue;
    issues.push({
      tool: tool.name,
      reason: assessment.status === 'unavailable' ? 'output-unavailable' : 'output-partial',
      detail: assessment.detail ?? '工具输出未全部可用',
      remedy: assessment.remedy ?? '按该工具输出的缺口说明补齐数据后重试',
    });
  }

  if (declaredMissing > 0)
    issues.push({
      tool: 'panel',
      reason: 'missing-data-as-of',
      detail: `${String(declaredMissing)} 个工具的输出没有时点，无法给出面板级聚合时点`,
      remedy: '补齐该工具输出的 dataAsOf 字段；面板不拿请求时间顶替数据时间',
    });

  const status: PanelHealthStatus =
    tools.length > 0 && failed === tools.length
      ? 'unavailable'
      : issues.length > 0
        ? 'partial'
        : 'available';

  // 聚合时点取**最旧**：角标时间必须 ≤ 任何行内时间。
  const asOf =
    declaredMissing > 0 || observedAt.length === 0
      ? undefined
      : new Date(Math.min(...observedAt.map((date) => date.getTime()))).toISOString();

  return {
    status,
    ...(asOf === undefined ? {} : { asOf }),
    checkedTools,
    issues,
  };
};
