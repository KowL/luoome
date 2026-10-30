// T48 数据恢复 UI 的纯逻辑：不做 DOM、不发请求，只把服务端契约翻成可渲染的行与判定。
// 单测直接覆盖这里，浏览器旅程覆盖真实渲染。

export const IMPORT_MODE = 'restore-business-v1';
export const IMPORT_SESSION_KEY = 'luoome-import-session';

/** sessionStorage 白名单：只留 operationId/requestId/摘要，绝不存凭证或原始文件。 */
const SESSION_FIELDS = ['operationId', 'requestId', 'archiveDigest', 'previewHash', 'state'];

export const readImportSession = (storage) => {
  try {
    const raw = storage.getItem(IMPORT_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const session = {};
    for (const field of SESSION_FIELDS)
      if (typeof parsed[field] === 'string') session[field] = parsed[field];
    return session.operationId ? session : null;
  } catch {
    return null;
  }
};

export const writeImportSession = (storage, session) => {
  const slim = {};
  for (const field of SESSION_FIELDS)
    if (typeof session?.[field] === 'string') slim[field] = session[field];
  storage.setItem(IMPORT_SESSION_KEY, JSON.stringify(slim));
  return slim;
};

export const clearImportSession = (storage) => storage.removeItem(IMPORT_SESSION_KEY);

/**
 * failed 是终态：同一 operationId 不会重跑，必须换新 id 重新预检提交。
 * 这里显式返回 false，UI 据此清掉旧 id 而不是静默复用。
 */
export const canReuseSession = (session) =>
  session !== null && session !== undefined && session.state !== 'failed';

const countLabel = (count) => (count === undefined ? '—' : String(count));

/** 逐表行：按表名排序，标出 policy 与校验级别，structural-only 单独可见。 */
export const previewTableRows = (preview) => {
  const counts = preview?.counts ?? {};
  const validation = preview?.validation ?? {};
  return Object.keys(counts)
    .sort()
    .map((table) => ({
      table,
      policy: counts[table]?.policy ?? '—',
      validation: validation[table] ?? 'structural',
      source: countLabel(counts[table]?.source),
      current: countLabel(counts[table]?.current),
      expected: countLabel(counts[table]?.expected),
      delta: `${counts[table]?.inserted ?? 0}/${counts[table]?.updated ?? 0}/${counts[table]?.deleted ?? 0}`,
    }));
};

/** 结构校验表清单（Lead 裁定 round-15 §4.1 必须披露）。 */
export const structuralOnlyTables = (preview) => [...(preview?.structuralOnly ?? [])].sort();

export const importLimitations = (preview) => [...(preview?.limitations ?? [])];

/** 提交按钮的可用性判定；reason 用于渲染禁用原因，不做隐式降级。 */
export const importDecision = ({ preview, backup, busy, submitting }) => {
  if (busy) return { disabled: true, reason: '正在上传、预检或备份…' };
  if (submitting) return { disabled: true, reason: '提交中，请勿重复点击' };
  if (!preview) return { disabled: true, reason: '请先选择并预检快照' };
  // 备份必须由服务端生成：没有备份记录就不允许提交（不是勾选框）。
  if (!backup?.backupId) return { disabled: true, reason: '请先生成恢复前一致性备份' };
  return { disabled: false, reason: '' };
};

/** 备份记录摘要（服务端返回，UI 只展示有界字段）。 */
export const backupSummary = (backup) =>
  backup?.backupId
    ? {
        backupId: backup.backupId,
        digest: digestLabel(backup.digest),
        size: typeof backup.size === 'number' ? Math.max(1, Math.round(backup.size / 1024)) : 0,
        createdAt: typeof backup.createdAt === 'number' ? backup.createdAt : null,
      }
    : null;

/** Operation 回执摘要：只暴露有界字段。 */
export const importReceipt = (operation) => {
  if (!operation || typeof operation !== 'object') return null;
  // Operation.result 是内核保存的 ToolResult：成功载荷在 data 里，失败说明在 error 里。
  const result = operation.result && typeof operation.result === 'object' ? operation.result : {};
  const payload = result.data && typeof result.data === 'object' ? result.data : {};
  return {
    operationId: typeof operation.operationId === 'string' ? operation.operationId : '',
    state: typeof operation.state === 'string' ? operation.state : 'unknown',
    requestId: typeof payload.requestId === 'string' ? payload.requestId : '',
    archiveDigest: typeof payload.archiveDigest === 'string' ? payload.archiveDigest : '',
    committedAt: typeof payload.committedAt === 'number' ? payload.committedAt : null,
    postDigest: typeof payload.postDigest === 'string' ? payload.postDigest : '',
    actual: payload.actual && typeof payload.actual === 'object' ? payload.actual : {},
    error: typeof result.error?.message === 'string' ? result.error.message : '',
  };
};

export const digestLabel = (digest) =>
  typeof digest === 'string' && digest.length >= 16 ? `${digest.slice(0, 12)}…` : '—';
