import { createElement as h } from 'react';

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

export const Panel = ({ children }) =>
  h(
    'div',
    { className: 'luo-root' },
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

export const Refresh = ({ loading, onClick }) =>
  h(
    'button',
    {
      type: 'button',
      className: cx('luo-btn', loading && 'is-loading'),
      onClick,
      disabled: loading,
    },
    h(RefreshIcon),
    loading ? '读取中' : '刷新事实',
  );

export const Pill = ({ tone = 'quiet', dot = false, children }) =>
  h(
    'span',
    { className: cx('luo-pill', tone !== 'quiet' && `is-${tone}`) },
    dot ? h('i', { className: 'luo-dot' }) : null,
    children,
  );

export const Section = ({ title, meta, children, delay = 0 }) =>
  h(
    'section',
    { className: 'luo-section', style: delay ? { animationDelay: `${delay}ms` } : undefined },
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

export const Kpi = ({ label, value, sub, tone }) =>
  h(
    'div',
    { className: 'luo-kpi' },
    h('div', { className: 'luo-kpi-label' }, h('span', null, label)),
    h('div', { className: cx('luo-kpi-value', tone && `luo-${tone}`) }, value),
    sub ? h('div', { className: 'luo-kpi-sub' }, sub) : null,
  );

export const Stat = ({ k, v, tone }) =>
  h(
    'div',
    null,
    h('div', { className: 'luo-stat-k' }, k),
    h('div', { className: cx('luo-stat-v', tone && `luo-${tone}`) }, v),
  );

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
