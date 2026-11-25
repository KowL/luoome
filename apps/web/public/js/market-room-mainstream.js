/* apps/web/public/js/market-room-mainstream.js —— 作战室「主流题材 · 短线核心股」。
 *
 * - 父板块由固定定义给出，所有父板块无论涨跌都展示；标准题材不因 topN 消失；
 * - 题材行情、核心股与全部成分来自 GET /api/market/room/mainstream（core 计算），
 *   页面只排序与展示，不另算一套口径；
 * - 默认每张题材卡只显示 1 只代表股（日涨幅第一的领涨股）；点击卡片内联展开最多 5 只核心股，
 *   全部成分按需展开，不默认铺开 44 × 5；
 * - 核心股 / 成分股点击打开作战室内弹窗，不跳 #market 页面；1 分钟序列只读本地已发布批次；
 * - theme / stock / sort / dir / window / at 全部写进 hash，刷新、前进后退可恢复；
 * - 缺失一律显示原因，不补 0；占比只使用可核验成交额增量，不叫主力净流入。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { replayAtFromHash, replayHashSuffix, replayQuerySuffix } from './market-room-replay.js';
import { sectorDetailHash } from './market-room-sector-detail.js';
import { formatAmount, formatClock, formatPct } from './market-shared.js';
import { closeModal, openModal } from './modal.js';
import { $, el } from './ui.js';

const SORTS = ['day', 'window5', 'window15', 'amount'];
const SORT_LABELS = {
  day: '日涨幅',
  window5: '5 分钟',
  window15: '15 分钟',
  amount: '成交占比',
};
const WINDOWS = ['w5', 'w15'];
const WINDOW_LABELS = { w5: '5 分钟', w15: '15 分钟' };
const DIRECTIONS = ['up', 'down'];
const DIRECTION_LABELS = { up: '领涨', down: '领跌' };

const CONSTITUENT_SORTS = ['window15AmountDelta', 'day', 'window15', 'todayAmount', 'share'];
const CONSTITUENT_SORT_LABELS = {
  window15AmountDelta: '15 分钟增量',
  day: '日涨幅',
  window15: '15 分钟涨幅',
  todayAmount: '今日成交额',
  share: '题材内占比',
};

const ROLE_LABELS = { leader: '领涨', funds: '资金', height: '高度' };
const ROLE_ORDER = ['leader', 'funds', 'height'];

const EMPTY_TEXTS = {
  no_batch: '尚无已发布的盘中批次',
  pre_open: '盘前尚无当日批次，不展示盘前数据',
  non_trading_day: '非交易日，不展示当日盘面数据',
  no_today_batch: '今日尚无已发布批次',
  no_sector_catalog: '概念目录尚未同步',
  no_members: '目录里没有带 active 成分的概念',
};

const pick = (params, key, allowed, fallback) => {
  const value = params.get(key);
  return value !== null && allowed.includes(value) ? value : fallback;
};

const textParam = (params, key) => {
  const value = params.get(key);
  return value === null || value.trim() === '' ? null : value.trim();
};

/** 主流题材地图的深链接参数（#market-room?tab=overview&sort=day&dir=up&window=w15&theme=...&stock=...&at=...）。 */
export const mainstreamParamsFromHash = (hash = window.location.hash) => {
  const params = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '');
  return {
    sort: pick(params, 'sort', SORTS, 'day'),
    window: pick(params, 'window', WINDOWS, 'w15'),
    dir: pick(params, 'dir', DIRECTIONS, 'up'),
    theme: textParam(params, 'theme'),
    stock: textParam(params, 'stock'),
    at: replayAtFromHash(hash),
  };
};

/** 请求路径：amount 是前端排序口径，接口只接受 day / window5 / window15。 */
export const mainstreamQuery = (params) =>
  `?sort=${encodeURIComponent(params.sort === 'amount' ? 'day' : params.sort)}&window=${encodeURIComponent(
    params.window,
  )}${replayQuerySuffix(params.at)}`;

/** 深链接：切换排序 / 方向 / 窗口 / 展开题材 / 弹窗股票时只改 hash，保留同一个回放时点。 */
export const mainstreamHash = (params) => {
  const query = [
    'tab=overview',
    `sort=${encodeURIComponent(params.sort)}`,
    `dir=${encodeURIComponent(params.dir)}`,
    `window=${encodeURIComponent(params.window)}`,
  ];
  if (typeof params.theme === 'string' && params.theme.length > 0) {
    query.push(`theme=${encodeURIComponent(params.theme)}`);
  }
  if (typeof params.stock === 'string' && params.stock.length > 0) {
    query.push(`stock=${encodeURIComponent(params.stock)}`);
  }
  return `market-room?${query.join('&')}${replayHashSuffix(params.at)}`;
};

export const mainstreamThemeHash = (params, themeId) =>
  mainstreamHash({ ...params, theme: themeId });
export const mainstreamStockHash = (params, stockId) =>
  mainstreamHash({ ...params, stock: stockId });
