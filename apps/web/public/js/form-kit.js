/* apps/web/public/js/form-kit.js —— 共享表单小件。
 *
 * 原生 HTML/JS 下每个弹窗都要拼 input/select/字段/操作行；这里统一一份，
 * 避免 holdings-actions / target-pages / settings 各写一套导致行为（校验、按钮顺序、
 * 取消语义）逐渐分叉。纯 DOM 构造，不含业务校验。
 */

import { closeModal } from './modal.js';
import { el } from './ui.js';

export const makeInput = (id, { type = 'text', value = '', placeholder = '' } = {}) => {
  const input = el('input');
  input.id = id;
  input.type = type;
  if (placeholder.length > 0) input.placeholder = placeholder;
  if (value.length > 0) input.value = value;
  return input;
};

export const makeSelect = (id, options) => {
  const select = el('select');
  select.id = id;
  for (const [value, label] of options) {
    const option = el('option', null, label);
    option.value = value;
    select.append(option);
  }
  return select;
};

export const makeTextarea = (id, { rows = 4, value = '', placeholder = '' } = {}) => {
  const textarea = el('textarea');
  textarea.id = id;
  textarea.rows = rows;
  if (placeholder.length > 0) textarea.placeholder = placeholder;
  if (value.length > 0) textarea.value = value;
  return textarea;
};

/** 字段：label + 控件 + 可选提示（hint 可为字符串或节点）。 */
export const fieldWrap = (label, control, hint) => {
  const node = el('div', 'field');
  node.append(el('label', null, label));
  node.append(control);
  if (hint !== undefined) node.append(el('span', 'hint', hint));
  return node;
};

/** 弹窗操作行：取消（关闭弹窗）+ 确认（回调收到按钮本身，便于禁用/恢复）。 */
export const actionsRow = (confirmLabel, { danger = false, onConfirm } = {}) => {
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

const parseInteger = (raw, predicate) => {
  const n = Number(raw);
  return Number.isInteger(n) && predicate(n) ? n : null;
};

const parseNumber = (raw, predicate) => {
  const n = Number(raw);
  return Number.isFinite(n) && predicate(n) ? n : null;
};

export const parsePositiveInt = (raw) => parseInteger(raw, (n) => n > 0);
export const parseNonNegativeInt = (raw) => parseInteger(raw, (n) => n >= 0);
export const parsePositiveNumber = (raw) => parseNumber(raw, (n) => n > 0);
export const parseNonNegativeNumber = (raw) => parseNumber(raw, (n) => n >= 0);
