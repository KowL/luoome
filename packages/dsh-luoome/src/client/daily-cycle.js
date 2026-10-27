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
