/* apps/web/public/js/holdings-actions.js —— 持仓操作弹窗（新增 / 加仓 / 减仓 / 纠错 / 平仓）。
 * 写操作统一走 /api/tools/<name>/call（web 需 LUOOME_EXPOSE_WRITE=true 才放行 write）。
 * 刷新与状态提示通过 initHoldingsActions 注入，避免反向 import pages.js。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import {
  actionsRow,
  fieldWrap,
  makeInput,
  parsePositiveInt,
  parsePositiveNumber,
} from './form-kit.js';
import { closeModal, openModal } from './modal.js';
import { el, fmtNum, toolErrorText } from './ui.js';

/* ============ 依赖注入 ============ */

let onRefresh = async () => {};
let notify = () => {};

export const initHoldingsActions = ({ refresh, setStatus }) => {
  onRefresh = refresh;
  notify = setStatus;
};

const STOCK_ID_PATTERN = /^[A-Z0-9]{1,12}\.(SH|SZ|BJ|HK|US)$/;

/**
 * 账户快照状态提示：只有非 complete 或缺失时才需要提醒，complete 不占位。
 */
export const quotePriceFromResult = (result) => {
  const price = result?.ok ? result.data?.quote?.close : undefined;
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
};

/**
 * 提交公共流程：禁用按钮 → 调 tool → 失败上屏 / 成功关窗 + 刷新 + 状态提示。
 * onSuccess 缺省用注入的 refresh；formatError 可换成更具体的提示文案。
 */
const submitTool = async (
  btn,
  errorNode,
  name,
  input,
  successMessage,
  { onSuccess = onRefresh, formatError = toolErrorText } = {},
) => {
  btn.disabled = true;
  errorNode.textContent = '';
  try {
    const r = await callApi(`/api/tools/${name}/call`, {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
    if (!r.ok) {
      errorNode.textContent = formatError(r.error);
      return;
    }
    closeModal();
    await onSuccess();
    notify(successMessage);
  } catch (error) {
    errorNode.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    btn.disabled = false;
  }
};

/* ============ 通用确认弹窗（如重复分析前的有效期提示） ============ */

/** 轻量确认弹窗：确认后关窗并执行 onConfirm。 */
export const openConfirmModal = ({ title, message, confirmLabel = '确认', onConfirm }) => {
  const body = el('div', null, [
    el('p', 'hint', message),
    actionsRow(confirmLabel, {
      onConfirm: () => {
        closeModal();
        onConfirm();
      },
    }),
  ]);
  openModal(title, body);
};

/* ============ 新增持仓（add_trade buy，建仓即写交易） ============ */

/**
 * 股票输入框的检索行为：search_stocks 只查本地股票库，未入库的代码按位数给出后缀候选。
 * 选中后经 onSelect 通知调用方；resolve() 返回当前可用的股票 id。
 * unknownHint 由调用方决定：建仓会自动登记 stub，账户快照则需要先登记。
 */
const attachStockPicker = ({ input, list, onSelect, unknownHint = '（未入库）' }) => {
  let selected = { id: '', name: '' };
  let timer = 0;

  const pick = (id, label, name = '') => {
    selected = { id, name };
    input.value = label;
    list.hidden = true;
    onSelect?.(id, name);
  };

  /** 代码形态输入的兜底候选：未入库的标的按位数给出交易所后缀建议。 */
  const syntheticCandidates = (q) => {
    if (/^\d{6}$/.test(q)) return [`${q}.SH`, `${q}.SZ`];
    if (/^\d{4,5}$/.test(q)) return [`${q}.HK`];
    if (/^[A-Za-z]{1,5}$/.test(q)) return [`${q.toUpperCase()}.US`];
    return [];
  };

  input.addEventListener('input', () => {
    selected = { id: '', name: '' };
    window.clearTimeout(timer);
    const q = input.value.trim();
    if (q.length === 0) {
      list.hidden = true;
      return;
    }
    // 已输入完整带后缀代码：直接当选定，不再检索。
    if (STOCK_ID_PATTERN.test(q.toUpperCase())) {
      list.hidden = true;
      onSelect?.(q.toUpperCase(), '');
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
          item.addEventListener('click', () => pick(s.id, `${s.id} ${s.name}`, s.name));
          return item;
        });
        // 库内无结果时才给代码后缀兜底候选（外部源已接入，真实候选优先）
        const extras =
          stocks.length === 0
            ? syntheticCandidates(q).map((id) => {
                const item = el('div', 'autocomplete-item', `${id} ·${unknownHint}`);
                item.addEventListener('click', () => pick(id, id));
                return item;
              })
            : [];
        const all = [...items, ...extras];
        if (all.length === 0) {
          list.hidden = true;
          return;
        }
        list.replaceChildren(...all);
        list.hidden = false;
      })();
    }, 300);
  });

  return {
    resolve: () => {
      if (selected.id.length > 0) return selected.id;
      const first = input.value.trim().toUpperCase().split(/\s+/)[0] ?? '';
      return STOCK_ID_PATTERN.test(first) ? first : null;
    },
    selectedName: () => selected.name,
  };
};

export const openAddHoldingModal = () => {
  const stockInput = makeInput('f-stock', { placeholder: '代码或名称，如 601398 / 比亚迪' });
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

  const picker = attachStockPicker({
    input: stockInput,
    list: acList,
    onSelect: (id, name) => fillCurrentPrice(id, name),
    unknownHint: '（未入库，建仓时自动登记）',
  });

  const resolveStockId = () => picker.resolve();

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
            ...(picker.selectedName().length > 0 ? { stockName: picker.selectedName() } : {}),
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
