/* apps/web/public/js/ui.js —— DOM 助手 + 共享 UI 组件。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * 构造 DOM 节点。
 * @param {string} tag
 * @param {string | null} [className]
 * @param {string | Node | Array<string | Node>} [children]
 * @returns {HTMLElement}
 */
const el = (tag, className, children) => {
  const node = document.createElement(tag);
  if (className !== undefined && className !== null && className.length > 0) {
    node.className = className;
  }
  if (children === undefined) return node;
  if (Array.isArray(children)) {
    for (const c of children) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
  } else if (children instanceof Node) {
    node.append(children);
  } else {
    node.textContent = String(children);
  }
  return node;
};

/**
 * 把节点列表 mount 到容器（清空 + append）。
 * @param {Element} container
 * @param {Node | Node[] | string} content
 */
const mount = (container, content) => {
  container.replaceChildren();
  if (content === null || content === undefined) return;
  if (Array.isArray(content)) container.append(...content);
  else container.append(content);
};

/** 决策 → 配色 / 中文标签。 */
const DECISIONS = {
  buy: { cls: 'badge-buy', label: '买入' },
  sell: { cls: 'badge-sell', label: '卖出' },
  hold: { cls: 'badge-hold', label: '持有' },
  watch: { cls: 'badge-watch', label: '观望' },
  avoid: { cls: 'badge-avoid', label: '回避' },
};

const decisionBadge = (decision) => {
  const cfg = DECISIONS[decision] ?? { cls: '', label: decision };
  return el('span', `badge ${cfg.cls}`, cfg.label);
};

/** 信心度条（0-100 → 进度条 + 文字）。 */
const confidenceBar = (value) => {
  const v = Math.max(0, Math.min(100, value));
  const level = v >= 70 ? 'high' : v >= 40 ? 'mid' : 'low';
  const bar = el('span', `confidence-bar ${level}`);
  bar.append(el('span', 'fill'));
  bar.firstElementChild.style.width = `${v}%`;
  return el('span', 'confidence', [bar, el('span', 'confidence-label', `${v}%`)]);
};

/** 格式化数字（千分位 + 固定小数位）。 */
const fmtNum = (value, fractionDigits = 2) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
};

const fmtPct = (ratio, fractionDigits = 2) => {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '--';
  return `${(ratio * 100).toFixed(fractionDigits)}%`;
};

