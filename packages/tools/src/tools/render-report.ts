import { notificationTime, type Report, type ReportBlock, type ReportValue } from '@luoome/core';
import { z } from 'zod';
import { defineTool, errNotFound } from '../define-tool.js';
import { renderReportNotification } from '../internal/report-notification.js';

export const RenderReportInput = z.object({
  reportId: z.string().min(1),
  format: z.enum(['markdown', 'plain-text', 'notification']),
});

export const RenderReportOutput = z.object({
  content: z.string(),
  contentType: z.string(),
});

/** 引用标签：entityKind 是内部枚举，报告正文用中文，id 保留以便溯源。 */
const ENTITY_LABELS: Readonly<Record<string, string>> = {
  stock: '股票',
  strategy: '策略',
  watchlist: '关注分组',
  'alert-plan': '预警计划',
  advice: '建议',
  'trading-plan': '交易计划',
  'stock-event': '事件',
  'research-note': '研究资料',
  'watch-trigger': '触发记录',
  'stock-group': '旧分组',
  'watch-plan': '旧预警',
};

const displayValue = (value: ReportValue): string => {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number') return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return String(value);
};

const markdownCell = (value: ReportValue): string =>
  displayValue(value).replaceAll('|', '\\|').replaceAll('\n', ' ');

const renderBlockMarkdown = (block: ReportBlock): string[] => {
  if (block.kind === 'text') return [block.tone === 'warning' ? `> ⚠️ ${block.text}` : block.text];
  if (block.kind === 'metrics') {
    const available = block.items.filter(
      (item) => item.value !== null || item.displayValue !== undefined,
    );
    const unavailable = block.items.filter(
      (item) => item.value === null && item.displayValue === undefined,
    );
    return [
      ...available.map((item) => {
        const text =
          item.displayValue ??
          (item.value === null
            ? '—'
            : item.unit === 'ratio' && typeof item.value === 'number'
              ? `${(item.value * 100).toFixed(1)}%`
              : `${displayValue(item.value)}${item.unit ?? ''}`);
        return `- ${item.label}：${text}`;
      }),
      ...(unavailable.length === 0
        ? []
        : [
            `> 未展示指标：${unavailable.map((item) => item.label).join('、')}（缺少计算所需数据）。`,
          ]),
    ];
  }
  if (block.kind === 'list') {
    if (block.items.length === 0) return ['暂无记录。'];
    return block.items.map((item) => {
      const entity =
        item.entityKind === undefined
          ? ''
          : `（${ENTITY_LABELS[item.entityKind] ?? item.entityKind}:${item.entityId ?? ''}）`;
      return `- ${item.title}${entity}${item.detail === undefined ? '' : ` — ${item.detail}`}`;
    });
  }
  if (block.rows.length === 0) return [];
  const columns = block.columns.filter((column) =>
    block.rows.some((row) => row[column.key] != null),
  );
  if (columns.length === 0) return ['暂无可展示的统计结果。'];
  const keys = columns.map((column) => column.key);
  const missingColumns = block.columns.filter((column) => !columns.includes(column));
  return [
    `| ${columns.map((column) => column.label).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...block.rows.map(
      (row) => `| ${keys.map((key) => markdownCell(row[key] ?? null)).join(' | ')} |`,
    ),
    ...(missingColumns.length === 0
      ? []
      : [
          `\n> 未展示列：${missingColumns.map((column) => column.label).join('、')}（缺少计算所需数据）；表内 — 表示该项数据尚缺。`,
        ]),
  ];
};

const renderMarkdown = (report: Report): string => {
  const lines = [
    `# ${report.title}`,
    '',
    `- 周期：${report.periodStart} 至 ${report.periodEnd}`,
    `- 数据概况：${report.status === 'partial' ? '部分数据待补齐，已展示可核验结果' : '完整'}`,
    `- 数据截止：${notificationTime(report.dataAsOf)}（北京时间）`,
    `- 生成时间：${notificationTime(report.generatedAt)}（北京时间）`,
  ];
  for (const section of report.sections) {
    lines.push('', `## ${section.title}`);
    if (section.status === 'unavailable') lines.push('', '> 本节暂未取得数据，请稍后重试。');
    if (section.dataAsOf !== undefined && section.dataAsOf.getTime() !== report.dataAsOf.getTime())
      lines.push(`数据截止：${notificationTime(section.dataAsOf)}（北京时间）`);
    for (const block of section.blocks) lines.push('', ...renderBlockMarkdown(block));
  }
  const gaps = [
    ...new Map(
      [
        ...report.sections.flatMap((section) => section.missingDimensions),
        ...report.missingDimensions,
      ].map((gap) => [`${gap.dimension}:${gap.reason}`, gap]),
    ).values(),
  ];
  if (gaps.length > 0) {
    lines.push('', '## 数据说明', '', '以下缺口不代表零值；已取得的数据仍可阅读。');
    for (const gap of gaps) lines.push(`- ${gap.dimension}：${gap.reason}`);
  }
  lines.push('', '## 数据来源');
  if (report.evidence.length === 0) {
    lines.push('- 无');
  } else {
    for (const evidence of report.evidence) {
      const provenance = evidence.provenance;
      lines.push(
        `- ${evidence.dimension}：${provenance.provider}，${provenance.freshness}，观测于 ${provenance.observedAt.toISOString()}${provenance.fallbackFrom === undefined ? '' : `，由 ${provenance.fallbackFrom} 降级`}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
};

const renderPlainText = (report: Report): string =>
  renderMarkdown(report)
    .replace(/^#{1,6} /gm, '')
    .replace(/^> ⚠️ /gm, '警告：')
    .replace(/^> /gm, '')
    .replace(/^\| (.*) \|$/gm, '$1')
    .replace(/^\| (?:---(?: \| )?)+\|?$/gm, '');

export const renderReportTool = defineTool({
  name: 'render_report',
  description: '从已保存的结构化 block 渲染完整报告或适合通知的精简摘要，不查询外部数据',
  sideEffect: 'read',
  input: RenderReportInput,
  output: RenderReportOutput,
  handler: async (input, ctx) => {
    const report = await ctx.repos.report.findById(input.reportId);
    if (report === null) return errNotFound('Report', input.reportId);
    if (input.format === 'notification')
      return {
        content: renderReportNotification(report),
        contentType: 'text/markdown; charset=utf-8',
      };
    return input.format === 'markdown'
      ? {
          content: renderMarkdown(report),
          contentType: 'text/markdown; charset=utf-8',
        }
      : {
          content: renderPlainText(report),
          contentType: 'text/plain; charset=utf-8',
        };
  },
});
