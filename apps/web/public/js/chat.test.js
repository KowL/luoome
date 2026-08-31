import { describe, expect, it } from 'bun:test';

import {
  cancelledAssistantParts,
  draftEditPrefill,
  formatDraftFieldValue,
  formatDraftSettlement,
  parseChatRouteHeader,
  parseDraftSettlement,
  persistedFeed,
  planCardLines,
  trimLeadingChatWhitespace,
} from './chat.js';

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
    const record = formatDraftSettlement('create_watchlist', true, '创建 Watchlist 执行成功');
    expect(parseDraftSettlement(record)).toEqual({
      ok: true,
      tool: 'create_watchlist',
      text: '创建 Watchlist 执行成功',
    });
    const failed = formatDraftSettlement('archive_watchlist', false, '已取消该草案');
    expect(parseDraftSettlement(failed)).toEqual({
      ok: false,
      tool: 'archive_watchlist',
      text: '已取消该草案',
    });
  });

  it('容忍持久化文本的开头空白', () => {
    expect(
      parseDraftSettlement('\n  [草案处理记录] ok update_watchlist 更新 Watchlist 执行成功'),
    ).toEqual({
      ok: true,
      tool: 'update_watchlist',
      text: '更新 Watchlist 执行成功',
    });
  });

  it('普通文本返回 null', () => {
    expect(parseDraftSettlement('帮我创建一个观察分组')).toBeNull();
    expect(parseDraftSettlement('[草案处理记录] 缺少状态标记')).toBeNull();
  });
});

describe('计划卡', () => {
  it('解析 URL 编码的 route header，非法值返回 null', () => {
    const route = {
      scenario: 'portfolio',
      subjects: ['SZ300857'],
      needsAdvice: false,
      involvesWrite: false,
      plannedDimensions: ['持仓/成本', '行情'],
    };
    expect(parseChatRouteHeader(encodeURIComponent(JSON.stringify(route)))).toEqual(route);
    expect(parseChatRouteHeader(null)).toBeNull();
    expect(parseChatRouteHeader('%E4%B8%AD')).toBeNull();
    expect(parseChatRouteHeader('{"foo":1}')).toBeNull();
  });

  it('渲染维度、建议与草案提示行', () => {
    expect(
      planCardLines({
        scenario: 'review',
        plannedDimensions: ['建议与结果', '报告'],
        needsAdvice: true,
        involvesWrite: true,
      }),
    ).toEqual(['将查询：建议与结果 → 报告', '可能生成建议', '可能生成待确认草案']);
    expect(planCardLines({ scenario: 'general', plannedDimensions: [] })).toEqual([]);
  });
});

describe('草案编辑预填', () => {
  it('把 display 字段摘要转成自然语言预填文本', () => {
    const text = draftEditPrefill({
      tool: 'create_watchlist',
      display: {
        targetObject: 'Watchlist「超跌反弹」',
        fields: [
          { name: '名称', value: '超跌反弹', source: 'user' },
          { name: '启用', value: true, source: 'default' },
        ],
        unsupported: [],
        ambiguous: [],
      },
    });
    expect(text).toBe(
      '请修改刚才的草案（Watchlist「超跌反弹」）：名称=超跌反弹，启用=true，我想改为：',
    );
  });

  it('无 display 的老草案回落到 tool 标签', () => {
    expect(draftEditPrefill({ tool: 'analyze_stock' })).toBe(
      '请修改刚才的草案（分析个股），我想改为：',
    );
    expect(draftEditPrefill({ tool: 'trial_strategy' })).toBe(
      '请修改刚才的草案（试跑 Strategy），我想改为：',
    );
    expect(draftEditPrefill({ tool: 'run_strategy' })).toBe(
      '请修改刚才的草案（正式运行 Strategy），我想改为：',
    );
  });

  it('字段值格式化：数组顿号连接、对象 JSON、空值占位', () => {
    expect(formatDraftFieldValue(['SZ300857', 'SH600000'])).toBe('SZ300857、SH600000');
    expect(formatDraftFieldValue({ a: 1 })).toBe('{"a":1}');
    expect(formatDraftFieldValue(undefined)).toBe('—');
  });
});

describe('取消标注还原', () => {
  it('含 data-luoome-cancelled part 的助手消息还原为已取消', () => {
    const entries = persistedFeed([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '问题' }] },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'text', text: '半截回答' },
          { type: 'data-luoome-cancelled', data: { cancelled: true } },
        ],
      },
    ]);
    const assistant = entries.find((entry) => entry.type === 'msg' && entry.role === 'assistant');
    expect(assistant).toMatchObject({ content: '半截回答', cancelled: true });
  });

  it('无标记消息不带 cancelled；空文本的取消消息仍还原占位', () => {
    const normal = persistedFeed([
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '完整回答' }] },
    ]);
    expect(normal[0]).toMatchObject({ content: '完整回答' });
    expect(normal[0].cancelled).toBeUndefined();

    const empty = persistedFeed([
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'data-luoome-cancelled', data: { cancelled: true } }],
      },
    ]);
    expect(empty).toHaveLength(1);
    expect(empty[0]).toMatchObject({ role: 'assistant', cancelled: true });
  });

  it('兜底落库 parts：有文本带 text part，空文本只留 cancelled 标记', () => {
    expect(cancelledAssistantParts('半截回答')).toEqual([
      { type: 'text', text: '半截回答' },
      { type: 'data-luoome-cancelled', data: { cancelled: true } },
    ]);
    expect(cancelledAssistantParts('')).toEqual([
      { type: 'data-luoome-cancelled', data: { cancelled: true } },
    ]);
    expect(cancelledAssistantParts('   ')).toEqual([
      { type: 'data-luoome-cancelled', data: { cancelled: true } },
    ]);
  });
});