export const mainstreamHashWithoutTheme = (params) => mainstreamHash({ ...params, theme: null });
export const mainstreamHashWithoutStock = (params) => mainstreamHash({ ...params, stock: null });

const metricValue = (row, sort) => {
  if (sort === 'amount') return row.turnover?.value ?? null;
  return row[sort]?.value ?? null;
};

/** 题材排序（纯函数）：领涨降序、领跌升序；缺失恒排最后，不参与方向反转。 */
export const sortMainstreamThemes = (themes, sort, dir = 'up') => {
  const sortKey = SORTS.includes(sort) ? sort : 'day';
  const direction = sortKey === 'amount' || dir === 'up' ? 'desc' : 'asc';
  return [...themes].sort((left, right) => {
    const leftValue = metricValue(left, sortKey);
    const rightValue = metricValue(right, sortKey);
    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return direction === 'desc' ? rightValue - leftValue : leftValue - rightValue;
  });
};

const constituentValue = (row, sort) => {
  if (sort === 'day') return row.dayChangePct;
  if (sort === 'window15') return row.window15ChangePct;
  if (sort === 'todayAmount') return row.todayAmount;
  if (sort === 'share') return row.sharePct;
  return row.window15AmountDelta;
};

/** 全部成分排序（纯函数）：默认近 15 分钟成交额增量降序，缺失恒最后。 */
export const sortConstituents = (rows, sort = 'window15AmountDelta') => {
  const key = CONSTITUENT_SORTS.includes(sort) ? sort : 'window15AmountDelta';
  return [...rows].sort((left, right) => {
    const leftValue = constituentValue(left, key);
    const rightValue = constituentValue(right, key);
    if (leftValue === null && rightValue === null) return left.code.localeCompare(right.code);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    if (rightValue !== leftValue) return rightValue - leftValue;
    return left.code.localeCompare(right.code);
  });
};

/** ST 默认隐藏，开关只影响全部成分表；核心股永远不含 ST。 */
export const visibleConstituents = (rows, showSt = false) =>
  showSt ? [...rows] : rows.filter((row) => !row.isSt);

/** 与上一份结果相比新进入核心股名单的 stockId（首次加载不标新进）。 */
export const newCoreStockIds = (previousIds, coreStocks) => {
  if (previousIds === null || previousIds === undefined) return [];
  return coreStocks.map((row) => row.stockId).filter((stockId) => !previousIds.has(stockId));
};

/** 空态文案；ready 返回 null。 */
export const mainstreamEmptyText = (map) => {
  if (map?.state !== 'empty') return null;
  const base = EMPTY_TEXTS[map.emptyReason] ?? '暂无主流题材数据';
  const anchor = map.anchor;
  return anchor === null || anchor === undefined
    ? base
    : `${base} · 最近批次 ${anchor.tradingDate} ${formatClock(anchor.sampledAt)}`;
};

/** 页头口径：交易日 / 时点 / 分类版本 / 排序。 */
export const mainstreamMetaText = (map, params = mainstreamParamsFromHash()) => {
  if (map === undefined || map === null) return '主流题材地图 · 刷新失败，保留上次成功结果';
  if (map.state === 'empty') return `主流题材地图 · ${mainstreamEmptyText(map)}`;
  const sampledAt = map.anchor === null ? '--' : formatClock(map.anchor.sampledAt);
  return `主流题材地图 · 交易日 ${map.tradingDate} · 数据时点 ${sampledAt} · 分类版本 ${map.ruleVersion} · 按${SORT_LABELS[params.sort] ?? params.sort}${params.sort === 'amount' ? '' : `（${DIRECTION_LABELS[params.dir] ?? params.dir}）`}`;
};

/** 覆盖统计：父板块 / 标准题材 / 映射来源 / 未映射概念，明确边界。 */
export const mainstreamCoverageText = (map) => {
  if (map?.state !== 'ready') return '';
  const coverage = map.coverage;
  return `固定 ${coverage.parentCount} 个父板块 · ${coverage.themeCount} 个标准题材 · 映射 ${coverage.matchedVendorCodeCount} / ${coverage.catalogConceptCount} 个原始概念（定义 ${coverage.mappedVendorCodeCount} 个 vendorCode，缺 ${coverage.missingVendorCodeCount} 个来源）· ${coverage.unmappedConceptCount} 个未映射概念保留在原始概念视图`;
};

/** 数据时点与延迟：前端时间只用于计算延迟，不当作行情时间。 */
export const mainstreamDelayText = (board, now = Date.now()) => {
  if (board?.state !== 'ready' || board.anchor === null) return null;
  const sampledAt = new Date(board.anchor.sampledAt);
  const delayMinutes = Math.max(0, Math.round((now - sampledAt.getTime()) / 60_000));
  return `批次 ${formatClock(board.anchor.sampledAt)} · 数据延迟约 ${delayMinutes} 分钟`;
};

