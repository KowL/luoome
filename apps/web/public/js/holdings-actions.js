/* apps/web/public/js/holdings-actions.js —— 持仓操作弹窗（新增 / 加仓 / 减仓 / 纠错 / 平仓）。
 * 写操作统一走 /api/tools/<name>/call（web 默认放行 write + fetch_quote 白名单）。
 * 刷新与状态提示通过 initHoldingsActions 注入，避免反向 import pages.js。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { $, el, fmtNum } from './ui.js';

/* ============ 依赖注入 ============ */

let onRefresh = async () => {};
let notify = () => {};

export const initHoldingsActions = ({ refresh, setStatus }) => {
  onRefresh = refresh;
  notify = setStatus;
  $('#modal-close')?.addEventListener('click', closeModal);
  $('#modal-overlay')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
};

/* ============ modal 基础 ============ */

const openModal = (title, body) => {
  const titleNode = $('#modal-title');
  const bodyNode = $('#modal-body');
  const overlay = $('#modal-overlay');
  if (titleNode === null || bodyNode === null || overlay === null) return;
  titleNode.textContent = title;
  bodyNode.replaceChildren(body);
  overlay.hidden = false;
};

const closeModal = () => {
  const overlay = $('#modal-overlay');
  if (overlay !== null) overlay.hidden = true;
};

/* ============ 表单小件 ============ */

const STOCK_ID_PATTERN = /^[A-Z0-9]{1,12}\.(SH|SZ|BJ|HK|US)$/;

const makeInput = (id, { type = 'text', value = '', placeholder = '' } = {}) => {
  const input = el('input');
  input.id = id;
  input.type = type;
  if (placeholder.length > 0) input.placeholder = placeholder;
  if (value.length > 0) input.value = value;
  return input;
};

const fieldWrap = (label, control, hint) => {
  const node = el('div', 'field');
  node.append(el('label', null, label));
  node.append(control);
  if (hint !== undefined) node.append(el('span', 'hint', hint));
  return node;
};

