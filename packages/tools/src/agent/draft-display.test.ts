import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../registry.js';
import { DraftDisplaySchema, summarizeDraft } from './draft-display.js';

describe('summarizeDraft', () => {
  const portfolioDisplay = (tool: string, input: Record<string, unknown>) => {
    const target = toolRegistry.get(tool);
    if (target === undefined) throw new Error(`missing tool: ${tool}`);
    const display = summarizeDraft({
      tool,
      kind: 'portfolio',
      input,
      parsed: target.inputSchema.parse(input) as Record<string, unknown>,
      description: target.description,
    });
    expect(DraftDisplaySchema.safeParse(display).success).toBe(true);
    return display;
  };

  it('账户草案显示本金、币种与按账本精度初始化的现金', () => {
    const display = portfolioDisplay('create_account', {
      name: '长期账户',
      currency: 'cny',
      initialCapital: 10000.12346,
    });
    expect(display.targetObject).toBe('投资账本账户「长期账户」');
    expect(display.fields).toEqual(
      expect.arrayContaining([
        { name: '币种', value: 'CNY', source: 'user' },
        { name: '初始现金余额', value: 10000.1235, source: 'inferred' },
      ]),
    );
  });

  it('持仓登记展示真实成本扣款口径与全部隐式默认值', () => {
    const display = portfolioDisplay('add_holding', {
      stockId: '000001.SZ',
      quantity: 100,
      avgCost: 10.12345,
    });
    expect(display.fields).toEqual(
      expect.arrayContaining([
        { name: '现金变化（账户币种）', value: -1012.35, source: 'inferred' },
        { name: '账户', value: '当前默认账户', source: 'default' },
        { name: '可卖数量（股）', value: 100, source: 'default' },
        { name: '建仓时间', value: '确认执行时的当前时间', source: 'default' },
      ]),
    );
    expect(display.ambiguous).toHaveLength(3);
  });

  it('持仓纠错与关闭保留现金口径和缺失原成本的说明，不编造现金金额', () => {
    const update = portfolioDisplay('update_holding', { holdingId: 'h-1', avgCost: 20 });
    expect(update.fields.find((item) => item.name === '现金影响')?.value).toContain('成本');
    expect(update.fields.map((item) => item.name)).not.toContain('修正后数量（股）');
    expect(update.ambiguous).toEqual(['现金变化金额需结合当前持仓核对；本草案未包含原持仓成本']);
    const close = portfolioDisplay('close_holding', { holdingId: 'h-1' });
    expect(close.fields.find((item) => item.name === '现金影响')?.value).toContain('不按成交价');
    expect(close.fields.find((item) => item.name === '操作性质')?.value).toContain('不会卖出股票');
    expect(close.ambiguous).toEqual(['现金回补金额需结合当前持仓核对；本草案未包含原持仓成本']);
  });

  it.each([
    ['deposit', '入金', 200],
    ['withdrawal', '出金', -200],
    ['dividend', '分红', 200],
    ['fee', '费用', -200],
    ['tax', '税费', -200],
    ['transfer-in', '转入', 200],
    ['transfer-out', '转出', -200],
  ])('流水 %s 显示中文类型 %s 与正确现金方向', (kind, label, impact) => {
    const display = portfolioDisplay('create_portfolio_cash_flow', {
      accountId: 'a-1',
      occurredAt: '2026-09-28T09:00:00+08:00',
      kind,
      amount: 200,
    });
    expect(display.targetObject).toBe(`账户资金流水「${label}」`);
    expect(display.fields).toEqual(
      expect.arrayContaining([
        { name: '现金变化', value: impact, source: 'inferred' },
        { name: '币种', value: 'CNY', source: 'default' },
      ]),
    );
  });

  it('create_watchlist：targetObject 与 user/default 来源判定', () => {
    const display = summarizeDraft({
      tool: 'create_watchlist',
      kind: 'watchlist',
      input: { name: '超跌反弹', kind: 'personal', membershipPolicy: 'manual' },
      parsed: {
        name: '超跌反弹',
        kind: 'personal',
        membershipPolicy: 'manual',
        enabled: true, // schema default 补全
      },
      description: '创建 Watchlist',
    });
    expect(display.targetObject).toBe('Watchlist「超跌反弹」');
    expect(display.unsupported).toEqual([]);
    expect(display.ambiguous).toEqual([]);
    const byName = Object.fromEntries(display.fields.map((f) => [f.name, f]));
    expect(byName.名称).toMatchObject({ value: '超跌反弹', source: 'user' });
    expect(byName.启用).toMatchObject({ value: true, source: 'default' });
    expect(display).toEqual(DraftDisplaySchema.parse(display));
  });

  it('add_watchlist_members：成员列表与计数进 targetObject', () => {
    const display = summarizeDraft({
      tool: 'add_watchlist_members',
      kind: 'watchlist',
      input: { watchlistId: 'wl-1', members: [{ stockId: 'SZ300857' }, { stockId: 'SH600000' }] },
      parsed: { watchlistId: 'wl-1', members: [{ stockId: 'SZ300857' }, { stockId: 'SH600000' }] },
      description: '批量添加成员',
    });
    expect(display.targetObject).toBe('Watchlist wl-1（新增 2 名成员）');
    expect(display.fields.find((f) => f.name === '成员')).toMatchObject({
      value: ['SZ300857', 'SH600000'],
      source: 'user',
    });
  });

  it('market_outlook：无主题时标注全市场歧义', () => {
    const display = summarizeDraft({
      tool: 'market_outlook',
      kind: 'advice',
      input: {},
      parsed: {},
      description: '大盘 / 板块观点',
    });
    expect(display.targetObject).toBe('市场观点 Advice（全市场）');
    expect(display.ambiguous).toEqual(['未指定板块或主题，将按全市场评估']);
  });

  it('analyze_stock：advice 草案投影股票与备注', () => {
    const display = summarizeDraft({
      tool: 'analyze_stock',
      kind: 'advice',
      input: { stockId: 'SZ300857', notes: '关注量能' },
      parsed: { stockId: 'SZ300857', notes: '关注量能' },
      description: '对指定股票做综合分析',
    });
    expect(display.targetObject).toBe('个股 Advice（SZ300857）');
    expect(display.fields.map((f) => f.name)).toEqual(['股票', '备注']);
  });

  it('save_decision_review：投影复盘对象、教训标签与关联成交', () => {
    const display = summarizeDraft({
      tool: 'save_decision_review',
      kind: 'review',
      input: {
        subject: { kind: 'advice', id: 'advice-1' },
        content: { tradeIds: ['trade-1'], lessonTags: ['按计划'], note: '复盘结论' },
      },
      parsed: {
        subject: { kind: 'advice', id: 'advice-1' },
        content: {
          tradeIds: ['trade-1'],
          adviceFeedback: null,
          lessonTags: ['按计划'],
          note: '复盘结论',
        },
      },
      description: '记录事后复盘',
    });
    expect(display.targetObject).toBe('决策复盘「advice advice-1」');
    expect(display.fields).toEqual(
      expect.arrayContaining([
        { name: '复盘对象', value: 'advice advice-1', source: 'user' },
        { name: '教训标签', value: ['按计划'], source: 'user' },
        { name: '复盘结论', value: '复盘结论', source: 'user' },
        { name: '关联成交', value: ['trade-1'], source: 'user' },
      ]),
    );
    expect(display).toEqual(DraftDisplaySchema.parse(display));
  });

  it('无专用 summarizer 的 tool 回落到最小投影', () => {
    const display = summarizeDraft({
      tool: 'pause_strategy',
      kind: 'strategy',
      input: { strategyId: 's-1' },
      parsed: { strategyId: 's-1', reason: undefined },
      description: '暂停 Strategy',
    });
    expect(display.targetObject).toBe('暂停 Strategy');
    expect(display.fields).toEqual([
      { name: 'strategyId', value: 's-1', source: 'user' },
      { name: 'reason', value: undefined, source: 'default' },
    ]);
  });

  it('input 非对象时按空 raw 处理', () => {
    const display = summarizeDraft({
      tool: 'unknown_tool',
      kind: 'strategy',
      input: null,
      parsed: { a: 1 },
      description: '某 tool',
    });
    expect(display.fields).toEqual([{ name: 'a', value: 1, source: 'default' }]);
  });
});
