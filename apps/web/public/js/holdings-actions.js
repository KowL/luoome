/* apps/web/public/js/holdings-actions.js —— 持仓操作弹窗（新增 / 加仓 / 减仓 / 纠错 / 平仓）。
 * 写操作统一走 /api/tools/<name>/call（web 需 LUOOME_EXPOSE_WRITE=true 才放行 write）。
 * 刷新与状态提示通过 initHoldingsActions 注入，避免反向 import pages.js。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { callApi } from './api.js';
import { closeModal, openModal } from './modal.js';
import { $, el, fmtNum } from './ui.js';

/* ============ 依赖注入 ============ */

let onRefresh = async () => {};
let notify = () => {};

export const initHoldingsActions = ({ refresh, setStatus }) => {
  onRefresh = refresh;
  notify = setStatus;
  const snapshotButton = $('#btn-account-snapshot');
  if (snapshotButton !== null && snapshotButton.dataset.bound !== '1') {
    snapshotButton.dataset.bound = '1';
    snapshotButton.addEventListener('click', () => void openAccountSnapshotFromHoldings(setStatus));
    void refreshSnapshotButtonLabel();
  }
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

const makeSelect = (id, options) => {
  const select = el('select');
  select.id = id;
  for (const [value, label] of options) {
    const option = el('option', null, label);
    option.value = value;
    select.append(option);
  }
  return select;
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

const parseNonNegativeInt = (raw) => {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const parseNonNegativeNumber = (raw) => {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * 账户快照状态提示：只有非 complete 或缺失时才需要提醒，complete 不占位。
 */
export const snapshotStatusNotice = (snapshot) => {
  if (snapshot === undefined) {
    return {
      tone: 'warning',
      title: '尚未登记账户快照',
      detail:
        '账户现金与持仓估值是仓位分母；没有快照时盘后计划只能停在草案，盘中监控也没有可求值的计划。',
    };
  }
  if (snapshot.status === 'needs-reconciliation') {
    return {
      tone: 'warning',
      title: '账户快照待核对',
      detail: `v${snapshot.version} 只同步了持仓，现金与持仓未一致：精确仓位与当前可执行建仓建议已暂停。核对现金后再保存一次。`,
    };
  }
  if (snapshot.status === 'unavailable') {
    return {
      tone: 'warning',
      title: '账户事实不可用',
      detail: `v${snapshot.version} 没有可用的现金与持仓估值：无法计算仓位与组合预算，只能保留条件研究。`,
    };
  }
  return null;
};

export const snapshotButtonLabel = (snapshot) => {
  if (snapshot === undefined) return '登记账户快照';
  return snapshot.status === 'complete' ? '更新账户快照' : '核对并保存快照';
};

/**
 * 账户快照表单的服务端错误提示：未入库标的给出可执行的下一步，而不是裸 not_found。
 */
export const snapshotErrorText = (error) => {
  if (
    error !== null &&
    typeof error === 'object' &&
    error.kind === 'not_found' &&
    error.entity === 'Stock'
  ) {
    return `股票 ${error.id} 不在股票目录中：请先在「持仓」页用「+ 新增持仓」登记后重试`;
  }
  return toolErrorText(error);
};

/**
 * 账户快照输入校验（与 save_account_snapshot 的前置规则对齐，可单测）。
 * - complete：必须提供 cashBalance；
 * - needs-reconciliation：现金可选，服务端不提供精确总资产；
 * - unavailable：现金不写入，只保留持仓数量事实。
 * 返回 { input } 或 { error }。
 */
export const buildAccountSnapshotInput = ({
  status = 'complete',
  cashBalance = null,
  note = '',
  positions = [],
} = {}) => {
  if (cashBalance !== null && (!Number.isFinite(cashBalance) || cashBalance < 0)) {
    return { error: '现金余额必须是非负数字' };
  }
  if (status === 'complete' && cashBalance === null) {
    return { error: '「完整」快照必须填写现金余额；只更新了持仓请选「待核对」' };
  }
  const cleaned = [];
  for (const [index, position] of positions.entries()) {
    const label = `第 ${index + 1} 行`;
    if (typeof position.stockId !== 'string' || position.stockId.length === 0) {
      return { error: `${label}：请先选择股票或输入完整带后缀代码` };
    }
    if (!Number.isInteger(position.quantity) || position.quantity < 0) {
      return { error: `${label}：数量必须是非负整数` };
    }
    if (
      !Number.isInteger(position.availableQuantity) ||
      position.availableQuantity < 0 ||
      position.availableQuantity > position.quantity
    ) {
      return { error: `${label}：可卖数量必须是不超过数量的非负整数` };
    }
    if (!Number.isFinite(position.marketValue) || position.marketValue < 0) {
      return { error: `${label}：市值必须是非负数字` };
    }
    cleaned.push({
      stockId: position.stockId,
      quantity: position.quantity,
      availableQuantity: position.availableQuantity,
      marketValue: position.marketValue,
    });
  }
  const trimmedNote = typeof note === 'string' ? note.trim() : '';
  return {
    input: {
      status,
      positions: cleaned,
      ...(cashBalance === null || status === 'unavailable' ? {} : { cashBalance }),
      ...(trimmedNote === '' ? {} : { note: trimmedNote }),
    },
  };
};

export const toolErrorText = (error) => {
  if (error === null || typeof error !== 'object') return '提交失败';
  if (error.kind === 'permission_denied') {
    const required = error.required ?? '当前操作未开启';
    return `权限校验失败：${required}`;
  }
  const detail = error.message ?? error.cause ?? '';
  return detail === '' ? String(error.kind) : `${error.kind}：${detail}`;
};

/** fetch_quote 返回 { quote }；集中解析，避免 UI 误读不存在的 data.price。 */
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
/* ============ 账户快照（save_account_snapshot） ============ */

/**
 * 账户快照登记：现金 + 持仓估值 → 新的账户事实版本。
 * 只写账户事实，不生成建议、不改变持仓；现金与持仓估值必须来自同一次核对。
 * 传入 latest 时预填上一版快照：快照是整体替换，不预填等于默认清空已有持仓。
 * 持仓标的需已在股票目录中（未入库的股票先在「持仓」页登记）。
 */
export const openAccountSnapshotModal = ({ onSaved, latest } = {}) => {
  const cashInput = makeInput('snapshot-cash', {
    type: 'number',
    placeholder: '当前现金余额（元）',
    value:
      latest?.cashBalance === null || latest?.cashBalance === undefined
        ? ''
        : String(latest.cashBalance),
  });
  const statusSelect = makeSelect('snapshot-status', [
    ['complete', '完整（现金与持仓已核对）'],
    ['needs-reconciliation', '待核对（只更新了持仓）'],
    ['unavailable', '不可用（资金与持仓都无法核对）'],
  ]);
  if (latest?.status !== undefined) statusSelect.value = latest.status;
  const noteInput = makeInput('snapshot-note', {
    placeholder: '可选：核对说明',
    value: latest?.note ?? '',
  });
  const rowsRoot = el('div', 'snapshot-rows');
  const rows = [];
  const errorNode = el('p', 'modal-error');
  const statusHint = el('span', 'hint', '');

  /** 状态决定现金与总资产是否可用；「不可用」时不写入现金，避免写下无法核对的事实。 */
  const syncStatusState = () => {
    const status = statusSelect.value;
    cashInput.disabled = status === 'unavailable';
    statusHint.textContent =
      status === 'complete'
        ? '必须填写现金余额；总资产 = 现金 + 持仓市值，由服务端计算'
        : status === 'needs-reconciliation'
          ? '现金可选；待核对快照保留现金与持仓事实，但不提供精确总资产，精确仓位与可建仓建议会暂停'
          : '现金不写入；只保留持仓数量与不可用状态';
  };
  statusSelect.addEventListener('change', syncStatusState);

  const addRow = (position) => {
    const index = rows.length + 1;
    const stockInput = makeInput(`snapshot-stock-${index}`, {
      placeholder: '代码或名称，如 601398 / 工商银行',
      value: position?.stockId ?? '',
    });
    const acList = el('div', 'autocomplete-list');
    acList.hidden = true;
    const acWrap = el('div', 'autocomplete', [stockInput, acList]);
    const qtyInput = makeInput(`snapshot-qty-${index}`, {
      type: 'number',
      placeholder: '数量（股）',
      value: position === undefined ? '' : String(position.quantity),
    });
    const availInput = makeInput(`snapshot-avail-${index}`, {
      type: 'number',
      placeholder: '可卖数量（可空，默认=数量）',
      value: position === undefined ? '' : String(position.availableQuantity),
    });
    const valueInput = makeInput(`snapshot-value-${index}`, {
      type: 'number',
      placeholder: '当前市值（元）',
      value: position === undefined ? '' : String(position.marketValue),
    });
    const picker = attachStockPicker({
      input: stockInput,
      list: acList,
      unknownHint: '（未入库，需先在「持仓」页登记）',
    });
    const rowState = { picker, qtyInput, availInput, valueInput };
    const row = el('div', 'snapshot-row', [
      el('div', 'field', [el('label', null, '股票'), acWrap]),
      el('div', 'field', [el('label', null, '数量'), qtyInput]),
      el('div', 'field', [el('label', null, '可卖'), availInput]),
      el('div', 'field', [el('label', null, '市值'), valueInput]),
    ]);
    const remove = el('button', 'btn btn-outline btn-sm', '移除');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      rows.splice(rows.indexOf(rowState), 1);
      row.remove();
    });
    row.append(remove);
    rows.push(rowState);
    rowsRoot.append(row);
  };

  // 有上一版快照时按其持仓预填，不再额外留一行空行。
  const initialPositions = latest?.positions ?? [];
  if (initialPositions.length === 0) addRow();
  for (const position of initialPositions) addRow(position);
  const addButton = el('button', 'btn btn-outline btn-sm', '+ 添加持仓');
  addButton.type = 'button';
  addButton.addEventListener('click', () => addRow());

  const collect = () =>
    buildAccountSnapshotInput({
      status: statusSelect.value,
      cashBalance: (() => {
        const raw = cashInput.value.trim();
        if (raw === '' || statusSelect.value === 'unavailable') return null;
        const parsed = parseNonNegativeNumber(raw);
        return parsed === null ? Number.NaN : parsed;
      })(),
      note: noteInput.value,
      positions: rows.map((row) => {
        const quantity = parseNonNegativeInt(row.qtyInput.value.trim());
        const rawAvailable = row.availInput.value.trim();
        const availableQuantity =
          rawAvailable === '' ? quantity : parseNonNegativeInt(rawAvailable);
        const marketValue = parseNonNegativeNumber(row.valueInput.value.trim());
        return {
          stockId: row.picker.resolve() ?? '',
          quantity: quantity ?? Number.NaN,
          availableQuantity: availableQuantity ?? Number.NaN,
          marketValue: marketValue ?? Number.NaN,
        };
      }),
    });

  const body = el('div', null, [
    fieldWrap('现金余额', cashInput, '总资产 = 现金 + 持仓市值；两者必须同一次核对'),
    el('div', 'field', [el('label', null, '快照状态'), statusSelect, statusHint]),
    fieldWrap(
      '持仓',
      rowsRoot,
      latest?.positions?.length
        ? '市值是当前估值，不是买入成本；已按上一版快照预填，确认后再保存'
        : '市值是当前估值，不是买入成本',
    ),
    addButton,
    fieldWrap('备注', noteInput),
    errorNode,
    actionsRow('保存快照', {
      onConfirm: (btn) => {
        const collected = collect();
        if (collected.error !== undefined) {
          errorNode.textContent = collected.error;
          return;
        }
        void submitTool(
          btn,
          errorNode,
          'save_account_snapshot',
          collected.input,
          '账户快照已保存',
          { onSuccess: onSaved ?? onRefresh, formatError: snapshotErrorText },
        );
      },
    }),
  ]);
  syncStatusState();
  openModal('登记账户快照', body);
};

/**
 * 持仓页「账户快照」按钮文案跟随最新快照状态：缺失=登记、待核对/不可用=核对并保存、完整=更新。
 */
const refreshSnapshotButtonLabel = async () => {
  const button = $('#btn-account-snapshot');
  if (button === null) return;
  const result = await callApi('/api/account/snapshots?limit=1');
  const latest = result.ok ? (result.data?.snapshots ?? [])[0] : undefined;
  button.textContent = snapshotButtonLabel(latest);
  const needsAttention = latest !== undefined && latest.status !== 'complete';
  button.classList.toggle('btn-primary', needsAttention);
  button.classList.toggle('btn-outline', !needsAttention);
};

/** 持仓页入口：先读最新快照（供整体替换前预填），再打开登记窗。 */
const openAccountSnapshotFromHoldings = async (setStatus) => {
  const result = await callApi('/api/account/snapshots?limit=1');
  if (!result.ok) {
    setStatus(toolErrorText(result.error), true);
    return;
  }
  const latest = (result.data?.snapshots ?? [])[0];
  openAccountSnapshotModal({
    ...(latest === undefined ? {} : { latest }),
    onSaved: async () => {
      await onRefresh();
      await refreshSnapshotButtonLabel();
    },
  });
};
