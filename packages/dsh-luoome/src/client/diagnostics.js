// T14 诊断读模型的纯展示层：不做 DOM、不发请求，便于用三类坏数据直接单测。
// 每条结论必须能追溯到「表名.字段名 + 日期」；缺日期时显示「从未」，不编造时间。

export const DIAGNOSTIC_CODE_LABELS = Object.freeze({
  'market-quote-missing': '缺行情',
  'daily-bar-stale': '日线滞后',
  'migration-incomplete': '迁移未完成',
  'source-unavailable': '连接失败',
});

export const DIAGNOSTIC_SEVERITY_LABELS = Object.freeze({
  bad: '阻断',
  warn: '警告',
});

const asText = (value) => (typeof value === 'string' && value.length > 0 ? value : '');

/** 日期：只到秒，空值显式「从未」。 */
export const diagnosticDate = (value) => {
  const text = asText(value);
  if (!text) return '从未';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return '从未';
  return date.toISOString().slice(0, 19).replace('T', ' ');
};

export const diagnosticRows = (diagnostics) =>
  (diagnostics?.findings ?? []).map((finding, index) => ({
    key: `${finding.code}:${finding.table}:${finding.field}:${String(index)}`,
    code: finding.code,
    label: DIAGNOSTIC_CODE_LABELS[finding.code] ?? finding.code,
    severity: finding.severity === 'bad' ? 'bad' : 'warn',
    severityLabel: DIAGNOSTIC_SEVERITY_LABELS[finding.severity] ?? '警告',
    subject: `${asText(finding.table)}.${asText(finding.field)}`,
    at: diagnosticDate(finding.at),
    message: asText(finding.message),
  }));

/** 顶部摘要：条数与最严重级别。 */
export const diagnosticsSummary = (diagnostics) => {
  const rows = diagnosticRows(diagnostics);
  if (rows.length === 0) return { tone: 'ok', text: '未发现数据问题。' };
  const blocking = rows.filter((row) => row.severity === 'bad').length;
  return {
    tone: blocking > 0 ? 'bad' : 'warn',
    text:
      blocking > 0
        ? `${String(rows.length)} 条诊断，其中 ${String(blocking)} 条需要处理。`
        : `${String(rows.length)} 条诊断，均为警告。`,
  };
};