const fmtSigned = (value, fractionDigits = 2) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(fractionDigits)}`;
};

const fmtDateTime = (d) => {
  if (d === undefined || d === null) return '--';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('zh-CN', { hour12: false });
};

/**
 * Advice 完整卡片（含 expand 切换）。
 * options.onToggleSelect 非空时行首渲染勾选框（建议页选择模式的批量删除）；
 * 勾选框点击不触发卡片展开。
 * @param {object} advice
 * @param {{ checked?: boolean, onToggleSelect?: (id: string, checked: boolean) => void }} [options]
 * @returns {HTMLElement}
 */
const HORIZON_LABELS = {
  intraday: '盘中',
  short: '短期',
  medium: '中期',
  long: '长期',
};

const adviceCard = (advice, options = {}) => {
  const code = String(advice.subjectId ?? '').split('.')[0] || String(advice.subjectId ?? '');
  const card = el('article', 'advice-card');
  const premise = advice.reasoning?.premise ?? '';
  const evidence = Array.isArray(advice.reasoning?.evidence) ? advice.reasoning.evidence : [];
  const counter = Array.isArray(advice.reasoning?.counterEvidence)
    ? advice.reasoning.counterEvidence
    : [];
  const risks = Array.isArray(advice.risks) ? advice.risks : [];
  const disclaimers = Array.isArray(advice.disclaimers) ? advice.disclaimers : [];

  // row-1: [勾选框] 标的 + 决策 badge
  const primaryLabel =
    typeof advice.stockName === 'string' && advice.stockName.length > 0 ? advice.stockName : code;
  const row1Parts = [];
  if (options.onToggleSelect !== undefined) {
    const checkbox = el('input', 'advice-select');
    checkbox.type = 'checkbox';
    checkbox.checked = options.checked === true;
    checkbox.setAttribute('aria-label', '选择该建议');
    checkbox.addEventListener('change', () => {
      options.onToggleSelect?.(String(advice.id ?? ''), checkbox.checked);
    });
    row1Parts.push(checkbox);
  }
  row1Parts.push(
    el('div', 'subject', [el('span', 'code', primaryLabel), String(advice.subjectId ?? '')]),
    decisionBadge(advice.decision),
  );
  const row1 = el('div', 'row-1', row1Parts);
  card.append(row1);

  // premise
  if (premise.length > 0) card.append(el('p', 'premise', premise));

  // row-2: 信心度 + 周期 + 建议时间 + validUntil + outcome
  const horizonLabel = HORIZON_LABELS[advice.horizon] ?? advice.horizon ?? '--';
  const row2Parts = [confidenceBar(advice.confidence), `周期 ${horizonLabel}`];
  if (advice.createdAt !== undefined) {
    row2Parts.push(`建议时间 ${fmtDateTime(advice.createdAt)}`);
  }
  if (advice.validUntil !== undefined) {
    row2Parts.push(`有效至 ${fmtDateTime(advice.validUntil)}`);
  }
  if (advice.outcome !== undefined) {
    const o = advice.outcome;
    const pnlText = o.pnl !== undefined ? `（盈亏 ${fmtSigned(o.pnl)}）` : '';
    row2Parts.push(`outcome: ${o.outcome}${pnlText}`);
    if (o.benchmarkPnl !== undefined) row2Parts.push(`基准 ${fmtSigned(o.benchmarkPnl)}`);
    if (o.holdingHours !== undefined) row2Parts.push(`持有 ${o.holdingHours}h`);
    if (Array.isArray(o.tradeIds) && o.tradeIds.length > 0) {
      row2Parts.push(`交易 ${o.tradeIds.join(',')}`);
    }
  }
  card.append(
    el(
      'div',
      'row-2',
      // confidenceBar 返回 Node，不能 String() 化（会变成 [object HTMLSpanElement]）
      row2Parts.map((t) => (t instanceof Node ? t : el('span', null, String(t)))),
    ),
  );

  // toggle (evidence / counter / risks / disclaimers)
  const toggle = el('div', 'toggle');
  if (evidence.length > 0) {
    toggle.append(el('h4', null, '支持证据'));
    toggle.append(
      el(
        'ul',
        null,
        evidence.map((s) => el('li', null, s)),
      ),
    );
  }
  if (counter.length > 0) {
    toggle.append(el('h4', null, '反证'));
    toggle.append(
      el(
        'ul',
        null,
        counter.map((s) => el('li', null, s)),
      ),
    );
  }
  if (risks.length > 0) {
    toggle.append(el('h4', null, '风险提示'));
    toggle.append(
      el(
        'ul',
        'risks',
        risks.map((s) => el('li', null, s)),
      ),
    );
  }
  if (disclaimers.length > 0) {
    toggle.append(
      el(
        'div',
        'disclaimers',
        disclaimers.map((s) => el('div', null, `· ${s}`)),
      ),
    );
  }
  card.append(toggle);

  // 点击展开 / 收起（按钮与勾选框不触发展开）
  card.addEventListener('click', (event) => {
    if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLInputElement) {
      return;
    }
    card.classList.toggle('expanded');
  });
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  return card;
};

/** Stat 块（label / value / delta）。 */
const statBlock = (label, value, delta) =>
  el(
    'div',
    'stat',
    delta !== undefined
      ? [el('div', 'label', label), el('div', 'value', value), el('div', 'delta', delta)]
      : [el('div', 'label', label), el('div', 'value', value)],
  );

const PAGE_SIZE_OPTIONS = [10, 30, 50, 100];

/**
 * 可点击排序表头。
 * @param {string} label
 * @param {string} sortKey
 * @param {{key:string,order:'asc'|'desc'}|null} sortState
 * @param {(key:string) => void} onSort
 * @returns {HTMLElement}
 */
const compareValues = (a, b) => {
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
};

const sortableHeader = (label, sortKey, sortState, onSort, className = '') => {
  const active = sortState?.key === sortKey;
  const arrow = active ? (sortState.order === 'asc' ? ' ↑' : ' ↓') : '';
  const cls = `sortable${active ? ' active' : ''}${className ? ` ${className}` : ''}`;
  const th = el('th', cls, `${label}${arrow}`);
  th.addEventListener('click', () => onSort(sortKey));
  return th;
};

const buildPageNumbers = (page, pageCount) => {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, i) => i + 1);
  const numbers = [];
  numbers.push(1);
  if (page > 4) numbers.push('...');
  const start = Math.max(2, page - 2);
  const end = Math.min(pageCount - 1, page + 2);
  for (let i = start; i <= end; i += 1) numbers.push(i);
  if (page < pageCount - 3) numbers.push('...');
  if (pageCount > 1) numbers.push(pageCount);
  return numbers;
};

/**
 * 可复用分页控件。
 * @param {object} options
 * @param {number} [options.pageSize=30]
 * @param {number[]} [options.pageSizes=[10,30,50,100]]
 * @param {number} [options.total=0]
 * @param {(state: {page:number,pageSize:number}) => void} [options.onChange]
 * @returns {{root: HTMLElement, setState: (state: Partial<{page:number,pageSize:number,total:number}>) => void, getState: () => {page:number,pageSize:number,total:number}}}
 */
const createPagination = (options = {}) => {
  let pageSizes = options.pageSizes ?? PAGE_SIZE_OPTIONS;
  let pageSize = options.pageSize ?? 30;
  if (!pageSizes.includes(pageSize)) pageSizes = [...pageSizes, pageSize].sort((a, b) => a - b);
  let page = 1;
  let total = options.total ?? 0;
  const onChange = options.onChange ?? (() => {});

  const prev = el('button', 'btn btn-outline btn-sm', '上一页');
  prev.type = 'button';
  const next = el('button', 'btn btn-outline btn-sm', '下一页');
  next.type = 'button';
  const info = el('span', 'pagination-info muted mono', '');
  const pageWrap = el('div', 'pagination-pages');
  const sizeSelect = el('select', 'pagination-size');
  for (const size of pageSizes) {
    const option = document.createElement('option');
    option.value = String(size);
    option.textContent = `${size} 条/页`;
    option.selected = size === pageSize;
    sizeSelect.append(option);
  }
  sizeSelect.addEventListener('change', () => {
    pageSize = Number(sizeSelect.value);
    page = 1;
    render();
    onChange(getState());
  });
  prev.addEventListener('click', () => {
    if (page <= 1) return;
    page -= 1;
    render();
    onChange(getState());
  });
  next.addEventListener('click', () => {
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (page >= pageCount) return;
    page += 1;
    render();
    onChange(getState());
  });

  const render = () => {
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(Math.max(1, page), pageCount);
    prev.disabled = page <= 1;
    next.disabled = page >= pageCount;
    info.textContent = `第 ${page} / ${pageCount} 页 · 共 ${total} 条`;
    pageWrap.replaceChildren();
    for (const number of buildPageNumbers(page, pageCount)) {
      if (number === '...') {
        pageWrap.append(el('span', 'pagination-ellipsis', '…'));
        continue;
      }
      const button = el(
        'button',
        `btn btn-sm${number === page ? ' btn-primary' : ' btn-outline'}`,
        String(number),
      );
      button.type = 'button';
      button.addEventListener('click', () => {
        page = number;
        render();
        onChange(getState());
      });
      pageWrap.append(button);
    }
  };

  const getState = () => ({ page, pageSize, total });
  const setState = (next) => {
    if (next.page !== undefined) page = next.page;
    if (next.pageSize !== undefined) {
      pageSize = next.pageSize;
      for (const option of sizeSelect.options) option.selected = Number(option.value) === pageSize;
    }
    if (next.total !== undefined) total = next.total;
    render();
  };

  const root = el('div', 'pagination', [prev, pageWrap, next, info, sizeSelect]);
  render();
  return { root, setState, getState };
};

export {
  $,
  $$,
  adviceCard,
  compareValues,
  confidenceBar,
  createPagination,
  DECISIONS,
  decisionBadge,
  el,
  fmtDateTime,
  fmtNum,
  fmtPct,
  fmtSigned,
  mount,
  sortableHeader,
  statBlock,
};
