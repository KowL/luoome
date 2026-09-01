import { callApi } from './api.js';
import { changeClass } from './market-shared.js';
import { closeModal, confirmDialog, openModal, promptDialog } from './modal.js';
import { stockIdentityLink } from './stock-link.js';
import {
  $,
  createPagination,
  el,
  fmtDateTime,
  fmtNum,
  fmtSigned,
  mount,
  sortableHeader,
} from './ui.js';

export {
  $,
  callApi,
  changeClass,
  closeModal,
  confirmDialog,
  createPagination,
  el,
  fmtDateTime,
  fmtNum,
  fmtSigned,
  mount,
  openModal,
  promptDialog,
  sortableHeader,
  stockIdentityLink,
};

export const STRATEGY_STATUS = {
  active: ['运行中', 'badge-active'],
  draft: ['草稿', 'badge-draft'],
  paused: ['已暂停', 'badge-paused'],
  archived: ['已归档', 'badge-neutral'],
};

export const RUN_STATUS = {
  complete: ['已完成', 'badge-active'],
  partial: ['已完成（历史）', 'badge-important'],
  failed: ['失败', 'badge-pos'],
  running: ['运行中', 'badge-neutral'],
};

export const RUN_SCOPE = {
  operational: ['生产', 'badge-active'],
  evaluation: ['历史评估', 'badge-neutral'],
};

export const PUBLICATION_STATUS = {
  published: ['已发布', 'badge-active'],
  withheld: ['暂不发布', 'badge-important'],
  'non-publishing': ['不进入当前', 'badge-neutral'],
};

export const DATA_HEALTH = {
  complete: '完整',
  partial: '部分可用',
  unavailable: '不可用',
};

export const RULE_STATUS = {
  matched: ['命中', 'badge-active'],
  'not-matched': ['未命中', 'badge-neutral'],
  unknown: ['数据缺失', 'badge-important'],
  error: ['求值错误', 'badge-pos'],
};

export const RESULT_VIEW_STATUS = {
  selected: ['入选', 'badge-active'],
  incomplete: ['数据不完整', 'badge-important'],
  excluded: ['未入选', 'badge-neutral'],
};

export const errorText = (result, fallback = '请求失败') => {
  const error = result?.error;
  if (error === undefined) return fallback;
  if (error.message) return error.message;
  if (error.cause) return error.cause;
  if (error.entity) return `${error.entity}不存在`;
  return error.kind ?? fallback;
};

export const createFeatureCache = () => {
  const responseCache = new Map();
  const cachedGet = async (path) => {
    if (responseCache.has(path)) return responseCache.get(path);
    const pending = callApi(path);
    responseCache.set(path, pending);
    const result = await pending;
    if (!result.ok) responseCache.delete(path);
    return result;
  };
  return {
    cachedGet,
    delete: (path) => responseCache.delete(path),
    clear: () => responseCache.clear(),
  };
};

export const post = (path, body) => callApi(path, { method: 'POST', body: JSON.stringify(body) });

export const badge = (config, fallback) =>
  el('span', `badge ${config?.[1] ?? 'badge-neutral'}`, config?.[0] ?? fallback);

export const metric = (label, value, note = '') =>
  el('div', 'strategy-metric', [
    el('span', 'strategy-metric-label', label),
    el('strong', 'strategy-metric-value', value === undefined ? '--' : String(value)),
    ...(note.length === 0 ? [] : [el('small', null, note)]),
  ]);

export const cloneDefinition = (definition) => {
  if (definition === undefined || definition === null) return undefined;
  return JSON.parse(JSON.stringify(definition));
};
