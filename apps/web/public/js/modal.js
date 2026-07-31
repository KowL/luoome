/* apps/web/public/js/modal.js —— 全局共享弹窗。
 * 基础 openModal/closeModal（复用 index.html 的 #modal-overlay 结构），
 * 以及替换浏览器原生 prompt/confirm/alert 的样式化对话框。
 * 样式沿用 style.css 的 modal / field / btn 体系，不新增 CSS。 */

// biome-ignore lint/suspicious/noRedundantUseStrict: 模块默认严格模式
'use strict';

import { $, el } from './ui.js';

export const openModal = (title, body) => {
  const titleNode = $('#modal-title');
  const bodyNode = $('#modal-body');
  const overlay = $('#modal-overlay');
  if (titleNode === null || bodyNode === null || overlay === null) return;
  titleNode.textContent = title;
  bodyNode.replaceChildren(body);
  overlay.hidden = false;
};

/** 当前对话框的 resolver；同一时间只弹一个对话框，普通表单窗（holdings 等）为 null。 */
let activeResolve = null;

export const closeModal = () => {
  const overlay = $('#modal-overlay');
  if (overlay !== null) overlay.hidden = true;
  // 经 ✕ / overlay / Escape 关闭视为取消，保证对话框 Promise 不悬挂
  if (activeResolve !== null) {
    const resolve = activeResolve;
    activeResolve = null;
    resolve(null);
  }
};

let initialized = false;

/** 绑定关闭交互（✕ / 点遮罩 / Escape）；幂等，app 启动时调一次。 */
export const initModal = () => {
  if (initialized) return;
  initialized = true;
  $('#modal-close')?.addEventListener('click', closeModal);
  $('#modal-overlay')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
};

const settle = (value) => {
  const resolve = activeResolve;
  activeResolve = null;
  const overlay = $('#modal-overlay');
  if (overlay !== null) overlay.hidden = true;
  resolve?.(value);
};

const dialogActions = (confirmLabel, { danger = false, onConfirm } = {}) => {
  const row = el('div', 'modal-actions');
  const cancel = el('button', 'btn btn-outline', '取消');
  cancel.type = 'button';
  cancel.addEventListener('click', () => settle(null));
  const ok = el('button', danger ? 'btn btn-danger' : 'btn btn-primary', confirmLabel);
  ok.type = 'button';
  ok.addEventListener('click', () => onConfirm());
  row.append(cancel, ok);
  return row;
};

/**
 * 确认对话框（替代 window.confirm）。
 * @returns {Promise<boolean>} 确认 true；取消/关闭 false。
 */
export const confirmDialog = ({
  title = '确认操作',
  message,
  confirmLabel = '确定',
  danger = false,
}) =>
  new Promise((resolve) => {
    activeResolve = resolve;
    openModal(
      title,
      el('div', null, [
        el('p', null, message),
        dialogActions(confirmLabel, { danger, onConfirm: () => settle(true) }),
      ]),
    );
  }).then((value) => value === true);

/**
 * 输入对话框（替代 window.prompt，支持多字段与下拉）。
 * fields: [{ key, label, value?, placeholder?, options?: [{ value, label }] }]
 * note: 字段上方的 muted 说明行（可选）。
 * @returns {Promise<object|null>} 确认返回 { key: 文本 }；取消/关闭返回 null。
 */
export const promptDialog = ({ title, fields, confirmLabel = '确定', danger = false, note }) =>
  new Promise((resolve) => {
    activeResolve = resolve;
    const controls = fields.map((field) => {
      const control = field.options === undefined ? el('input') : document.createElement('select');
      if (field.options === undefined) {
        control.type = 'text';
        control.value = field.value ?? '';
        if (field.placeholder !== undefined) control.placeholder = field.placeholder;
      } else {
        for (const option of field.options) {
          const node = document.createElement('option');
          node.value = option.value;
          node.textContent = option.label;
          node.selected = option.value === field.value;
          control.append(node);
        }
      }
      control.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          settle(Object.fromEntries(controls.map(({ key, control: c }) => [key, c.value.trim()])));
        }
      });
      return { key: field.key, control };
    });
    openModal(
      title,
      el('div', null, [
        ...(note === undefined ? [] : [el('p', 'muted', note)]),
        ...controls.map(({ control }, index) => {
          const wrap = el('div', 'field');
          wrap.append(el('label', null, fields[index].label));
          wrap.append(control);
          return wrap;
        }),
        dialogActions(confirmLabel, {
          danger,
          onConfirm: () =>
            settle(
              Object.fromEntries(controls.map(({ key, control }) => [key, control.value.trim()])),
            ),
        }),
      ]),
    );
    controls[0]?.control.focus();
  });

/**
 * 提示对话框（替代 window.alert，用于错误提醒）。
 * @returns {Promise<null>} 关闭即 resolved。
 */
export const alertDialog = (title, message) =>
  new Promise((resolve) => {
    activeResolve = resolve;
    const ok = el('button', 'btn btn-primary', '确定');
    ok.type = 'button';
    ok.addEventListener('click', () => settle(null));
    const row = el('div', 'modal-actions');
    row.append(ok);
    openModal(title, el('div', null, [el('p', 'modal-error', message), row]));
  });
