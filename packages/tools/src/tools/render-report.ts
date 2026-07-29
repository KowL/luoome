import type { Report, ReportBlock, ReportValue } from '@luoome/core';
import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';

export const RenderReportInput = z.object({
  reportId: z.string().min(1),
  format: z.enum(['markdown', 'plain-text']),
});

export const RenderReportOutput = z.object({
  content: z.string(),
  contentType: z.string(),
});

const displayValue = (value: ReportValue): string => {
  if (value === null) return '不可用';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
};

const markdownCell = (value: ReportValue): string =>
  displayValue(value).replaceAll('|', '\\|').replaceAll('\n', ' ');

const renderBlockMarkdown = (block: ReportBlock): string[] => {
  if (block.kind === 'text') return [block.tone === 'warning' ? `> ⚠️ ${block.text}` : block.text];
  if (block.kind === 'metrics') {
    return block.items.map(
      (item) =>
        `- ${item.label}：${item.displayValue ?? displayValue(item.value)}${item.unit ?? ''}`,
    );
  }
  if (block.kind === 'list') {
    return block.items.map((item) => {
      const entity =
        item.entityKind === undefined ? '' : `（${item.entityKind}:${item.entityId ?? ''}）`;
      return `- ${item.title}${entity}${item.detail === undefined ? '' : ` — ${item.detail}`}`;
    });
  }
  const keys = block.columns.map((column) => column.key);
  return [
    `| ${block.columns.map((column) => column.label).join(' | ')} |`,
    `| ${block.columns.map(() => '---').join(' | ')} |`,
    ...block.rows.map(
      (row) => `| ${keys.map((key) => markdownCell(row[key] ?? null)).join(' | ')} |`,
    ),
  ];
};

const renderMarkdown = (report: Report): string => {
  const lines = [
    `# ${report.title}`,
    '',
    `- 周期：${report.periodStart} 至 ${report.periodEnd}`,
    `- 状态：${report.status === 'partial' ? '部分可用' : '完整'}`,
    `- 数据截止：${report.dataAsOf.toISOString()}`,
    `- 生成时间：${report.generatedAt.toISOString()}`,
  ];
  for (const section of report.sections) {
    lines.push('', `## ${section.title}`, '', `状态：${section.status}`);
    if (section.dataAsOf !== undefined) lines.push(`数据截止：${section.dataAsOf.toISOString()}`);
    for (const block of section.blocks) lines.push('', ...renderBlockMarkdown(block));
    for (const missing of section.missingDimensions) {
      lines.push('', `> 缺失维度 ${missing.dimension}：${missing.reason}`);
    }
  }
  if (report.missingDimensions.length > 0) {
    lines.push('', '## 报告级缺失');
    for (const missing of report.missingDimensions) {
      lines.push(`- ${missing.dimension}：${missing.reason}`);
    }
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
  description: '从已保存的结构化 block 渲染 Markdown 或纯文本，不查询外部数据',
  sideEffect: 'read',
  input: RenderReportInput,
  output: RenderReportOutput,
  handler: async (input, ctx) => {
    const report = await ctx.repos.report.findById(input.reportId);
    if (report === null) return errNotFound('Report', input.reportId);
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
