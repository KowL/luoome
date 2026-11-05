import { createElement as h } from 'react';

import { metricTimeText, panelHealthBadge } from './projection.js';
import { STYLE } from './theme.js';

export const cx = (...values) => values.filter(Boolean).join(' ');

const RefreshIcon = () =>
  h(
    'svg',
    { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', {
      d: 'M13.5 8a5.5 5.5 0 1 1-1.61-3.89',
      stroke: 'currentColor',
      'stroke-width': '1.4',
      'stroke-linecap': 'round',
    }),
    h('path', {
      d: 'M13.5 2.6v3.2h-3.2',
      stroke: 'currentColor',
      'stroke-width': '1.4',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  );

export const Panel = ({ children, className }) =>
  h(
    'div',
    { className: cx('luo-root', className) },
    h('style', null, STYLE),
    h('div', { className: 'luo-shell' }, children),
  );

export const Head = ({ eyebrow, title, subtitle, side }) =>
  h(
    'header',
    { className: 'luo-head' },
    h(
      'div',
      null,
      h('div', { className: 'luo-eyebrow' }, h('i'), eyebrow),
      h('h1', { className: 'luo-title' }, title),
      h('p', { className: 'luo-sub' }, subtitle),
    ),
    side ? h('div', { className: 'luo-head-side' }, side) : null,
  );

export const Stamp = ({ label, value }) =>
  h('span', { className: 'luo-stamp' }, label ? `${label} ` : null, h('b', null, value));

export const Refresh = ({ loading, onClick, label = '刷新事实', ariaLabel }) =>
  h(
    'button',
    {
      type: 'button',
      className: cx('luo-btn', loading && 'is-loading'),
      onClick,
      disabled: loading,
      ...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel }),
    },
    h(RefreshIcon),
    loading ? '读取中' : label,
  );

export const Pill = ({ tone = 'quiet', dot = false, children }) =>
  h(
    'span',
    { className: cx('luo-pill', tone !== 'quiet' && `is-${tone}`) },
    dot ? h('i', { className: 'luo-dot' }) : null,
    children,
  );

export const Section = ({ title, meta, children, delay = 0, id }) =>
  h(
    'section',
    {
      className: 'luo-section',
      style: delay ? { animationDelay: `${delay}ms` } : undefined,
      // 面板内 section 锚点（T14 诊断：settings 内的 section=diagnostics，不新增顶层面板）。
      ...(id === undefined ? {} : { id, 'data-luoome-section': id }),
    },
    title
      ? h(
          'div',
          { className: 'luo-section-h' },
          h('h2', { className: 'luo-section-t' }, title),
          meta ? h('span', { className: 'luo-section-meta' }, meta) : null,
        )
      : null,
    children,
  );

export const Card = ({ title, meta, children, className, style }) =>
  h(
    'div',
    { className: cx('luo-card', className), style },
    title || meta
      ? h(
          'div',
          { className: 'luo-card-h' },
          h('h3', { className: 'luo-card-t' }, title),
          meta ? h('span', { className: 'luo-card-meta' }, meta) : null,
        )
      : null,
    children,
  );

/**
 * 数字的时点/可用性槽（REQ-M3-09 Q2）。
 *
 * 调用方**传了 `asOf` 这个键**（哪怕是 `null`）就渲染时间行：缺时点渲染「时点未知」
 * 而**不是省略**——PRD 是「出现即带」，省略等于静默违规。不传该键的既有调用点行为不变。
 */
const TimeSlot = (props, className) => {
  if (!('asOf' in props) && props.status === undefined) return null;
  const parts = [metricTimeText(props.asOf)];
  if (typeof props.status === 'string' && props.status.length > 0)
    parts.push(`可用性 ${props.status}`);
  return h('div', { className }, parts.join(' · '));
};

export const Kpi = (props) =>
  h(
    'div',
    { className: 'luo-kpi' },
    h('div', { className: 'luo-kpi-label' }, h('span', null, props.label)),
    h('div', { className: cx('luo-kpi-value', props.tone && `luo-${props.tone}`) }, props.value),
    props.sub ? h('div', { className: 'luo-kpi-sub' }, props.sub) : null,
    TimeSlot(props, 'luo-kpi-asof'),
  );

export const Stat = (props) =>
  h(
    'div',
    null,
    h('div', { className: 'luo-stat-k' }, props.k),
    h('div', { className: cx('luo-stat-v', props.tone && `luo-${props.tone}`) }, props.v),
    TimeSlot(props, 'luo-stat-asof'),
  );

/**
 * 面板「数据健康」角标（S5）：**只渲染服务端 `panel.health`**，不在这里判断可用性。
 * 服务端没给（老响应）时返回 null——不伪造「健康」。
 */
export const PanelHealthBadge = ({ health }) => {
  const badge = panelHealthBadge(health);
  if (badge === null) return null;
  return h(
    'div',
    { className: cx('luo-panel-health', `luo-${badge.tone}`), 'data-health-status': badge.status },
    h('span', { className: 'luo-panel-health-label' }, badge.label),
    badge.asOf === null
      ? h('span', { className: 'luo-fine' }, metricTimeText(null))
      : h('span', { className: 'luo-fine' }, `数据时点 ${badge.asOf}`),
    badge.detail.length === 0
      ? null
      : h(
          'ul',
          { className: 'luo-panel-health-issues' },
          badge.detail.map((text) => h('li', null, text)),
        ),
  );
};

const METER_TONE = {
  up: 'var(--lu-up)',
  down: 'var(--lu-down)',
  ok: 'var(--lu-ok)',
  bad: 'var(--lu-bad)',
  warn: 'var(--lu-warn)',
  accent: 'var(--lu-accent)',
  quiet: 'var(--lu-line-strong)',
};

export const Meter = ({ value, max = 100, tone }) =>
  h(
    'div',
    { className: 'luo-meter', role: 'presentation' },
    h('i', {
      style: {
        width: `${Math.max(0, Math.min(100, (Number(value) / max) * 100))}%`,
        ...(tone ? { background: METER_TONE[tone] ?? 'var(--lu-accent)' } : undefined),
      },
    }),
  );

export const Skeleton = ({ variant = 'line', style }) =>
  h('div', { className: `luo-skel is-${variant}`, style });

export const SkeletonLines = ({ lines = 3 }) =>
  h(
    'div',
    null,
    Array.from({ length: lines }, (_, index) =>
      h(Skeleton, { key: index, variant: 'line', style: { width: `${92 - index * 13}%` } }),
    ),
  );

export const Empty = ({ mark = '○', title, hint }) =>
  h(
    'div',
    { className: 'luo-empty' },
    h('span', { className: 'luo-empty-mark' }, mark),
    title ? h('span', { className: 'luo-empty-t' }, title) : null,
    hint ? h('span', { className: 'luo-empty-h' }, hint) : null,
  );

export const ErrorNote = ({ label, error }) =>
  h(
    'p',
    { className: 'luo-err', role: 'alert' },
    label ? `${label}：` : '',
    error?.message ?? error?.kind ?? error ?? '读取失败',
  );

export const Footer = ({ left, right }) =>
  h(
    'footer',
    { className: 'luo-foot' },
    h('div', null, left),
    h('div', { className: 'luo-foot-right' }, right),
  );
