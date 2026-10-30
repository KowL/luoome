export const dailyCycleAvailable = (profile) =>
  Boolean(
    profile?.accountId &&
      profile.policies?.some((policy) => policy.name === 'run_strategy_daily_cycle'),
  );

const counts = (summary = {}) =>
  `完成 ${summary.complete ?? 0} · 部分 ${summary.partial ?? 0} · 跳过 ${summary.skipped ?? 0} · 失败 ${summary.failed ?? 0}`;

export const dailyCycleResult = (operation) => {
  if (!operation) return null;
  if (['preparing', 'executing', 'unknown'].includes(operation.state))
    return { tone: 'warn', text: '日循环结果待核对，请勿重复执行。' };
  if (operation.state === 'failed')
    return { tone: 'bad', text: '日循环操作失败，请核对原操作回执。' };
  if (operation.state !== 'succeeded') return null;
  const result = operation.result;
  if (result?.ok === false)
    return { tone: 'bad', text: result.error?.message ?? '日循环操作失败，请核对原操作回执。' };
  const data = result?.data;
  if (!data?.outcome) return { tone: 'quiet', text: '操作已完成，业务结果待核对。' };
  const summary = counts(data.summary);
  switch (data.outcome) {
    case 'due':
      return { tone: 'ok', text: `日循环已执行：${summary}` };
    case 'partial':
      return { tone: 'warn', text: `日循环部分完成：${summary}` };
    case 'failed':
      return { tone: 'bad', text: `日循环失败：${summary}。${data.reason ?? ''}` };
    case 'skipped':
      return { tone: 'warn', text: `未满足执行门槛，已跳过：${data.reason ?? ''}` };
    default:
      return { tone: 'quiet', text: `业务结果待核对：${summary}` };
  }
};

/** 收盘批处理补跑：与日循环同一范式（纯判定 + 一张卡 + 一条 Operation 回执）。 */
export const closingBatchAvailable = (profile) =>
  Boolean(
    profile?.accountId &&
      profile.policies?.some((policy) => policy.name === 'run_closing_report_cutoff'),
  );

export const closingBatchResult = (operation) => {
  if (!operation) return null;
  if (['preparing', 'executing', 'unknown'].includes(operation.state))
    return { tone: 'warn', text: '收盘批处理结果待核对，请勿重复执行。' };
  if (operation.state === 'failed')
    return { tone: 'bad', text: '收盘批处理失败，请核对原操作回执。' };
  if (operation.state !== 'succeeded') return null;
  const result = operation.result;
  if (result?.ok === false)
    return { tone: 'bad', text: result.error?.message ?? '收盘批处理失败，请核对原操作回执。' };
  const data = result?.data;
  if (!data) return { tone: 'quiet', text: '操作已完成，业务结果待核对。' };
  if (data.outcome === 'skipped')
    return { tone: 'warn', text: `未执行收盘批处理：${data.reason ?? '非交易日'}` };
  if (data.outcome === 'failed')
    return { tone: 'bad', text: `收盘批处理失败：${data.reason ?? '请核对操作回执'}` };
  const summary = data.summary ?? {};
  const created = Number(summary.created ?? 0);
  const failed = Number(summary.failed ?? 0);
  return {
    tone: data.outcome === 'partial' || failed > 0 ? 'warn' : 'ok',
    text: `收盘批处理完成（${summary.date ?? '—'}）：生成 ${created} 份报告，失败 ${failed} 份。`,
  };
};