export const mainstreamStockCoverageText = (board) => {
  if (board?.state !== 'ready') return '';
  const coverage = board.coverage;
  return `${coverage.themeWithConstituentsCount} 个题材有有效成分 · 成分 ${coverage.constituentCount} 条（ST ${coverage.stCount}）· 停牌退市 ${coverage.nonTradableCount} · 缺报价 ${coverage.missingQuoteCount} · 中文名缺失 ${coverage.unnamedCount} · 股票目录 ${coverage.universeCount} 只`;
};

const roleSort = (roles) =>
  [...roles].sort((left, right) => ROLE_ORDER.indexOf(left) - ROLE_ORDER.indexOf(right));

export const stockRoleLabels = (roles) =>
  roleSort(roles ?? []).map((role) => ROLE_LABELS[role] ?? role);

const pctText = (value) => formatPct(value, true, null);
const amountText = (value) => (value === null || value === undefined ? null : formatAmount(value));
const amountDeltaText = (value) => {
  if (value === null || value === undefined) return null;
  return value < 0 ? `-${formatAmount(Math.abs(value))}` : formatAmount(value);
};
const shareText = (value) =>
  value === null || value === undefined ? null : `${value.toFixed(2)}%`;
const ppText = (value) => {
  if (value === null || value === undefined) return null;
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}pp`;
};

const toneClass = (value) => {
  if (value === null || value === undefined) return 'muted';
  return value > 0 ? 'text-pos' : value < 0 ? 'text-neg' : 'muted';
};

export const stockSealedText = (row) => {
  if (row.sealed === null || row.sealed === undefined) return '封板缺失';
  if (row.sealed) {
    return row.ladderLevel === null || row.ladderLevel === undefined
      ? '封板'
      : `封板 ${row.ladderLevel} 板`;
  }
  return row.brokenBoard === true ? '炸板' : '未封';
};

export const stockTitle = (row) => {
  const name = row.name ?? row.code;
  return `${name} · ${row.code}`;
};

const stockLabel = (row) =>
  el('span', 'room-stock-label', [
    el('span', 'room-stock-name', row.name ?? '名称缺失'),
    el('span', 'room-stock-code mono muted', row.code),
    row.isSt ? el('span', 'room-tag room-tag-st', 'ST') : null,
    row.name === null ? el('span', 'room-tag room-tag-missing', '未入目录') : null,
  ]);

const roleTags = (roles) =>
  el(
    'span',
    'room-stock-roles',
    stockRoleLabels(roles).map((label, index) =>
      el('span', `room-tag room-role room-role-${roleSort(roles)[index]}`, label),
    ),
  );

const stockRowButton = (row, options = {}) => {
  const button = el('button', `room-stock${options.compact === true ? ' compact' : ''}`);
  button.type = 'button';
  button.dataset.stockId = row.stockId;
  const windowValue = options.window === 'w5' ? row.window5ChangePct : row.window15ChangePct;
  const windowLabel = options.window === 'w5' ? '5m' : '15m';
  const amountDelta = options.window === 'w5' ? row.window5AmountDelta : row.window15AmountDelta;
  button.append(
    el('span', 'room-stock-main', [
      stockLabel(row),
      options.isNew === true ? el('span', 'room-tag room-tag-new', '新进') : null,
    ]),
  );
  if (options.compact !== true) {
    button.append(
      el('span', 'room-stock-quote', [
        el('strong', 'room-stock-price mono', amountText(row.close) ?? '缺失'),
        el(
          'span',
          `mono ${toneClass(row.dayChangePct)}`,
          `日 ${pctText(row.dayChangePct) ?? '缺失'}`,
        ),
        el(
          'span',
          `mono ${toneClass(windowValue)}`,
          `${windowLabel} ${pctText(windowValue) ?? '缺失'}`,
        ),
      ]),
      el('span', 'room-stock-amount mono muted', [
        `今 ${amountText(row.todayAmount) ?? '缺失'}`,
        ` · ${windowLabel}增量 ${amountDeltaText(amountDelta) ?? '缺失'}`,
        row.sharePct === null ? '' : ` · 占比 ${shareText(row.sharePct)}`,
      ]),
      el('span', 'room-stock-meta', [
        roleTags(row.roles),
        el(
          'span',
          row.sealed === null ? 'room-tag room-tag-missing' : 'room-tag room-tag-sealed',
          stockSealedText(row),
        ),
      ]),
    );
  }
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    window.location.hash = mainstreamStockHash(mainstreamParamsFromHash(), row.stockId);
  });
  return button;
};

const sourceDetails = (theme, params) => {
  const details = el('details', 'room-theme-sources');
  const summary = el(
    'summary',
    '',
    `${theme.sources.length} 个来源概念${theme.missingVendorCodes.length > 0 ? ` · 缺 ${theme.missingVendorCodes.length} 个` : ''}`,
  );
  const list = el(
    'ul',
    '',
    theme.sources.map((source) => {
      const link = el('a', 'room-theme-source', source.name);
      link.href = `#${sectorDetailHash({
        kind: 'concept',
        sort: 'day',
        window: params.window,
        conceptScope: 'all',
        sectorId: source.sectorId,
        at: params.at,
      })}`;
      link.title = `${source.vendorCode} · active 成分 ${source.memberCount} 只`;
      return el('li', '', [link, el('span', 'muted', ` · ${source.memberCount} 只`)]);
    }),
  );
  if (theme.missingVendorCodes.length > 0) {
    list.append(el('li', 'muted', `当前目录缺少：${theme.missingVendorCodes.join('、')}`));
  }
  details.append(summary, list);
  return details;
};

const sharedState = {
  showSt: false,
  expandedConstituents: new Set(),
  constituentSorts: new Map(),
  previousCoreIds: new Map(),
  novelCoreIds: new Map(),
  noveltyKey: null,
  lastMap: null,
  lastBoard: null,
};

export const resetMainstreamUiState = () => {
  sharedState.showSt = false;
  sharedState.expandedConstituents.clear();
  sharedState.constituentSorts.clear();
  sharedState.previousCoreIds.clear();
  sharedState.novelCoreIds.clear();
  sharedState.noveltyKey = null;
  sharedState.lastMap = null;
  sharedState.lastBoard = null;
};

const refreshNovelty = (board) => {
  if (board?.state !== 'ready' || board.anchor === null) return;
  const key = `${board.anchor.sampledAt}|${board.window}`;
  if (sharedState.noveltyKey === key) return;
  const firstLoad = sharedState.previousCoreIds.size === 0;
  const next = new Map();
  for (const theme of board.themes) {
    const previous = sharedState.previousCoreIds.get(theme.themeId) ?? null;
    next.set(theme.themeId, firstLoad ? [] : newCoreStockIds(previous, theme.coreStocks));
  }
  sharedState.novelCoreIds = next;
  sharedState.previousCoreIds = new Map(
    board.themes.map((theme) => [
      theme.themeId,
      new Set(theme.coreStocks.map((row) => row.stockId)),
    ]),
  );
  sharedState.noveltyKey = key;
};

const noveltyOf = (themeId, stockId) =>
  (sharedState.novelCoreIds.get(themeId) ?? []).includes(stockId);

const rerender = () => {
  const current = $('#room-mainstream');
  if (current === null || sharedState.lastMap === null) return;
  const next = renderMainstreamPane(
    sharedState.lastMap,
    sharedState.lastBoard,
    mainstreamParamsFromHash(),
  );
  current.replaceWith(next);
};

const constituentTable = (theme, params) => {
  const rows = sortConstituents(
    visibleConstituents(theme.constituents, sharedState.showSt),
    sharedState.constituentSorts.get(theme.themeId) ?? 'window15AmountDelta',
  );
  const head = el('thead', '', [
    el('tr', '', [
      el('th', '', '股票'),
      el('th', 'num', '日涨幅'),
      el('th', 'num', '5 分钟'),
      el('th', 'num', '15 分钟'),
      el('th', 'num', '今日成交额'),
      el('th', 'num', '15 分钟增量'),
      el('th', 'num', '题材内占比'),
      el('th', 'num', '较上窗'),
      el('th', 'num', '增量变化'),
      el('th', '', '封板 / 连板'),
    ]),
  ]);
  const body = el(
    'tbody',
    '',
    rows.map((row) => {
      const name = stockRowButton(row, {
        compact: true,
        window: params.window,
        isNew: noveltyOf(theme.themeId, row.stockId),
      });
      const shareReason = row.shareReason === null ? '缺失' : row.shareReason;
      const cells = [
        el('td', '', name),
        el('td', `num ${toneClass(row.dayChangePct)}`, pctText(row.dayChangePct) ?? '缺失'),
        el('td', `num ${toneClass(row.window5ChangePct)}`, pctText(row.window5ChangePct) ?? '缺失'),
        el(
          'td',
          `num ${toneClass(row.window15ChangePct)}`,
          pctText(row.window15ChangePct) ?? '缺失',
        ),
        el('td', 'num', amountText(row.todayAmount) ?? '缺失'),
        el('td', 'num', amountDeltaText(row.window15AmountDelta) ?? '缺失'),
        el('td', 'num', shareText(row.sharePct) ?? '缺失'),
        el('td', 'num', ppText(row.shareDeltaPp) ?? '缺失'),
        el('td', 'num', amountDeltaText(row.amountDeltaChange) ?? '缺失'),
        el(
          'td',
          '',
          row.sealed === null
            ? el('span', 'room-missing', stockSealedText(row))
            : el('span', '', stockSealedText(row)),
        ),
      ];
      cells[6].title = shareReason;
      cells[7].title = row.previousShareReason ?? '较上一窗口不可比';
      return el('tr', '', cells);
    }),
  );
  return el('div', 'table-wrap', el('table', 'table room-constituent-table', [head, body]));
};

const constituentBlock = (theme, params) => {
  const expanded = sharedState.expandedConstituents.has(theme.themeId);
  const button = el(
    'button',
    'btn btn-outline btn-sm room-constituent-toggle',
    expanded ? '收起全部成分' : `查看全部成分（${theme.constituents.length}）`,
  );
  button.type = 'button';
  button.setAttribute('aria-expanded', String(expanded));
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (expanded) sharedState.expandedConstituents.delete(theme.themeId);
    else sharedState.expandedConstituents.add(theme.themeId);
    rerender();
  });
  if (!expanded) return el('div', 'room-constituent-bar', button);
  const sort = el('select');
  sort.setAttribute('aria-label', `${theme.name} 成分排序`);
  for (const key of CONSTITUENT_SORTS) {
    const option = el('option', '', CONSTITUENT_SORT_LABELS[key]);
    option.value = key;
    sort.append(option);
  }
  sort.value = sharedState.constituentSorts.get(theme.themeId) ?? 'window15AmountDelta';
  sort.addEventListener('change', () => {
    sharedState.constituentSorts.set(theme.themeId, sort.value);
    rerender();
  });
  return el('div', 'room-constituent', [
    el('div', 'room-constituent-bar', [button, el('label', 'room-control', ['排序', sort])]),
    constituentTable(theme, params),
  ]);
};

const coreBlock = (theme, params) => {
  if (theme.coreStocks.length === 0) {
    return el('p', 'room-caption', '当前批次没有可核实的核心股（缺有效报价或成分不足）。');
  }
  return el(
    'div',
    'room-core-list',
    theme.coreStocks.map((row) =>
      stockRowButton(row, {
        window: params.window,
        isNew: noveltyOf(theme.themeId, row.stockId),
      }),
    ),
  );
};

const themeCard = (theme, params, stockThemeById) => {
  const expanded = params.theme === theme.themeId;
  const stockTheme = stockThemeById.get(theme.themeId) ?? null;
  const day = params.sort === 'day' ? null : `日 ${pctText(theme.day.value) ?? '缺失'}`;
  const activeMetric =
    params.sort === 'amount' ? theme.turnover : (theme[params.sort] ?? theme.day);
  const activeText =
    params.sort === 'amount'
      ? `${shareText(activeMetric?.value) ?? '缺失'}`
      : (pctText(activeMetric?.value) ?? '缺失');
  const toggle = el('button', 'room-theme-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.append(
    el('span', 'room-theme-head', [
      el('h4', '', theme.name),
      el('strong', `room-theme-value ${toneClass(activeMetric?.value)}`, activeText),
      el('span', 'room-theme-caret', expanded ? '▾' : '▸'),
    ]),
    el('span', 'room-theme-meta', [
      el(
        'span',
        '',
        `上涨 ${theme.day.advancing} · 下跌 ${theme.day.declining} · 平 ${theme.day.unchanged}`,
      ),
      day === null ? null : el('span', '', day),
      el('span', '', `占比 ${shareText(theme.turnover.value) ?? '缺失'}`),
      el(
        'span',
        theme.limitUp.value === null ? 'room-missing' : '',
        theme.limitUp.value === null ? '封板缺失' : `封板 ${theme.limitUp.value}`,
      ),
    ]),
  );
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    window.location.hash = expanded
      ? mainstreamHashWithoutTheme(mainstreamParamsFromHash())
      : mainstreamThemeHash(mainstreamParamsFromHash(), theme.themeId);
  });

  const representative = stockTheme?.representative ?? null;
  const article = el('article', `room-theme-card${expanded ? ' expanded' : ''}`, [
    toggle,
    representative === null
      ? el('p', 'room-caption room-theme-empty', '暂无有效报价，不能给出领涨代表股。')
      : stockRowButton(representative, {
          window: params.window,
          isNew: noveltyOf(theme.themeId, representative.stockId),
        }),
    expanded
      ? el('div', 'room-theme-expanded', [
          stockTheme === null
            ? el('p', 'room-missing', '核心股读模型缺失')
            : el('div', '', [coreBlock(stockTheme, params), constituentBlock(stockTheme, params)]),
          sourceDetails(theme, params),
        ])
      : null,
  ]);
  article.dataset.themeId = theme.themeId;
  article.addEventListener('click', (event) => {
    if (event.target.closest('button, a, select, input, summary') !== null) return;
    window.location.hash = expanded
      ? mainstreamHashWithoutTheme(mainstreamParamsFromHash())
      : mainstreamThemeHash(mainstreamParamsFromHash(), theme.themeId);
  });
  return article;
};

const parentSection = (parent, params, stockThemeById) => {
  const sorted = sortMainstreamThemes(parent.themes, params.sort, params.dir);
  const day = params.sort === 'day' ? null : `日 ${pctText(parent.day.value) ?? '缺失'}`;
  const activeMetric =
    params.sort === 'amount' ? parent.turnover : (parent[params.sort] ?? parent.day);
  return el('section', 'room-parent', [
    el('div', 'room-parent-head', [
      el('h3', '', parent.name),
      el(
        'strong',
        `room-parent-value ${toneClass(activeMetric?.value)}`,
        params.sort === 'amount'
          ? (shareText(activeMetric?.value) ?? '缺失')
          : (pctText(activeMetric?.value) ?? '缺失'),
      ),
      el('span', 'room-parent-meta', `上涨 ${parent.day.advancing} · 下跌 ${parent.day.declining}`),
      day === null ? null : el('span', 'room-parent-meta', day),
      el('span', 'room-parent-meta', `占比 ${shareText(parent.turnover.value) ?? '缺失'}`),
    ]),
    el(
      'div',
      'room-theme-grid',
      sorted.map((theme) => themeCard(theme, params, stockThemeById)),
    ),
  ]);
};

const selectControl = (label, value, options, onChange) => {
  const select = el('select');
  select.setAttribute('aria-label', label);
  for (const [key, title] of options) {
    const option = el('option', '', title);
    option.value = key;
    select.append(option);
  }
  select.value = value;
  select.onchange = () => onChange(select.value);
  return select;
};

const controls = (params) => {
  const sort = selectControl(
    '题材排序',
    params.sort,
    SORTS.map((key) => [key, SORT_LABELS[key]]),
    (value) => {
      window.location.hash = mainstreamHash({ ...mainstreamParamsFromHash(), sort: value });
    },
  );
  const windowSelect = selectControl(
    '成交占比窗口',
    params.window,
    WINDOWS.map((key) => [key, WINDOW_LABELS[key]]),
    (value) => {
      window.location.hash = mainstreamHash({ ...mainstreamParamsFromHash(), window: value });
    },
  );
  const direction = el(
    'button',
    `btn btn-outline btn-sm${params.dir === 'down' ? ' active' : ''}`,
    params.sort === 'amount' ? '成交活跃' : params.dir === 'down' ? '领跌' : '领涨',
  );
  direction.type = 'button';
  direction.disabled = params.sort === 'amount';
  direction.setAttribute('aria-pressed', String(params.dir === 'down'));
  direction.onclick = () => {
    window.location.hash = mainstreamHash({
      ...mainstreamParamsFromHash(),
      dir: params.dir === 'down' ? 'up' : 'down',
    });
  };
  const st = el('input');
  st.type = 'checkbox';
  st.checked = sharedState.showSt;
  st.setAttribute('aria-label', '显示 ST');
  st.addEventListener('change', () => {
    sharedState.showSt = st.checked;
    rerender();
  });
  return el('div', 'room-mainstream-controls', [
    el('label', 'room-control', ['排序', sort]),
    el('label', 'room-control', ['占比窗口', windowSelect]),
    direction,
    el('label', 'room-control room-st-toggle', [st, '显示 ST']),
  ]);
};

export const renderMainstreamPane = (map, board = null, params = mainstreamParamsFromHash()) => {
  if (map === null || map === undefined) {
    return el('div', 'card room-empty', [
      el('h2', '', '主流题材作战台暂不可用'),
      el('p', '', '读取主流题材作战台失败，稍后会自动重试。'),
    ]);
  }
  sharedState.lastMap = map;
  sharedState.lastBoard = board;
  refreshNovelty(board);
  const empty = mainstreamEmptyText(map);
  if (empty !== null) {
    syncStockModal(board, params);
    return el('div', 'card room-empty', [
      el('h2', '', '主流题材作战台尚未就绪'),
      el('p', '', empty),
    ]);
  }
  const sampledAt = map.anchor === null ? '--' : formatClock(map.anchor.sampledAt);
  const stockThemeById = new Map((board?.themes ?? []).map((theme) => [theme.themeId, theme]));
  const section = el('section', 'card room-mainstream');
  section.id = 'room-mainstream';
  section.append(
    el('div', 'card-header', [
      el('div', '', [
        el('h2', '', '主流题材 · 短线核心股'),
        el(
          'div',
          'card-meta',
          params.at === null
            ? `${map.tradingDate} · ${mainstreamDelayText(board) ?? `${sampledAt} 批次`}`
            : `${map.tradingDate} · 回放时点 ${formatClock(board?.anchor?.sampledAt)}`,
        ),
      ]),
      controls(params),
    ]),
    el(
      'div',
      'room-parent-list',
      map.parents.map((parent) => parentSection(parent, params, stockThemeById)),
    ),
    mainstreamNotes(map, board),
  );
  syncStockModal(board, params);
  return section;
};

const mainstreamNotes = (map, board) => {
  const lines = [
    mainstreamCoverageText(map),
    mainstreamStockCoverageText(board),
    ...map.notes,
    ...(board?.notes ?? []),
    '全部成分的占比只使用窗口成交额增量，不是主力净流入；缺失、负修正与窗口不可比一律缺失。',
  ].filter((line) => typeof line === 'string' && line.length > 0);
  return el('details', 'room-detail-notes', [
    el('summary', '', `口径与缺失说明（${lines.length} 条）`),
    el(
      'ul',
      'room-warnings',
      lines.map((line) => el('li', '', line)),
    ),
  ]);
};

export const fetchMainstream = async (params = mainstreamParamsFromHash()) => {
  const result = await callApi(`/api/market/room/mainstream${mainstreamQuery(params)}`, {
    timeoutMs: 15_000,
  });
  if (!result.ok) return null;
  return {
    mainstream: result.data?.mainstream ?? null,
    stockBoard: result.data?.stockBoard ?? null,
  };
};

/* ---- 股票弹窗（作战室内，不跳 #market） ---- */

const SVG_NS = 'http://www.w3.org/2000/svg';
let lastFocusElement = null;
let lastFocusedStockId = null;
let modalObserver = null;
let modalTrap = null;
let modalSeriesKey = null;
let modalSeries = null;
let modalRequestId = 0;

const svgNode = (tag, attributes = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};

/** 1 分钟走势几何（纯函数）：价格线按缺口分段，成交额柱缺失留空，不插值。 */
export const intradayGeometry = (series, options = {}) => {
  const width = options.width ?? 620;
  const priceHeight = options.priceHeight ?? 150;
  const amountHeight = options.amountHeight ?? 64;
  const padding = 8;
  const points = series?.points ?? [];
  const prices = points.map((point) => point.close).filter((value) => Number.isFinite(value));
  const min = prices.length === 0 ? 0 : Math.min(...prices);
  const max = prices.length === 0 ? 0 : Math.max(...prices);
  const span = max - min;
  const priceY = (value) => {
    if (span === 0) return padding + (priceHeight - padding * 2) / 2;
    return padding + ((max - value) / span) * (priceHeight - padding * 2);
  };
  const slot = points.length <= 1 ? width : (width - padding * 2) / (points.length - 1);
  const xOf = (index) => padding + index * slot;
  const paths = [];
  let current = null;
  for (const [index, point] of points.entries()) {
    if (current === null || point.gapBefore) {
      if (current !== null && current.length > 1) paths.push(current.join(' '));
      current = [`M ${xOf(index).toFixed(2)} ${priceY(point.close).toFixed(2)}`];
      continue;
    }
    current.push(`L ${xOf(index).toFixed(2)} ${priceY(point.close).toFixed(2)}`);
  }
  if (current !== null && current.length > 1) paths.push(current.join(' '));
  const maxDelta = points.reduce(
    (maxValue, point) =>
      point.amountDelta !== null && point.amountDelta > maxValue ? point.amountDelta : maxValue,
    0,
  );
  const barWidth = Math.max(1, Math.min(6, slot * 0.62));
  const bars = points.flatMap((point, index) => {
    if (point.amountDelta === null || maxDelta <= 0) return [];
    const height = (point.amountDelta / maxDelta) * (amountHeight - padding * 2);
    return [
      {
        x: xOf(index) - barWidth / 2,
        y: amountHeight - padding - height,
        width: barWidth,
        height,
      },
    ];
  });
  return {
    width,
    priceHeight,
    amountHeight,
    padding,
    min,
    max,
    paths,
    bars,
    pointCount: points.length,
    gapCount: points.filter((point) => point.gapBefore).length,
  };
};

const intradaySvg = (series) => {
  const geometry = intradayGeometry(series);
  const svg = svgNode('svg', {
    viewBox: `0 0 ${geometry.width} ${geometry.priceHeight + geometry.amountHeight}`,
    class: 'room-stock-chart',
    role: 'img',
    'aria-label': '当日 1 分钟价格与成交额走势',
    preserveAspectRatio: 'none',
  });
  for (const path of geometry.paths) {
    svg.append(
      svgNode('path', {
        d: path,
        class: 'room-stock-price-line',
        fill: 'none',
        'stroke-width': 1.6,
      }),
    );
  }
  const offset = geometry.priceHeight;
  for (const bar of geometry.bars) {
    svg.append(
      svgNode('rect', {
        x: bar.x,
        y: offset + bar.y,
        width: bar.width,
        height: bar.height,
        class: 'room-stock-amount-bar',
      }),
    );
  }
  return svg;
};

const themesOfStock = (board, stockId) =>
  (board?.themes ?? [])
    .filter((theme) => theme.constituents.some((row) => row.stockId === stockId))
    .map((theme) => theme.name);

const stockModalFacts = (row, board) => {
  const facts = [
    ['最新价', amountText(row.close) ?? '缺失'],
    ['日涨幅', pctText(row.dayChangePct) ?? '缺失'],
    ['近 5 分钟', pctText(row.window5ChangePct) ?? '缺失'],
    ['近 15 分钟', pctText(row.window15ChangePct) ?? '缺失'],
    ['今日累计成交额', amountText(row.todayAmount) ?? '缺失'],
    ['窗口成交额增量', amountDeltaText(row.windowAmountDelta) ?? '缺失'],
    ['题材内窗口占比', shareText(row.sharePct) ?? '缺失'],
    ['较上一窗口', ppText(row.shareDeltaPp) ?? '缺失'],
    ['封板 / 连板', stockSealedText(row)],
    ['所属标准题材', themesOfStock(board, row.stockId).join('、') || '未在标准题材成分中'],
    ['数据时点', board?.anchor === null ? '缺失' : formatClock(board?.anchor?.sampledAt)],
  ];
  return el(
    'div',
    'room-stock-modal-facts',
    facts.map(([label, value]) =>
      el('div', 'room-stock-modal-fact', [el('span', 'label', label), el('span', 'value', value)]),
    ),
  );
};

const stockModalBody = (row, board, series) => {
  const chart =
    series === null
      ? el('p', 'room-caption', '正在读取本地已发布批次的 1 分钟序列…')
      : el('div', 'room-stock-chart-wrap', [
          intradaySvg(series),
          el(
            'p',
            'room-caption mono',
            `点数 ${series.coverage.pointCount} · 缺口 ${series.coverage.gapCount} · 负修正 ${series.coverage.negativeCorrectionCount}`,
          ),
          series.notes.length === 0
            ? null
            : el('details', 'room-detail-notes', [
                el('summary', '', `口径与缺失说明（${series.notes.length} 条）`),
                el(
                  'ul',
                  'room-warnings',
                  series.notes.map((note) => el('li', '', note)),
                ),
              ]),
        ]);
  return el('div', 'room-stock-modal', [
    stockModalFacts(row, board),
    row.shareReason === null ? null : el('p', 'room-caption', row.shareReason),
    row.brokenBoardReason === null ? null : el('p', 'room-caption', row.brokenBoardReason),
    chart,
    el('p', 'room-caption', '只呈现可核验行情与成交额，不构成买卖建议。'),
  ]);
};

const findStockRow = (board, stockId) => {
  for (const theme of board?.themes ?? []) {
    const found = theme.constituents.find((row) => row.stockId === stockId);
    if (found !== undefined) return found;
  }
  return null;
};

const teardownModalWatch = () => {
  if (modalObserver !== null) modalObserver.disconnect();
  modalObserver = null;
  if (modalTrap !== null) $('#modal-overlay')?.removeEventListener('keydown', modalTrap);
  modalTrap = null;
};

const restoreStockFocus = () => {
  const target = lastFocusedStockId === null ? null : $(`[data-stock-id="${lastFocusedStockId}"]`);
  if (target?.isConnected) {
    target.focus();
    return;
  }
  const section = $('#route-market-room');
  if (section !== null) {
    if (!section.hasAttribute('tabindex')) section.tabIndex = -1;
    section.focus();
  }
};

const trapFocus = (event) => {
  if (event.key !== 'Tab') return;
  const overlay = $('#modal-overlay');
  if (overlay === null) return;
  const focusable = [
    ...overlay.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((node) => node.offsetParent !== null || node === document.activeElement);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
};

const watchModalClose = () => {
  if (modalObserver !== null) return;
  const overlay = $('#modal-overlay');
  if (overlay === null) return;
  modalObserver = new MutationObserver(() => {
    if (overlay.hidden !== true) return;
    teardownModalWatch();
    const params = mainstreamParamsFromHash();
    if (params.stock !== null) {
      const nextHash = `#${mainstreamHashWithoutStock(params)}`;
      // 关闭弹窗只移除 stock 参数；replaceState 不触发整页重渲染，避免焦点丢失。
      if (typeof history.replaceState === 'function') {
        history.replaceState(null, '', nextHash);
      } else {
        window.location.hash = nextHash;
      }
    }
    restoreStockFocus();
  });
  modalObserver.observe(overlay, { attributes: true, attributeFilter: ['hidden'] });
  modalTrap = trapFocus;
  overlay.addEventListener('keydown', modalTrap);
};

