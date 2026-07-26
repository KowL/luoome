/* apps/web/public/js/search-box.js —— 可复用股票搜索框组件。
 *
 * 行情页与仪表盘共用：容器内自建 input + 候选浮层，
 * ≥1 字符触发、250ms debounce、≤10 条候选、键盘 ↑/↓/Enter/Escape。
 * 选中后由调用方 onSelect(stock) 决定去向（本组件不感知路由）。
 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { createRequestTracker } from './market.js';
import { el, mount } from './ui.js';

/* ============ 纯函数（可独立测试） ============ */

/** Enter 选中的候选：有高亮取高亮，否则取第一条；空列表返回 undefined。 */
const pickSearchCandidate = (items, active) =>
  items.length === 0 ? undefined : (items[active] ?? items[0]);

/* ============ 组件 ============ */

const DEBOUNCE_MS = 250;
const MAX_ITEMS = 10;

/**
 * 在 container 内创建股票搜索框。
 * @param {HTMLElement} container
 * @param {{ onSelect: (stock: object) => void, placeholder?: string }} options
 */
const createStockSearchBox = (container, { onSelect, placeholder } = {}) => {
  if (container === null || container.dataset.bound === '1') return;
  container.dataset.bound = '1';

  const input = el('input');
  input.type = 'text';
  input.placeholder = placeholder ?? '002594 / 比亚迪';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', '搜索股票');
  const box = el('div', 'market-search-results');
  box.hidden = true;
  const wrap = el('div', 'market-search', [input, box]);
  container.append(wrap);

  const state = { items: [], active: -1, debounceTimer: null, tracker: createRequestTracker() };

  const hide = () => {
    box.hidden = true;
    state.items = [];
    state.active = -1;
  };

  const paintActive = () => {
    box.querySelectorAll('.market-search-item').forEach((node, i) => {
      node.classList.toggle('active', i === state.active);
    });
  };

  const select = (stock) => {
    hide();
    input.value = '';
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
      box.hidden = false;
      return;
    }
    state.items = r.data.stocks.slice(0, MAX_ITEMS);
    state.active = -1;
    if (state.items.length === 0) {
      mount(box, el('p', 'market-search-empty', '无匹配'));
      box.hidden = false;
      return;
    }
    mount(
      box,
      state.items.map((s, i) => {
        const item = el('button', 'market-search-item', `${s.code} · ${s.name}（${s.exchange}）`);
        item.type = 'button';
        item.addEventListener('click', () => select(s));
        item.addEventListener('mouseenter', () => {
          state.active = i;
          paintActive();
        });
        return item;
      }),
    );
    box.hidden = false;
  };

  input.addEventListener('input', () => {
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
    const keyword = input.value.trim();
    if (keyword.length < 1) {
      state.tracker.next();
      hide();
      return;
    }
    state.debounceTimer = setTimeout(() => void runSearch(keyword), DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
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
};

export { createStockSearchBox, pickSearchCandidate };