const actionsRow = (confirmLabel, { danger = false, onConfirm } = {}) => {
  const row = el('div', 'modal-actions');
  const cancel = el('button', 'btn btn-outline', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', closeModal);
  const ok = el('button', danger ? 'btn btn-danger' : 'btn btn-primary', confirmLabel);
  ok.type = 'button';
  ok.addEventListener('click', () => void onConfirm(ok));
  row.append(cancel, ok);
  return row;
};

const parsePositiveInt = (raw) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const parsePositiveNumber = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const errorText = (error) => {
  if (error === null || typeof error !== 'object') return '提交失败';
  const detail = error.message ?? error.cause ?? '';
  return detail === '' ? String(error.kind) : `${error.kind}：${detail}`;
};

/** fetch_quote 返回 { quote }；集中解析，避免 UI 误读不存在的 data.price。 */
export const quotePriceFromResult = (result) => {
  const price = result?.ok ? result.data?.quote?.close : undefined;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
};

/** 提交公共流程：禁用按钮 → 调 tool → 失败上屏 / 成功关窗 + 刷新 + 状态提示。 */
const submitTool = async (btn, errorNode, name, input, successMessage) => {
  btn.disabled = true;
  errorNode.textContent = '';
  try {
    const r = await callApi(`/api/tools/${name}/call`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
    if (!r.ok) {
      errorNode.textContent = errorText(r.error);
      return;
    }
    closeModal();
    await onRefresh();
    notify(successMessage);
  } catch (error) {
    errorNode.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    btn.disabled = false;
  }
};

/* ============ 新增持仓（add_trade buy，建仓即写交易） ============ */

export const openAddHoldingModal = () => {
  const stockInput = makeInput('f-stock', { placeholder: '代码或名称，如 601398 / 比亚迪' });
  let selectedStockId = '';
  let selectedStockName = '';
  let priceRequest = 0;
  const acList = el('div', 'autocomplete-list');
  acList.hidden = true;
  const acWrap = el('div', 'autocomplete', [stockInput, acList]);

  const qtyInput = makeInput('f-qty', { type: 'number', placeholder: '买入数量（股）' });
  const priceInput = makeInput('f-price', {
    type: 'number',
    placeholder: '选定股票后自动填入现价',
  });
  const priceHint = el('span', 'hint', '选定股票后自动填入现价，可手动修改');
  const priceField = el('div', 'field');
  priceField.append(el('label', null, '价格'), priceInput, priceHint);
  const feeInput = makeInput('f-fee', { type: 'number', placeholder: '0（可选）' });
  const errorNode = el('p', 'modal-error');

  /** 选定股票后自动带现价；失败时明确提示仍可手填。 */
  const fillCurrentPrice = (stockId, stockName = '') => {
    const request = ++priceRequest;
    priceHint.textContent = '正在获取现价…';
    void (async () => {
      const r = await callApi('/api/tools/fetch_quote/call', {
        method: 'POST',
        body: JSON.stringify({
          input: { stockId, ...(stockName.length > 0 ? { stockName } : {}) },
        }),
      });
      if (request !== priceRequest) return;
      const price = quotePriceFromResult(r);
      if (price !== null) {
        priceInput.value = String(price);
        priceHint.textContent = `已填入现价 ${price}，可手动修改`;
      } else {
        priceHint.textContent = '实时行情暂不可用，请手动输入成交价';
      }
    })();
  };

  const pickStock = (id, label, name = '') => {
    selectedStockId = id;
    selectedStockName = name;
    stockInput.value = label;
    acList.hidden = true;
    fillCurrentPrice(id, name);
  };

  /**
   * 代码形态输入的兜底候选：search_stocks 只查本地股票库，未入库的新股
   * 按位数给出交易所后缀建议（建仓时 add_trade 自动补 stub 登记）。
   */
  const syntheticCandidates = (q) => {
    if (/^\d{6}$/.test(q)) return [`${q}.SH`, `${q}.SZ`];
    if (/^\d{4,5}$/.test(q)) return [`${q}.HK`];
    if (/^[A-Za-z]{1,5}$/.test(q)) return [`${q.toUpperCase()}.US`];
    return [];
  };

  let timer = 0;
  stockInput.addEventListener('input', () => {
    selectedStockId = '';
    selectedStockName = '';
    window.clearTimeout(timer);
    const q = stockInput.value.trim();
    if (q.length === 0) {
      acList.hidden = true;
      return;
    }
    // 已输入完整带后缀代码：直接当选定，自动带现价
    if (STOCK_ID_PATTERN.test(q.toUpperCase())) {
      acList.hidden = true;
      fillCurrentPrice(q.toUpperCase());
      return;
    }
    timer = window.setTimeout(() => {
      void (async () => {
        const r = await callApi('/api/tools/search_stocks/call', {
          method: 'POST',
          body: JSON.stringify({ input: { query: q, limit: 8 } }),
        });
        const stocks = r.ok && Array.isArray(r.data?.stocks) ? r.data.stocks : [];
        const items = stocks.map((s) => {
          const item = el('div', 'autocomplete-item', `${s.id} · ${s.name}`);
          item.addEventListener('click', () => pickStock(s.id, `${s.id} ${s.name}`, s.name));
          return item;
        });
        // 库内无结果时才给代码后缀兜底候选（外部源已接入，真实候选优先）
        const extras =
          stocks.length === 0
            ? syntheticCandidates(q).map((id) => {
                const item = el('div', 'autocomplete-item', `${id} ·（未入库，建仓时自动登记）`);
                item.addEventListener('click', () => pickStock(id, id));
                return item;
              })
            : [];
        const all = [...items, ...extras];
        if (all.length === 0) {
          acList.hidden = true;
          return;
        }
        acList.replaceChildren(...all);
        acList.hidden = false;
      })();
    }, 300);
  });

  const resolveStockId = () => {
    if (selectedStockId.length > 0) return selectedStockId;
    const first = stockInput.value.trim().toUpperCase().split(/\s+/)[0] ?? '';
    return STOCK_ID_PATTERN.test(first) ? first : null;
  };

  const body = el('div', null, [
    fieldWrap('股票', acWrap, '输名称搜库内股票；输 6 位代码自动给出 .SH/.SZ 候选'),
    fieldWrap('数量', qtyInput),
    priceField,
    fieldWrap('手续费', feeInput),
    errorNode,
    actionsRow('确认建仓', {
      onConfirm: (btn) => {
        const stockId = resolveStockId();
        if (stockId === null) {
          errorNode.textContent = '请先选择候选，或输入完整带后缀代码（例：601398.SH）';
          return;
        }
        const quantity = parsePositiveInt(qtyInput.value);
        if (quantity === null) {
          errorNode.textContent = '数量必须是正整数';
          return;
        }
        const price = parsePositiveNumber(priceInput.value);
        if (price === null) {
          errorNode.textContent = '价格必须是大于 0 的数字';
          return;
        }
        const fee = feeInput.value.trim() === '' ? 0 : Number(feeInput.value);
        if (!Number.isFinite(fee) || fee < 0) {
          errorNode.textContent = '手续费必须是非负数字';
          return;
        }
        void submitTool(
          btn,
          errorNode,
          'add_trade',
          {
            stockId,
            ...(selectedStockName.length > 0 ? { stockName: selectedStockName } : {}),
            side: 'buy',
            quantity,
            price,
            fee,
          },
          `已建仓 ${stockId} · ${quantity} 股`,
        );
      },
    }),
  ]);
  openModal('新增持仓', body);
};

/* ============ 加仓 / 减仓（add_trade buy/sell） ============ */

export const openTradeModal = (holding, side) => {
  const isBuy = side === 'buy';
  const verb = isBuy ? '加仓' : '减仓';
  const qtyInput = makeInput('f-qty', {
    type: 'number',
    placeholder: `${isBuy ? '买入' : '卖出'}数量（股）`,
  });
  const priceInput = makeInput('f-price', {
    type: 'number',
    value: holding.currentPrice > 0 ? String(holding.currentPrice) : '',
    placeholder: '成交单价',
  });
  const feeInput = makeInput('f-fee', { type: 'number', placeholder: '0（可选）' });
  const errorNode = el('p', 'modal-error');

  const body = el('div', null, [
    el(
      'p',
      'hint',
      `当前持股 ${holding.quantity} 股 · 可卖 ${holding.availableQuantity} 股 · 成本 ${fmtNum(holding.avgCost)}`,
    ),
    fieldWrap('数量', qtyInput),
    fieldWrap('价格', priceInput),
    fieldWrap('手续费', feeInput),
    errorNode,
    actionsRow(`确认${verb}`, {
      onConfirm: (btn) => {
        const quantity = parsePositiveInt(qtyInput.value);
        if (quantity === null) {
          errorNode.textContent = '数量必须是正整数';
          return;
        }
        if (!isBuy && quantity > holding.availableQuantity) {
          errorNode.textContent = `超过可卖数量（${holding.availableQuantity} 股，当日买入 T+1 才可卖）`;
          return;
        }
        const price = parsePositiveNumber(priceInput.value);
        if (price === null) {
          errorNode.textContent = '价格必须是大于 0 的数字';
          return;
        }
        const fee = feeInput.value.trim() === '' ? 0 : Number(feeInput.value);
        if (!Number.isFinite(fee) || fee < 0) {
          errorNode.textContent = '手续费必须是非负数字';
          return;
        }
        void submitTool(
          btn,
          errorNode,
          'add_trade',
          { stockId: holding.stockId, side, quantity, price, fee },
          `${verb}完成 ${holding.stockId} · ${quantity} 股`,
        );
      },
    }),
  ]);
  openModal(`${verb} · ${holding.stockName}（${holding.stockId}）`, body);
};

/* ============ 纠错（update_holding） ============ */

export const openEditModal = (holding) => {
  const qtyInput = makeInput('f-qty', { type: 'number', value: String(holding.quantity) });
  const availInput = makeInput('f-avail', {
    type: 'number',
    value: String(holding.availableQuantity),
  });
  const costInput = makeInput('f-cost', { type: 'number', value: String(holding.avgCost) });
  const errorNode = el('p', 'modal-error');

  const body = el('div', null, [
    el('p', 'hint', '仅修正录入错误；正常买卖请用加仓 / 减仓（会写交易记录并联动成本）。'),
    fieldWrap('数量', qtyInput),
    fieldWrap('可卖数量', availInput),
    fieldWrap('成本价', costInput),
    errorNode,
    actionsRow('保存修正', {
      onConfirm: (btn) => {
        const quantity = Number(qtyInput.value);
        if (!Number.isInteger(quantity) || quantity < 0) {
          errorNode.textContent = '数量必须是非负整数';
          return;
        }
        const availableQuantity = Number(availInput.value);
        if (!Number.isInteger(availableQuantity) || availableQuantity < 0) {
          errorNode.textContent = '可卖数量必须是非负整数';
          return;
        }
        if (availableQuantity > quantity) {
          errorNode.textContent = '可卖数量不能大于数量';
          return;
        }
        const avgCost = parsePositiveNumber(costInput.value);
        if (avgCost === null) {
          errorNode.textContent = '成本价必须是大于 0 的数字';
          return;
        }
        void submitTool(
          btn,
          errorNode,
          'update_holding',
          { holdingId: holding.id, quantity, availableQuantity, avgCost },
          `已修正 ${holding.stockId} 持仓`,
        );
      },
    }),
  ]);
  openModal(`纠错 · ${holding.stockName}（${holding.stockId}）`, body);
};

/* ============ 平仓（close_holding，软平仓） ============ */

export const openCloseConfirm = (holding) => {
  const errorNode = el('p', 'modal-error');
  const body = el('div', null, [
    el(
      'div',
      'modal-warning',
      `将把 ${holding.stockName}（${holding.stockId}）${holding.quantity} 股标记为已平仓。` +
        '仅标记状态、不写交易记录；如果是实际卖出，请改用「减仓」并填全部数量。',
    ),
    errorNode,
    actionsRow('确认平仓', {
      danger: true,
      onConfirm: (btn) => {
        void submitTool(
          btn,
          errorNode,
          'close_holding',
          { holdingId: holding.id },
          `已平仓 ${holding.stockId}`,
        );
      },
    }),
  ]);
  openModal(`平仓 · ${holding.stockName}（${holding.stockId}）`, body);
};
