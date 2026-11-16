import {
  notificationText,
  notificationTime,
  type Report,
  type ReportBlock,
  type ReportSection,
  type ReportValue,
  STANDARD_DISCLAIMERS,
} from '@luoome/core';

const number = (value: number): string =>
  value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const money = (value: number): string =>
  value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const valueText = (value: ReportValue): string =>
  value === null
    ? '暂无数据'
    : typeof value === 'number'
      ? number(value)
      : typeof value === 'string' &&
          /^\d{4}-\d{2}-\d{2}T/.test(value) &&
          !Number.isNaN(Date.parse(value))
        ? `${notificationTime(new Date(value))}（北京时间）`
        : notificationText(String(value));
// 飞书仅投递公共研究板块；新增板块需明确加入，账户事实留在完整报告中。
const notificationSections = new Set([
  'market-pulse',
  'market-week',
  'strategy-actions',
  'strategy-review',
  'signal-outcomes',
  'strategy-autonomy-actions',
  'important-triggers',
  'alert-feedback',
  'upcoming-events',
  'next-events',
  'next-week-events',
  'alert-plans',
]);

const lists = (section: ReportSection) =>
  section.blocks.flatMap((block) => (block.kind === 'list' ? block.items : []));
const rows = (section: ReportSection) =>
  section.blocks.flatMap((block) => (block.kind === 'table' ? block.rows : []));
const fallbackItem = (item: ReturnType<typeof lists>[number]): boolean =>
  /LLM 推理不可用|规则 fallback|AI 分析未完成/.test(
    `${item.notificationSummary ?? ''} ${item.detail ?? ''}`,
  );

const metricLabel = (key: string, label: string): string =>
  ({
    totalPnl: '账本累计盈亏',
    twrPct: '组合收益率',
    benchmarkTwrPct: '基准收益率',
    periodTwrPct: '区间收益率',
  })[key] ?? label;

const metricLines = (block: Extract<ReportBlock, { kind: 'metrics' }>): string[] => {
  const monetaryKeys = new Set(['totalValue', 'periodStartValue', 'todayPnl', 'totalPnl']);
  return block.items
    .filter((item) => item.value !== null)
    .map((item) => {
      const label = metricLabel(item.key, item.label);
      const value = item.value;
      const formatted =
        item.displayValue ??
        (typeof value === 'number'
          ? monetaryKeys.has(item.key)
            ? `${item.key === 'todayPnl' && value > 0 ? '+' : ''}${money(value)} 元`
            : item.unit === 'ratio'
              ? `${(value * 100).toFixed(1)}%`
              : `${number(value)}${item.unit ?? ''}`
          : valueText(value));
      return `${label} ${formatted}`;
    });
};

