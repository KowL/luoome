/* apps/web/public/js/search-box.js —— 可复用股票搜索框组件。
 *
 * 行情页与仪表盘共用：容器内自建 input + 候选浮层，
 * ≥1 字符触发、250ms debounce、≤10 条候选、键盘 ↑/↓/Enter/Escape。
 * 选中后由调用方 onSelect(stock) 决定去向（本组件不感知路由）。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { createRequestTracker } from './market-shared.js';
import { el, mount } from './ui.js';

/* ============ 纯函数（可独立测试） ============ */

/** Enter 选中的候选：有高亮取高亮，否则取第一条；空列表返回 undefined。 */
const pickSearchCandidate = (items, active) =>
  items.length === 0 ? undefined : (items[active] ?? items[0]);

/* ============ 组件 ============ */

const DEBOUNCE_MS = 250;
const MAX_ITEMS = 10;
/** 同页可能有多个搜索框：用序号生成唯一的 listbox / option id 供 aria 关联。 */
let searchBoxSeq = 0;

/**
 * 在 container 内创建股票搜索框。
 * @param {HTMLElement} container
 * @param {{ onSelect: (stock: object) => void, placeholder?: string, shortcutHint?: string }} options
 * @returns {{ focus: () => void } | null} 已绑定过返回 null
 */
const createStockSearchBox = (container, { onSelect, placeholder, shortcutHint } = {}) => {
  if (container === null || container.dataset.bound === '1') return null;
  container.dataset.bound = '1';

  const seq = ++searchBoxSeq;
  const listboxId = `market-search-listbox-${seq}`;
  const input = el('input');
  input.type = 'search';
  input.placeholder = placeholder ?? '002594 / 比亚迪';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('enterkeyhint', 'search');
  input.setAttribute('aria-label', '搜索股票');
  // combobox 语义：候选在 listbox 里，键盘高亮通过 aria-activedescendant 暴露
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listboxId);
  input.setAttribute('aria-autocomplete', 'list');
  const box = el('div', 'market-search-results');
  box.id = listboxId;
  box.setAttribute('role', 'listbox');
  box.setAttribute('aria-label', '股票候选');
  box.hidden = true;
  const children = [input];
  if (typeof shortcutHint === 'string' && shortcutHint.length > 0) {
    const hint = el('kbd', 'search-hint', shortcutHint);
    hint.setAttribute('aria-hidden', 'true');
    children.push(hint);
  }
  children.push(box);
  const wrap = el('div', 'market-search', children);
  container.append(wrap);

  const state = { items: [], active: -1, debounceTimer: null, tracker: createRequestTracker() };

  const hide = () => {
    box.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    state.items = [];
    state.active = -1;
  };

  const show = () => {
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const paintActive = () => {
    const nodes = [...box.querySelectorAll('.market-search-item')];
    nodes.forEach((node, i) => {
      const selected = i === state.active;
      node.classList.toggle('active', selected);
      node.setAttribute('aria-selected', String(selected));
    });
    const activeNode = nodes[state.active];
    if (activeNode === undefined) input.removeAttribute('aria-activedescendant');
    else input.setAttribute('aria-activedescendant', activeNode.id);
  };

  const select = (stock) => {
    hide();
    input.value = '';
    wrap.classList.remove('has-value');
    onSelect?.(stock);
  };

  const runSearch = async (keyword) => {
    const id = state.tracker.next();
    const r = await callApi(`/api/stocks/search?q=${encodeURIComponent(keyword)}&limit=10`);
    if (!state.tracker.isCurrent(id)) return;
    if (!r.ok || !Array.isArray(r.data?.stocks)) {
      state.items = [];
      state.active = -1;
      mount(box, el('p', 'market-search-empty', '无匹配'));
      show();
      return;
    }
    state.items = r.data.stocks.slice(0, MAX_ITEMS);
    state.active = -1;
    if (state.items.length === 0) {
      mount(box, el('p', 'market-search-empty', '无匹配'));
      show();
      return;
    }
    mount(
      box,
      state.items.map((s, i) => {
        const item = el('button', 'market-search-item', `${s.code} · ${s.name}（${s.exchange}）`);
        item.type = 'button';
        item.id = `${listboxId}-option-${i}`;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', 'false');
        item.addEventListener('click', () => select(s));
        item.addEventListener('mouseenter', () => {
          state.active = i;
          paintActive();
        });
        return item;
      }),
    );
    show();
  };

  input.addEventListener('input', () => {
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
    const keyword = input.value.trim();
    wrap.classList.toggle('has-value', keyword.length > 0);
    if (keyword.length < 1) {
      state.tracker.next();
      hide();
      return;
    }
    state.debounceTimer = setTimeout(() => void runSearch(keyword), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      input.value = '';
      wrap.classList.remove('has-value');
      hide();
      return;
    }
    if (state.items.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      state.active = (state.active + 1) % state.items.length;
      paintActive();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      state.active = (state.active - 1 + state.items.length) % state.items.length;
      paintActive();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const picked = pickSearchCandidate(state.items, state.active);
      if (picked !== undefined) select(picked);
    }
  });

  document.addEventListener('click', (event) => {
    if (event.target instanceof Node && !wrap.contains(event.target)) hide();
  });

  return { focus: () => input.focus() };
};

export { createStockSearchBox, pickSearchCandidate };
