// dsh-luoome client 纯投影函数（不 import react，便于 Node/vitest 单测）。
//
// 只把宿主 /api/luoome/state 的 ToolResult 投影成展示模型：不重算业务数字、
// 不推断用户跟随、不把未知写成零。组件与 data.js 复用同一实现。

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// DSH 的 document base 包含反向代理挂载路径；前导 / 会越过 /dsh/ 等公网前缀。
export const PANEL_STATE_PATH = 'api/luoome/state';

/** 只携带固定面板/分区及页码，不携带工具或账户参数。 */
export const stateUrl = (panel, section = null, page = 1) =>
  `${PANEL_STATE_PATH}?panel=${encodeURIComponent(panel)}${section === null ? '' : `&section=${encodeURIComponent(section)}${section === 'watchlist' ? `&page=${page}` : ''}`}`;
export const stockDetailUrl = (stockId) =>
  `api/luoome/stock?stockId=${encodeURIComponent(stockId)}`;
export const stockHistoryUrl = (stockId) =>
  `api/luoome/stock/history?stockId=${encodeURIComponent(stockId)}`;
export const stockProfileUrl = (stockId) =>
  `api/luoome/stock/profile?stockId=${encodeURIComponent(stockId)}`;

export const watchlistOperationRequestFor = (watchlist) => ({
  watchlistId: watchlist?.id ?? null,
  prompt: [
    watchlist
      ? `请帮我管理关注列表「${watchlist.name}」（watchlistId=${watchlist.id}）。`
      : '请帮我整理关注列表；如需新建，请先和我确认关注方向。',
    '先用 list_watchlists / get_watchlist 读取现有列表、成员与来源，再提出增删、研究阶段和优先级的调整建议，并说明理由。',
    '需要写入时，通过 luoome_confirmed_operation 调用 create_watchlist、update_watchlist、archive_watchlist、add_watchlist_members、update_watchlist_member 或 archive_watchlist_member，逐次由我确认。',
    '移除手动关注只结束 manual 来源，保留策略、持仓和其他来源。同步列表不能直接手工添加成员；不要擅自修改其来源策略。',
    '本次仅管理关注，不开启定时任务、提醒或交易。',
  ].join('\n'),
});

/** 服务端给的交易时段；老服务端没有该字段时返回 null（客户端按未知处理）。 */
const sessionOf = (body) => {
  const session = body?.session;
  if (!isRecord(session) || typeof session.marketSession !== 'string') return null;
  return {
    marketSession: session.marketSession,
    nextSessionStart:
      typeof session.nextSessionStart === 'string' ? session.nextSessionStart : null,
  };
};

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
  const projectTool = (tool) => {
    if (!isRecord(tool)) return null;
    return tool.ok === true
      ? { ok: true, data: tool.data }
      : { ok: false, error: tool.error ?? { kind: 'unavailable' } };
  };
  if (Array.isArray(body.strategies)) {
    for (const item of body.strategies) {
      if (!isRecord(item) || typeof item.strategyId !== 'string') continue;
      strategies.push({
        strategyId: item.strategyId,
        workspace: projectTool(item.workspace),
        schedule: projectTool(item.schedule),
        subscriptions: projectTool(item.subscriptions),
        ...(isRecord(item.continuity) ? { continuity: item.continuity } : {}),
      });
    }
  }
  return {
    panel: typeof body.panel === 'string' ? body.panel : '',
    asOf: typeof body.asOf === 'string' ? body.asOf : null,
    results,
    strategies,
    configuration: isRecord(body.configuration) ? body.configuration : null,
    session: sessionOf(body),
    section: typeof body.section === 'string' ? body.section : null,
    watchlistPage: isRecord(body.watchlistPage) ? body.watchlistPage : null,
  };
};

