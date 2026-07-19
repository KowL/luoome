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
 * @param {object} advice
 * @returns {HTMLElement}
 */
const adviceCard = (advice) => {
  const code = String(advice.subjectId ?? '').split('.')[0] || String(advice.subjectId ?? '');
  const card = el('article', 'advice-card');
  const premise = advice.reasoning?.premise ?? '';
  const evidence = Array.isArray(advice.reasoning?.evidence) ? advice.reasoning.evidence : [];
  const counter = Array.isArray(advice.reasoning?.counterEvidence)
    ? advice.reasoning.counterEvidence
    : [];
  const risks = Array.isArray(advice.risks) ? advice.risks : [];
  const disclaimers = Array.isArray(advice.disclaimers) ? advice.disclaimers : [];

  // row-1: 标的 + 决策 badge
  const row1 = el('div', 'row-1', [
    el('div', 'subject', [el('span', 'code', code), String(advice.subjectId ?? '')]),
    decisionBadge(advice.decision),
  ]);
  card.append(row1);

  // premise
  if (premise.length > 0) card.append(el('p', 'premise', premise));

  // row-2: 信心度 + 周期 + validUntil + outcome
  const row2Parts = [confidenceBar(advice.confidence), `周期 ${advice.horizon ?? '--'}`];
  if (advice.validUntil !== undefined) {
    row2Parts.push(`有效至 ${fmtDateTime(advice.validUntil)}`);
  }
  if (advice.outcome !== undefined) {
    const o = advice.outcome;
    const pnlText = o.pnl !== undefined ? `（盈亏 ${fmtSigned(o.pnl)}）` : '';
    row2Parts.push(`outcome: ${o.outcome}${pnlText}`);
  }
  card.append(
    el(
      'div',
      'row-2',
      row2Parts.map((t) => el('span', null, String(t))),
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

  // 点击展开
  card.addEventListener('click', (event) => {
    if (event.target instanceof HTMLButtonElement) return;
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

export {
  $,
  $$,
  adviceCard,
  confidenceBar,
  DECISIONS,
  decisionBadge,
  el,
  fmtDateTime,
  fmtNum,
  fmtPct,
  fmtSigned,
  mount,
  statBlock,
};