const sectionLines = (section: ReportSection): string[] => {
  if (section.status === 'unavailable') return ['数据暂不可用，请稍后查看完整报告。'];
  const items = lists(section);
  const tableRows = rows(section);
  if (section.key === 'strategy-actions') {
    const fallback = items.filter(fallbackItem);
    const adviceItems = items.filter((item) => item.entityKind === 'advice' && !fallbackItem(item));
    const candidates = items.filter((item) => item.entityKind === 'stock');
    const notRun = tableRows.filter((row) => row.analysis === '今日未运行');
    return [
      ...(fallback.length === 0
        ? []
        : [
            `⚠️ ${fallback.length} 条 AI 分析未完成，仅有规则兜底，不形成交易判断。`,
            fallback
              .slice(0, 5)
              .map((item) => notificationText(item.title, 20))
              .filter(Boolean)
              .join('、') + (fallback.length > 5 ? ' 等' : ''),
          ]),
      ...(notRun.length === 0 ? [] : [`${notRun.length} 个策略今日未运行；未分析不等于没有机会。`]),
      ...tableRows
        .filter((row) => row.analysis !== '今日未运行')
        .slice(0, 4)
        .map(
          (row) =>
            `${valueText(row.strategy ?? null)}：${notificationText(String(row.analysis ?? '分析状态待核对'), 100)}`,
        ),
      ...adviceItems.slice(0, 2).map(
        (item) =>
          `**${notificationText(item.title, 30)}**\n${
            item.notificationSummary
              ?.split('\n')
              .filter((line) => !line.startsWith('目标仓位 '))
              .join('\n') ?? '请在应用中核对结论、反证、风险和有效期。'
          }`,
      ),
      ...(adviceItems.length > 2 ? [`另有 ${adviceItems.length - 2} 条建议，见完整报告。`] : []),
      ...(candidates.length === 0 ? [] : [`${candidates.length} 条候选事实尚未形成建议。`]),
      ...(items.length === 0 && tableRows.length === 0 ? ['暂无策略分析结果。'] : []),
    ];
  }
  if (section.key === 'important-triggers') {
    if (items.length === 0) return ['当日暂无预警记录。'];
    return [
      `当日记录 ${items.length} 条预警`,
      ...[...items]
        .sort(
          (a, b) => Number(b.detail?.startsWith('urgent')) - Number(a.detail?.startsWith('urgent')),
        )
        .slice(0, 3)
        .map(
          (item) =>
            `${notificationText(item.title.split(' · ')[0] ?? '', 30)} · ${item.notificationSummary ?? '送达与处理状态见应用'}`,
        ),
      ...(items.length > 3 ? ['其余预警见完整报告。'] : []),
    ];
  }
  const output: string[] = [];
  for (const block of section.blocks) {
    if (block.kind === 'metrics') output.push(...metricLines(block));
    if (block.kind === 'text') {
      const text = notificationText(block.text, 150);
      if (text.length > 0) output.push(text);
    }
    if (block.kind === 'list') {
      output.push(
        ...block.items.slice(0, 4).map((item) => {
          const title = notificationText(item.title, 65);
          if (item.entityKind === 'advice')
            return title.length > 0 ? `${title}：详情请在应用核对。` : '建议详情请在应用核对。';
          return section.key === 'market-pulse'
            ? title
            : `${title}${item.detail === undefined ? '' : ` · ${notificationText(item.detail, 80)}`}`;
        }),
      );
      if (block.items.length > 4) output.push(`其余 ${block.items.length - 4} 项见完整报告。`);
    }
    if (block.kind === 'table') {
      const columns = block.columns
        .filter((column) => !/id$|account|version/i.test(column.key))
        .slice(0, 3);
      output.push(
        ...block.rows
          .slice(0, 3)
          .map((row) =>
            columns
              .map((column) => `${column.label} ${valueText(row[column.key] ?? null)}`)
              .join(' · '),
          ),
      );
      if (block.rows.length > 3) output.push(`其余 ${block.rows.length - 3} 行见完整报告。`);
    }
  }
  const unavailableMetrics = section.blocks.flatMap((block) =>
    block.kind === 'metrics' ? block.items.filter((item) => item.value === null) : [],
  );
  if (unavailableMetrics.length > 0)
    output.push(
      `暂缺：${unavailableMetrics
        .slice(0, 3)
        .map((item) => metricLabel(item.key, item.label))
        .join('、')}${unavailableMetrics.length > 3 ? '等' : ''}。`,
    );
  return output;
};

const gapLabels: Record<string, string> = {
  'market-pulse.breadth': '市场涨跌覆盖不完整',
  'market-pulse.themes': '概念题材分类未齐',
  'market-pulse.indexes': '指数行情不完整',
  'market-pulse.limit-up': '涨停统计不完整',
};

export const renderReportNotification = (report: Report): string => {
  const sections = report.sections.filter((section) => notificationSections.has(section.key));
  const gaps = [
    ...new Set(
      sections.flatMap((section) =>
        section.status === 'complete' && section.missingDimensions.length === 0
          ? []
          : section.missingDimensions.length === 0
            ? [`${section.title}数据不完整`]
            : section.missingDimensions.map(
                (gap) => gapLabels[gap.dimension] ?? `${section.title}数据不完整`,
              ),
      ),
    ),
  ];
  const lines =
    gaps.length === 0 ? [] : [`⚠️ ${gaps.slice(0, 5).join('；')}${gaps.length > 5 ? '等' : ''}。`];
  let omitted = 0;
  for (const section of sections) {
    const content = sectionLines(section).filter(Boolean);
    if (content.length === 0) continue;
    const selected: string[] = [];
    let hidden = 0;
    const sectionBudget = section.key === 'strategy-actions' ? 1000 : 700;
    for (const line of content) {
      if (selected.join('\n').length + line.length < sectionBudget) selected.push(line);
      else hidden += 1;
    }
    if (hidden > 0) selected.push('更多内容见完整报告。');
    const chunk = `**${section.title}**\n${selected.join('\n')}`;
    if (lines.join('\n\n').length + chunk.length <= 3500) lines.push(chunk);
    else omitted += 1;
  }
  if (omitted > 0) lines.push(`另有 ${omitted} 个板块，见完整报告。`);
  lines.push(
    `数据截至 ${notificationTime(report.dataAsOf)} · 生成 ${notificationTime(report.generatedAt)}（北京时间）`,
  );
  lines.push('完整报告与证据见 luoome「报告」。');
  lines.push(STANDARD_DISCLAIMERS.join(' '));
  return lines.join('\n\n');
};