/** 分区刷新失败保留同一范围的成功事实，同时单独保留当前错误。 */
export const mergeOverviewSection = (previous, next) => {
  const results = { ...previous.results };
  const errors = [];
  let succeeded = false;
  for (const [name, result] of Object.entries(next.results)) {
    if (result.ok) {
      results[name] = result;
      succeeded = true;
    } else {
      errors.push(result.error);
      if (!results[name]?.ok) results[name] = result;
    }
  }
  return {
    ...previous,
    results,
    session: next.session,
    loading: false,
    error: errors[0] ?? null,
    loadedAt: succeeded ? next.asOf : previous.loadedAt,
    watchlistPage: succeeded ? next.watchlistPage : previous.watchlistPage,
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

export const strategyPartOf = (state, strategyId, part) =>
  state?.strategies?.find((item) => item.strategyId === strategyId)?.[part] ?? null;

export const strategyPartDataOf = (state, strategyId, part) => {
  const result = strategyPartOf(state, strategyId, part);
  return result && result.ok === true ? result.data : null;
};

export const strategyPartErrorOf = (state, strategyId, part) => {
  const result = strategyPartOf(state, strategyId, part);
  return result && result.ok !== true ? (result.error ?? { kind: 'unavailable' }) : null;
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

/** 页面文本用可读名称替换内部引用；原始标识仍保留在工具数据与调用参数中。 */
export const strategyText = (value, references = []) => {
  let text = typeof value === 'string' ? value : '';
  for (const { id, label } of [...references].sort((a, b) => b.id.length - a.id.length)) {
    if (id && id !== label) text = text.split(id).join(label);
  }
  return text
    .replace(
      /\b(?:strategy|version|run|signal|fact|observation)[-_:][a-zA-Z0-9_.:-]+\b/g,
      '相关记录',
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '相关记录')
    .replace(/\b[0-9a-f]{64}\b/gi, '校验记录');
};

const STRATEGY_FIELDS = {
  'quote.open': '开盘价',
  'quote.high': '最高价',
  'quote.low': '最低价',
  'quote.close': '收盘价',
  'quote.prevClose': '昨收价',
  'quote.volume': '成交量',
  'indicators.close': '收盘价',
  'indicators.ma5': '5 日均线',
  'indicators.ma10': '10 日均线',
  'indicators.ma20': '20 日均线',
  'indicators.ma60': '60 日均线',
  'indicators.momentum20Pct': '20 日动量（%）',
  'indicators.maDistance20Pct': '20 日均线乖离（%）',
  'indicators.maDistance60Pct': '60 日均线乖离（%）',
  'indicators.daysSinceMa20CrossUp': '上穿 20 日均线后交易日数',
  'indicators.daysSinceMa60CrossUp': '上穿 60 日均线后交易日数',
  'indicators.daysAboveMa20': '站上 20 日均线天数',
  'indicators.rsi14': '14 日 RSI',
  'indicators.macdDif': 'MACD DIF',
  'indicators.macdDea': 'MACD DEA',
  'indicators.macdHist': 'MACD 柱值',
  'indicators.volMa5': '5 日均量',
  'indicators.volMa20': '20 日均量',
  'indicators.volRatio5_20': '5 / 20 日量比',
  'indicators.high20': '20 日最高价',
  'indicators.low20': '20 日最低价',
  'indicators.bollMiddle20': '布林中轨',
  'indicators.bollUpper20': '布林上轨',
  'indicators.bollLower20': '布林下轨',
  'indicators.bollBandwidth20Pct': '布林带宽（%）',
  'indicators.bollPosition20': '布林位置',
  'meta.recentLimitUp': '近期涨停',
  'meta.daysSinceLimitUp': '距涨停交易日数',
  'meta.priceUp': '价格上涨',
  'meta.sectorAvgChange3d': '行业 3 日平均涨幅（比率）',
  'meta.stockChange3d': '个股 3 日涨幅（比率）',
  'meta.limitUpLevel': '连板数',
  'meta.limitUpToday': '今日涨停',
};

/** 只翻译字段与运算符，保留阈值、括号与运算顺序，不执行或解释规则。 */
export const strategyExpression = (value) =>
  strategyText(value)
    .replace(
      /\$\{([a-zA-Z][\w.]*)\}|\b(?:quote|indicators|meta)\.[a-zA-Z0-9_]+\b/g,
      (match, path) => STRATEGY_FIELDS[path ?? match] ?? match,
    )
    .replace(/&&/g, ' 且 ')
    .replace(/\|\|/g, ' 或 ')
    .replace(/>=/g, '≥')
    .replace(/<=/g, '≤');

/** 标识留在结构化请求里；可见草稿通过名称、版本和事实时间定位，不展示内部标识。 */
export const researchRequestFor = (strategyId, runId = null, context = {}) => {
  if (!strategyId)
    return {
      strategyId: null,
      runId: null,
      prompt:
        '我想开始一项个人策略研究。先读取现有账户、策略目录、字段目录和数据状态，帮助我提出一个可被反证的小问题，并选择已有策略或起草个人策略。不要创建示例投资资产、启用自动任务或通知。创建版本、保存研究、试跑和历史验证按我的明确意图直接执行；数据缺失如实说明，不把观察收益当回测。',
    };
  const prompt = `请研究${context.strategyName ? `策略“${strategyText(context.strategyName)}”` : '所选策略'}${context.version ? `（第 ${context.version} 版）` : ''}${runId ? `的已发布匹配结果${context.dataAsOf ? `，事实时间 ${context.dataAsOf}` : ''}` : ''}。先按名称查询策略并核对版本和运行事实；存在同名或版本不符时先核对，不要猜测。给出结论、证据、反证、风险与有效期，用可读名称说明来源。不要自动发布或修改策略，只有在我明确提出写入意图时才执行。`;
  if (!context.baseVersionId) return { strategyId, runId: runId ?? null, prompt };
  const researchContext = {
    accountId: context.accountId,
    strategyId,
    runId: runId ?? undefined,
    baseVersionId: context.baseVersionId,
    candidateVersionId: context.candidateVersionId || undefined,
    researchRevision: context.researchRevision,
    trainingSessionId: context.trainingSessionId || undefined,
    validationSessionId: context.validationSessionId || undefined,
    stockIds: context.stockIds,
    from: context.from || undefined,
    to: context.to || undefined,
    benchmarkStockId: context.benchmarkStockId || undefined,
  };
  return {
    strategyId,
    runId: runId ?? null,
    researchContext,
    prompt: `请继续策略“${strategyText(context.strategyName) || '所选策略'}”的研究工作台。给出结论、证据、反证、风险与有效期。只有在我明确提出写入意图时才直接执行。\n\n当前研究问题：${context.question || '尚未填写，先帮助我缩小到一个可反证的问题。'}\n本次意图：${context.intent || '继续当前研究'}\n基线：第 ${context.baseVersion} 版；候选：${context.candidateVersion ? `第 ${context.candidateVersion} 版` : '尚未保存'}。${runId ? `当前正式匹配来自第 ${context.runVersion ?? '待核对'} 版，事实时间 ${context.dataAsOf ?? '待核对'}，与候选试跑分开。` : ''}\n下一步：${context.nextStep || '待确定'}。\n请读取当前账户的已保存研究并核对修订；页面上下文若尚未保存，只作为我的研究草稿。刷新或跨日继续时保留上述版本，不自动替换为最新发布版本。分别说明同快照试跑、历史选股评估、严格组合回测与真实信号观察，缺失数据不计为零。\n研究绑定（仅用于精确读取与操作参数）：${JSON.stringify(researchContext)}${context.definition ? `\n尚未保存的候选规则：${JSON.stringify(context.definition)}` : ''}`,
  };
};

export const strategyOperationRequestFor = (strategyId, context = {}) => ({
  strategyId,
  prompt: `请管理${context.strategyName ? `策略“${strategyText(context.strategyName)}”` : '所选策略'}的持续运行。先按名称核对策略，读取 StrategySchedule、最近运行和 Watchlist 订阅，告诉我当前是已发布未上线、已启用还是已暂停。说明 StrategySchedule 只决定到期，必须由 DSH 定时任务执行 run_strategy_daily_cycle 才会真正运行。不要直接调用 run_strategy，不要自动创建重复日程或自动发布；只有在我明确提出调度、暂停、恢复、订阅或任务授权意图时才直接执行。`,
});

export const stockResearchRequestFor = (context) =>
  context.watchlistId
    ? {
        stockId: context.stockId,
        watchlistId: context.watchlistId,
        prompt: `请分析${strategyText(context.stockName) || '这只股票'}（${context.stockId}）。该股来自关注列表「${strategyText(context.watchlistName)}」（watchlistId=${context.watchlistId}）。先通过 get_watchlist 核对当前成员、关注理由和来源，再读取最新可用行情与相关事实；区分关注理由与当前行情，明确数据缺口、证据、反证、风险与有效期。关注不代表买入建议。只有在我明确提出保存或调整意图时才直接执行。`,
      }
    : context.sourceKind === 'overview'
      ? {
          stockId: context.stockId,
          prompt: `请分析${strategyText(context.stockName)}（${context.stockId}）。该股来自看盘页的${strategyText(context.sourceLabel)}。先读取当前账户可见的相关事实与最新可用行情，核对数据来源和时点；缺失或过期数据请明确说明。给出结论、证据、反证、风险与有效期。关注和持仓不代表买入建议。如果我明确要求保存建议、修改关注或其他写入，直接执行并回显结果；缺少必要参数时才追问。`,
        }
      : context.sourceKind
        ? {
            stockId: context.stockId,
            strategyId: context.strategyId,
            runId: context.runId,
            prompt: `请分析${strategyText(context.stockName)}（${context.stockId}）的选股诊断。来源是策略“${strategyText(context.strategyName)}”第 ${context.version} 版的${context.sourceKind === 'trial' ? '本次内存试跑，运行未持久化' : '正式运行'}，事实时间 ${context.dataAsOf}，结果为${context.selected ? '入选' : '未入选或数据不完整，逐条核对事实'}。以下原始规则求值属于该次固定事实，不是当前行情；核对输入、阈值与评分贡献后再读取最新可用行情。内存试跑不能当已发布结果或历史收益。\n诊断事实：${JSON.stringify({ ruleEvaluations: context.ruleEvaluations, scoringBreakdown: context.scoringBreakdown })}\n请给出证据、反证、数据缺口、风险与有效期，不把规则评分当成功概率。只在对话中研究，只有在我明确提出保存、策略修改或建议写回意图时才直接执行。`,
          }
        : {
            stockId: context.stockId,
            strategyId: context.strategyId,
            runId: context.runId,
            prompt: `请分析${strategyText(context.stockName)}（${context.stockId}）。该股来自策略“${strategyText(context.strategyName)}”第 ${context.version} 版的已发布匹配结果，匹配事实时间 ${context.dataAsOf}。先按名称、版本和事实时间核对策略及这只股票的匹配依据，再读取这只股票的最新可用行情与相关事实；区分历史匹配结果与当前行情，缺失或过期数据请明确说明。给出结论、证据、反证、风险与有效期，用可读名称说明来源。匹配与规则评分不代表买入建议或成功概率。只在对话中分析；只有在我明确提出保存建议、修改策略或其他写入意图时才直接执行。`,
          };
