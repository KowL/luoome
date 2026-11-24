/* apps/web/public/js/stock-brief.js —— 每日个股观察（StockBrief）前端展示与反馈。
 *
 * 数据只来自 P2-1 的只读接口 GET /api/stock-briefs、/api/stock-briefs/today 与
 * 唯一写入口 POST /api/stock-briefs/generate；本文件不重新映射 decision 文案，
 * 一律用后端 StockBriefView 的 wording / evidence / missing / disclaimer。
 *
 * 纯函数（信号 chip 模型、覆盖计数、刷新提示、冷却判定）与 DOM 渲染分开，
 * 便于在 bun:test 里用假 DOM 断言渲染输出。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { el, resultErrorText } from './ui.js';

/** 与 toolkit `BRIEF_DISCLAIMER` 同一段文字（前端无包依赖，保持逐字一致）。 */
const BRIEF_DISCLAIMER = '本内容仅技术研究，不构成投资建议；投资有风险，决策需自行承担。';

const CONFIDENCE_NOTE = 'confidence 是主观信心度，不是收益概率。';

/** 与 toolkit `STOCK_BRIEF_MISSING_LABELS` 同口径；未知维度原样展示。 */
const DIMENSION_LABELS = {
  quote: '行情报价',
  'daily-bars': '日线',
  intraday: '分时',
  news: '新闻',
  'sector-quote': '板块行情',
  'sector-membership': '板块归属',
  signals: '策略信号',
  account: '账户事实',
  llm: 'AI 分析',
  plugin: '个股分析插件',
  budget: 'AI 预算',
};

const DECISION_CLASSES = {
  偏多信号: 'badge-buy',
  偏空信号: 'badge-sell',
  中性观察: 'badge-hold',
  待确认观察: 'badge-watch',
  回避观察: 'badge-avoid',
};

const HORIZON_LABELS = {
  intraday: '盘中',
  short: '短期',
  medium: '中期',
  long: '长期',
};

