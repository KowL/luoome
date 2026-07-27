import { describe, expect, it } from 'bun:test';

import { formatDraftSettlement, parseDraftSettlement, trimLeadingChatWhitespace } from './chat.js';

describe('chat message whitespace', () => {
  it('移除 AI SDK / think 清理后残留的开头空行', () => {
    expect(trimLeadingChatWhitespace('\n\n  \n好的，我来查看。')).toBe('好的，我来查看。');
  });

  it('保留正文内部的换行和缩进', () => {
    expect(trimLeadingChatWhitespace('\n第一行\n\n  第二行')).toBe('第一行\n\n  第二行');
  });
});

describe('草案处理记录', () => {
  it('格式化后可解析回 tool / ok / 文本', () => {
    const record = formatDraftSettlement('create_stock_group', true, '创建分组执行成功');
    expect(parseDraftSettlement(record)).toEqual({
      ok: true,
      tool: 'create_stock_group',
      text: '创建分组执行成功',
    });
    const failed = formatDraftSettlement('delete_stock_pool', false, '已取消该草案');
    expect(parseDraftSettlement(failed)).toEqual({
      ok: false,
      tool: 'delete_stock_pool',
      text: '已取消该草案',
    });
  });

  it('容忍持久化文本的开头空白', () => {
    expect(
      parseDraftSettlement('\n  [草案处理记录] ok update_stock_group 更新分组执行成功'),
    ).toEqual({
      ok: true,
      tool: 'update_stock_group',
      text: '更新分组执行成功',
    });
  });

  it('普通文本返回 null', () => {
    expect(parseDraftSettlement('帮我创建一个观察分组')).toBeNull();
    expect(parseDraftSettlement('[草案处理记录] 缺少状态标记')).toBeNull();
  });
});