const loadStockSeries = async (row, board, requestId) => {
  const anchor = board?.anchor?.sampledAt;
  if (anchor === null || anchor === undefined) return null;
  const key = `${row.stockId}|${anchor}`;
  if (modalSeriesKey === key) return modalSeries;
  const query = `?stockId=${encodeURIComponent(row.stockId)}&at=${encodeURIComponent(anchor)}`;
  const result = await callApi(`/api/market/room/stock-series${query}`, { timeoutMs: 15_000 });
  if (requestId !== modalRequestId) return null;
  modalSeriesKey = key;
  modalSeries = result.ok ? (result.data?.series ?? null) : null;
  return modalSeries;
};

const syncStockModal = (board, params) => {
  const overlay = $('#modal-overlay');
  if (overlay === null) return;
  if (params.stock === null || board?.state !== 'ready') {
    if (overlay.hidden === false) closeModal();
    return;
  }
  const row = findStockRow(board, params.stock);
  if (row === null) {
    if (overlay.hidden === false) return;
    return;
  }
  const wasHidden = overlay.hidden;
  if (wasHidden) lastFocusElement = document.activeElement;
  lastFocusedStockId = row.stockId;
  const currentSeries = modalSeriesKey?.startsWith(`${row.stockId}|`) === true ? modalSeries : null;
  openModal(stockTitle(row), stockModalBody(row, board, currentSeries));
  if (wasHidden) $('#modal-close')?.focus();
  watchModalClose();
  modalRequestId += 1;
  const requestId = modalRequestId;
  void loadStockSeries(row, board, requestId).then((series) => {
    if (series === null || requestId !== modalRequestId) return;
    if (mainstreamParamsFromHash().stock !== row.stockId) return;
    openModal(stockTitle(row), stockModalBody(row, board, series));
    if (lastFocusElement?.isConnected !== true) $('#modal-close')?.focus();
  });
};

export { lastFocusElement };