const REFRESH_STORAGE_KEY = 'luoome.stockBrief.manualRefresh';
const SHANGHAI = 'Asia/Shanghai';
const SHANGHAI_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const shanghaiParts = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(
    SHANGHAI_FORMAT.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

/** Asia/Shanghai 交易日（YYYY-MM-DD）；手动刷新冷却按它分日。 */
const briefDateKey = (value = new Date()) => {
  const parts = shanghaiParts(value);
  return parts === null ? '' : parts.slice(0, 10);
};

const briefDataAsOfText = (value) => `数据时间 ${shanghaiParts(value) ?? '缺失'}`;

const briefValidUntilText = (value) => `有效期至 ${shanghaiParts(value) ?? '未知'}`;

const briefConfidenceBand = (confidence) => {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  if (confidence >= 70) return '较高';
  if (confidence >= 50) return '中';
  return '低';
};

const briefConfidenceText = (confidence) => {
  const band = briefConfidenceBand(confidence);
  if (band === null) return '信心度缺失';
  return `信心度 ${Math.round(confidence)}（${band}）`;
};

const briefHorizonText = (horizon) => {
  if (typeof horizon !== 'string' || horizon.length === 0) return '周期未知';
  return `周期 ${HORIZON_LABELS[horizon] ?? horizon}`;
};

const briefDimensionLabel = (dimension) => DIMENSION_LABELS[dimension] ?? dimension;

/** 信号 chip 模型：label / 是否规则观察 / confidence / 数据时间 / 缺失数。 */
const briefChipModel = (view) => {
  const label = typeof view?.wording?.label === 'string' ? view.wording.label : '暂无观察';
  const quality = typeof view?.quality === 'string' ? view.quality : '';
  const empty = quality === '' || quality === 'unavailable' || label === '暂无观察';
  const isRuleOnly =
    view?.isRuleOnly === true || quality === 'rule-only' || label.startsWith('规则观察');
  return {
    label,
    empty,
    isRuleOnly,
    className: empty
      ? 'badge-neutral'
      : isRuleOnly
        ? 'badge-warn'
        : (DECISION_CLASSES[label] ?? 'badge-neutral'),
    confidence: typeof view?.confidence === 'number' ? view.confidence : null,
    confidenceText: briefConfidenceText(view?.confidence),
    timeText: briefDataAsOfText(view?.dataAsOf),
    missingCount: Array.isArray(view?.missing) ? view.missing.length : 0,
  };
};

/** 缺失维度 → 可展开行；原因原样展示，不压缩成「未知」。 */
const briefMissingRows = (view) =>
  (Array.isArray(view?.missing) ? view.missing : []).map((item) => ({
    dimension: item.dimension,
    label: briefDimensionLabel(item.dimension),
    reason: item.reason,
  }));

/** 证据行：数值为空即缺失，保留来源与数据时间。 */
const briefEvidenceRows = (view) =>
  (Array.isArray(view?.evidence) ? view.evidence : []).map((row) => ({
    label: row.label,
    value: row.missing === true ? '缺失' : (row.value ?? '缺失'),
    source: row.source ?? '未知来源',
    dataAsOfText: briefDataAsOfText(row.dataAsOf),
    missing: row.missing === true,
    reason: row.reason ?? null,
  }));

/** 首页 Top N：按 confidence 降序；规则观察可上榜但带规则标记，未覆盖不冒充结论。 */
const todayBriefModel = (list, options = {}) => {
  const limit = options.limit ?? 5;
  const items = Array.isArray(list?.items) ? list.items : [];
  const byQuality = (quality) => items.filter((item) => item.quality === quality);
  const concludedItems = items.filter(
    (item) => item.quality === 'ai' || item.quality === 'partial',
  );
  const ruleOnlyItems = byQuality('rule-only');
  const uncoveredItems = byQuality('unavailable');
  const top = [...concludedItems, ...ruleOnlyItems]
    .sort((left, right) => {
      const leftConfidence = typeof left.confidence === 'number' ? left.confidence : -1;
      const rightConfidence = typeof right.confidence === 'number' ? right.confidence : -1;
      if (rightConfidence !== leftConfidence) return rightConfidence - leftConfidence;
      return String(left.stockId).localeCompare(String(right.stockId));
    })
    .slice(0, limit)
    .map((item) => {
      const chip = briefChipModel(item);
      return {
        stockId: item.stockId,
        stockName: item.stockName ?? item.stockId,
        href: `#market?stockId=${encodeURIComponent(item.stockId)}`,
        label: chip.label,
        className: chip.className,
        isRuleOnly: chip.isRuleOnly,
        confidenceText: chip.confidenceText,
        timeText: chip.timeText,
        missingCount: chip.missingCount,
      };
    });
  const missingReasons = [
    ...new Set(
      items.flatMap((item) =>
        (Array.isArray(item.missing) ? item.missing : []).map(
          (entry) => `${briefDimensionLabel(entry.dimension)}：${entry.reason}`,
        ),
      ),
    ),
  ];
  return {
    date: list?.date ?? '',
    counts: {
      concluded: concludedItems.length,
      ruleOnly: ruleOnlyItems.length,
      uncovered: uncoveredItems.length,
    },
    total: items.length,
    top,
    missingReasons,
    degradation: list?.degradation ?? null,
    budget: list?.budget ?? null,
    disclaimer: BRIEF_DISCLAIMER,
  };
};

/** 预算一句话；缺失返回 null。 */
const briefBudgetText = (budget) => {
  if (budget === undefined || budget === null) return null;
  const limit = budget.limit ?? {};
  const calls = `${budget.httpCalls ?? 0}/${limit.maxHttpCalls ?? '--'}`;
  const tokens = `${budget.tokens ?? 0}/${limit.maxTokens ?? '--'}`;
  return `今日 AI 用量 ${calls} 次 · ${tokens} token`;
};

/**
 * 生成结果 → 用户提示（403 / 429 / 成功 / 跳过各有明确文案）。
 * @returns {{tone: 'ok'|'warn'|'info'|'error', message: string}}
 */
const briefGenerateFeedback = (result) => {
  if (result === undefined || result === null || result.ok !== true) {
    const kind = result?.error?.kind;
    if (kind === 'permission_denied') {
      return {
        tone: 'error',
        message: `未开启生成能力：${resultErrorText(result, '当前操作未开启')}`,
      };
    }
    return { tone: 'error', message: `刷新失败：${resultErrorText(result, '未知错误')}` };
  }
  const data = result.data ?? {};
  const budgetText = briefBudgetText(data.budget);
  const suffix = budgetText === null ? '' : `；${budgetText}`;
  if (data.degradation?.reason === 'rate_limited') {
    return {
      tone: 'warn',
      message: `今日 AI 分析额度已用完，规则观察仍可用${suffix}。`,
    };
  }
  const items = Array.isArray(data.items) ? data.items : [];
  const count = (action) => items.filter((item) => item.action === action).length;
  const llm = count('llm');
  const ruleOnly = count('rule-only');
  const unavailable = count('unavailable');
  const skipped = count('skip');
  const budgetStopped = count('budget-stopped');
  if (items.length === 0) {
    return {
      tone: 'warn',
      message: `今日没有可生成的观察候选${suffix}。`,
    };
  }
  if (llm === 0 && ruleOnly === 0 && unavailable === 0) {
    return {
      tone: 'ok',
      message: `今日已刷新：无新事实，未重复调用 AI（跳过 ${skipped + budgetStopped} 只）${suffix}。`,
    };
  }
  const parts = [
    ...(llm > 0 ? [`AI 结论 ${llm}`] : []),
    ...(ruleOnly > 0 ? [`规则观察 ${ruleOnly}`] : []),
    ...(unavailable > 0 ? [`不可用 ${unavailable}`] : []),
    ...(skipped > 0 ? [`跳过 ${skipped}`] : []),
    ...(budgetStopped > 0 ? [`预算停止 ${budgetStopped}`] : []),
  ];
  return { tone: 'ok', message: `已更新 ${items.length} 只：${parts.join(' · ')}${suffix}。` };
};

/* ---- 手动刷新冷却（每票 / 每列表每日默认 1 次，仅前端防误触） ---- */

const manualRefreshKey = (scope, id) => `${scope}:${id}`;

const manualRefreshRecord = (date, now = new Date()) => ({
  date,
  at: now.toISOString(),
});

const manualRefreshAllowed = (stored, date) =>
  stored === null || stored === undefined || stored.date !== date;

const readManualRefresh = (scope, id) => {
  try {
    const raw = localStorage.getItem(REFRESH_STORAGE_KEY);
    const parsed = raw === null ? {} : JSON.parse(raw);
    const entry = parsed?.[manualRefreshKey(scope, id)];
    return typeof entry?.date === 'string' ? entry : null;
  } catch {
    return null;
  }
};

const writeManualRefresh = (scope, id, record) => {
  try {
    const raw = localStorage.getItem(REFRESH_STORAGE_KEY);
    const parsed = raw === null ? {} : JSON.parse(raw);
    localStorage.setItem(
      REFRESH_STORAGE_KEY,
      JSON.stringify({ ...(parsed ?? {}), [manualRefreshKey(scope, id)]: record }),
    );
  } catch {
    /* 隐私模式 / quota：冷却退化为不拦截 */
  }
};

/* ---- DOM 渲染 ---- */

const briefChipNode = (view) => {
  const model = briefChipModel(view);
  return el('span', `badge ${model.className} stock-brief-chip`, model.label);
};

const briefMissingDetailsNode = (view) => {
  const rows = briefMissingRows(view);
  if (rows.length === 0) return null;
  return el('details', 'stock-brief-missing', [
    el('summary', null, `缺失 ${rows.length} 项`),
    el(
      'ul',
      'stock-brief-missing-list',
      rows.map((row) => el('li', null, `${row.label}：${row.reason}`)),
    ),
  ]);
};

/** 关注列表 / 作战室行内观察单元：chip + 信心度 + 更新时间 + 可展开缺失原因。 */
const briefCellNode = (view, options = {}) => {
  const model = briefChipModel(view);
  const chip = briefChipNode(view);
  const head =
    options.href === undefined || model.empty
      ? chip
      : (() => {
          const link = el('a', 'stock-brief-chip-link', chip);
          link.href = options.href;
          link.title = `查看 ${view?.stockId ?? ''} 行情`;
          return link;
        })();
  return el('div', model.empty ? 'stock-brief-cell is-empty' : 'stock-brief-cell', [
    head,
    el(
      'span',
      'stock-brief-meta',
      model.empty ? '暂无观察' : `${model.confidenceText} · ${model.timeText}`,
    ),
    briefMissingDetailsNode(view),
  ]);
};

const briefEvidenceTableNode = (view) => {
  const rows = briefEvidenceRows(view);
  if (rows.length === 0) return null;
  return el('div', 'stock-brief-evidence', [
    el('h3', null, '证据'),
    el('table', 'table stock-brief-evidence-table', [
      el(
        'thead',
        null,
        el(
          'tr',
          null,
          ['证据', '数值', '来源', '数据时间'].map((label) => el('th', null, label)),
        ),
      ),
      el(
        'tbody',
        null,
        rows.map((row) =>
          el(
            'tr',
            row.missing ? 'stock-brief-evidence-row is-missing' : 'stock-brief-evidence-row',
            [
              el('td', null, row.label),
              el('td', 'num', row.value),
              el(
                'td',
                null,
                row.missing && row.reason !== null ? `${row.source} · ${row.reason}` : row.source,
              ),
              el('td', 'mono', row.dataAsOfText),
            ],
          ),
        ),
      ),
    ]),
  ]);
};

const listNode = (title, lines) =>
  lines.length === 0
    ? null
    : el('div', 'stock-brief-list-block', [
        el('h3', null, title),
        el(
          'ul',
          'stock-brief-list',
          lines.map((line) => el('li', null, line)),
        ),
      ]);

/** 个股详情卡主体（由 market.js 挂到 #market-brief-card 内）。 */
const stockBriefCardNode = (view) => {
  const model = briefChipModel(view);
  const warnings = Array.isArray(view?.warnings) ? view.warnings : [];
  const counterEvidence = Array.isArray(view?.counterEvidence) ? view.counterEvidence : [];
  const risks = Array.isArray(view?.risks) ? view.risks : [];
  // 无记录 / 不可用：只显示「暂无观察」与免责，不摆出空信心度与空有效期。
  const hasConclusion = !model.empty;
  return el('div', model.empty ? 'stock-brief-body is-empty' : 'stock-brief-body', [
    el('div', 'stock-brief-head', [
      briefChipNode(view),
      ...(hasConclusion
        ? [
            el('span', 'stock-brief-meta', model.confidenceText),
            el('span', 'stock-brief-meta', briefHorizonText(view?.horizon)),
            el('span', 'stock-brief-meta', model.timeText),
            el('span', 'stock-brief-meta', briefValidUntilText(view?.validUntil)),
          ]
        : []),
    ]),
    el('p', 'stock-brief-detail', view?.wording?.detail ?? '当前没有该标的的观察记录。'),
    hasConclusion ? el('p', 'stock-brief-confidence-note', CONFIDENCE_NOTE) : null,
    view?.premise === undefined
      ? null
      : el('p', 'stock-brief-premise', [el('strong', null, '核心论点：'), view.premise]),
    briefEvidenceTableNode(view),
    listNode('反证', counterEvidence),
    listNode('风险', risks),
    briefMissingDetailsNode(view),
    warnings.length === 0
      ? null
      : el('div', 'stock-brief-warnings', [
          el('h3', null, '提示'),
          el(
            'ul',
            null,
            warnings.map((warning) => el('li', null, warning)),
          ),
        ]),
    el('p', 'stock-brief-disclaimer', view?.disclaimer ?? BRIEF_DISCLAIMER),
  ]);
};

const todayBriefRowNode = (row) => {
  const link = el('a', 'stock-brief-row', [
    el('span', `badge ${row.className}`, row.label),
    el('strong', null, row.stockName),
    el('span', 'mono muted', row.stockId),
    el('span', 'stock-brief-meta', row.confidenceText),
    el('span', 'stock-brief-meta', row.timeText),
    row.missingCount > 0 ? el('span', 'stock-brief-meta', `缺失 ${row.missingCount} 项`) : null,
  ]);
  link.href = row.href;
  return link;
};

/** 首页「今日个股观察」区块主体；数据失败时由调用方换成一条降级提示。 */
const todayBriefNodes = (list, options = {}) => {
  const model = todayBriefModel(list, options);
  const coverage = `交易 ${model.date || '--'} · 有结论 ${model.counts.concluded} · 规则观察 ${model.counts.ruleOnly} · 未覆盖 ${model.counts.uncovered}`;
  const missingLines = [
    ...model.missingReasons,
    ...(model.degradation === null || model.degradation === undefined
      ? []
      : [model.degradation.message]),
  ];
  return [
    el('p', 'stock-brief-coverage', coverage),
    model.top.length === 0
      ? el('p', 'placeholder', '今日暂无个股观察；本区块不会触发生成。')
      : el('div', 'stock-brief-top', model.top.map(todayBriefRowNode)),
    missingLines.length === 0
      ? null
      : el('div', 'stock-brief-missing-summary', [
          el('h3', null, '未覆盖 / 缺失原因'),
          el(
            'ul',
            null,
            missingLines.map((line) => el('li', null, line)),
          ),
        ]),
    briefBudgetText(model.budget) === null
      ? null
      : el('p', 'stock-brief-meta', briefBudgetText(model.budget)),
    el('p', 'stock-brief-disclaimer', model.disclaimer),
  ];
};

export {
  BRIEF_DISCLAIMER,
  briefBudgetText,
  briefCellNode,
  briefChipModel,
  briefChipNode,
  briefConfidenceBand,
  briefConfidenceText,
  briefDataAsOfText,
  briefDateKey,
  briefDimensionLabel,
  briefEvidenceRows,
  briefGenerateFeedback,
  briefHorizonText,
  briefMissingDetailsNode,
  briefMissingRows,
  briefValidUntilText,
  CONFIDENCE_NOTE,
  manualRefreshAllowed,
  manualRefreshKey,
  manualRefreshRecord,
  readManualRefresh,
  stockBriefCardNode,
  todayBriefModel,
  todayBriefNodes,
  writeManualRefresh,
};
