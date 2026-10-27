import { strategyText } from './projection.js';

const errorKinds = {
  permission_denied: '当前账户或能力未获授权。',
  invalid_input: '参数未通过校验，请核对版本、日期与股票范围。',
  not_found: '所选记录已不可用，请重新读取。',
  conflict: '研究状态已有新修订，请重新读取后合并。',
  unavailable: '此能力或所需数据暂时不可用。',
  adapter_error: '数据源暂时不可用，请保留当前研究后重试。',
};

export const researchErrorText = (error) =>
  strategyText(error?.message ?? errorKinds[error?.kind] ?? '暂时无法完成，请重试读取。');

export const unwrapResearchResult = (result) => {
  if (result?.ok === true) return result.data;
  const error = new Error(researchErrorText(result?.error));
  error.kind = result?.error?.kind;
  throw error;
};

export const researchUrl = (view, strategyId, parameters = {}) => {
  const query = new URLSearchParams({ view });
  if (strategyId) query.set('strategyId', strategyId);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  return `api/luoome/research?${query}`;
};

export const requestResearch = async (path, { body, signal, fetcher = globalThis.fetch } = {}) => {
  const response = await fetcher(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('未收到完整响应。写入或试跑操作请先核对原回执，避免重复提交。');
  }
  if (!response.ok || result?.ok !== true) {
    const error = new Error(researchErrorText(result?.error));
    error.kind = result?.error?.kind;
    throw error;
  }
  return result.data;
};

export const researchExportJson = (exported) => JSON.stringify(exported, null, 2);

export const operationResult = (operation) =>
  operation?.state === 'succeeded' && operation.result?.ok === true ? operation.result.data : null;

export const operationIsUnsettled = (operation) =>
  ['preparing', 'pending', 'executing', 'unknown'].includes(operation?.state);

export const keepOperationCredential = (previous, next) =>
  next.state === 'pending' &&
  previous?.operationId === next.operationId &&
  previous.confirmationToken
    ? { ...next, confirmationToken: previous.confirmationToken }
    : next;
