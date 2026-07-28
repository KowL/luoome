/* apps/web/public/js/ui.js —— DOM 助手 + 共享 UI 组件。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';

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
const HORIZON_LABELS = {
  intraday: '盘中',
  short: '短期',
  medium: '中期',
  long: '长期',
};

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
  const primaryLabel =
    typeof advice.stockName === 'string' && advice.stockName.length > 0 ? advice.stockName : code;
  const row1 = el('div', 'row-1', [
    el('div', 'subject', [el('span', 'code', primaryLabel), String(advice.subjectId ?? '')]),
    decisionBadge(advice.decision),
  ]);
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

  // 点击展开 / 收起
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

/** v0.7 策略预警：送达状态 + 优先级 badge 的派生样式。 */
const PRIORITY_BADGE = {
  urgent: 'badge-urgent',
  important: 'badge-important',
  normal: 'badge-normal',
};
const DELIVERY_STATUS_LABEL = {
  'not-requested': '仅记录',
  'suppressed-cooldown': '冷却抑制',
  'suppressed-daily-limit': '日上限抑制',
  pending: '待发送',
  sent: '已发送',
  failed: '发送失败',
  'fallback-log': '降级日志',
};
const FEEDBACK_LABEL = {
  handled: '已处理',
  useful: '有用',
  useless: '无用',
  ignored: '忽略',
};

/**
 * 盯盘预警完整卡片（docs/ddd/strategy-alert-detailed-design.md §10）。
 * - 优先级 / 送达状态 badge
 * - evalSnapshot 展开区
 * - 四反馈按钮（handled / useful / useless / ignored）→ set_watch_trigger_feedback
 * - 「规则太频繁」跳方案编辑
 *
 * @param {object} trigger WatchTrigger
 * @param {(href: string) => void} navigate 路由跳转
 * @returns {HTMLElement}
 */
const triggerCard = (trigger, navigate) => {
  const deliveryLabel = DELIVERY_STATUS_LABEL[trigger.deliveryStatus] ?? trigger.deliveryStatus;
  const priority = trigger.priority ?? 'normal';
  const feedback = trigger.feedback;
  const card = el('article', `trigger-card direction-${trigger.direction ?? 'watch'}`);

  const main = el('div', 'trigger-card-main', [
    el('strong', 'mono', trigger.stockId ?? '--'),
    el('span', 'badge', trigger.ruleKind ?? '?'),
    el('span', `badge ${PRIORITY_BADGE[priority] ?? ''}`, `P:${priority}`),
    el('span', `badge badge-delivery-${trigger.deliveryStatus ?? 'not-requested'}`, deliveryLabel),
  ]);
  card.append(main);
  if (typeof trigger.reason === 'string' && trigger.reason.length > 0) {
    card.append(el('p', 'reason', trigger.reason));
  }
  const evidence = Array.isArray(trigger.evidence) ? trigger.evidence : [];
  if (evidence.length > 0) {
    card.append(
      el(
        'div',
        'evidence',
        evidence.map((s) => el('small', null, String(s))),
      ),
    );
  }
  // evalSnapshot 展开
  if (trigger.evalSnapshot && typeof trigger.evalSnapshot === 'object') {
    const detail = el('details', 'trigger-eval');
    detail.append(el('summary', null, '求值快照（设计 §12 可解释率来源）'));
    detail.append(el('pre', 'mono', JSON.stringify(trigger.evalSnapshot, null, 2)));
    card.append(detail);
  }
  const meta = el('small', 'muted');
  meta.textContent = `${fmtDateTime(trigger.createdAt)} · ${trigger.notified ? '已通知' : '仅记录'}${
    typeof trigger.poolId === 'string' ? ` · ${trigger.poolId}` : ''
  }`;
  card.append(meta);

  // 反馈区
  if (typeof trigger.id === 'string' && trigger.id.length > 0) {
    const feedbackRow = el('div', 'trigger-feedback');
    for (const f of ['handled', 'useful', 'useless', 'ignored']) {
      const btn = el(
        'button',
        `feedback-btn ${f}${feedback === f ? ' active' : ''}`,
        FEEDBACK_LABEL[f],
      );
      btn.type = 'button';
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        btn.disabled = true;
        try {
          await callApi(`/api/watch/triggers/${trigger.id}/feedback`, {
            method: 'POST',
            body: { feedback: f },
          });
          // 本地即时反馈，不刷新整列表
          feedbackRow.querySelectorAll('.feedback-btn').forEach((b) => {
            b.classList.remove('active');
          });
          btn.classList.add('active');
        } catch (err) {
          console.error('feedback failed', err);
        } finally {
          btn.disabled = false;
        }
      });
      feedbackRow.append(btn);
    }
    card.append(feedbackRow);

    // 「规则太频繁」跳方案编辑
    if (typeof navigate === 'function') {
      const tooNoisy = el('button', 'feedback-secondary');
      tooNoisy.type = 'button';
      tooNoisy.textContent = '规则太频繁 → 跳到方案编辑';
      tooNoisy.addEventListener('click', (event) => {
        event.stopPropagation();
        navigate(`/watch?poolId=${encodeURIComponent(trigger.poolId ?? '')}`);
      });
      card.append(tooNoisy);
    }
  }
  return card;
};

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
  triggerCard,
};
