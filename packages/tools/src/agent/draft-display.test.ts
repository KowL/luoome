import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../registry.js';
import { DraftDisplaySchema, summarizeDraft } from './draft-display.js';

describe('summarizeDraft（34 核心 Agent Tool 的写入草案）', () => {
  const displayOf = (
    tool: string,
    input: Record<string, unknown>,
    kind = 'watchlist',
    userRequest?: string,
  ) => {
    const target = toolRegistry.get(tool);
    if (target === undefined) throw new Error(`missing tool: ${tool}`);
    const display = summarizeDraft({
      tool,
      kind: kind as never,
      input,
      parsed: target.inputSchema.parse(input) as Record<string, unknown>,
      description: target.description,
      ...(userRequest === undefined ? {} : { userRequest }),
    });
    expect(DraftDisplaySchema.safeParse(display).success).toBe(true);
    return display;
  };

  it('update_holding（mode=update）保留纠错口径与现金影响说明', () => {
    const display = displayOf('update_holding', { holdingId: 'h-1', avgCost: 20 }, 'portfolio');
    expect(display.targetObject).toContain('持仓');
    expect(display.fields.map((item) => item.name)).toContain('现金影响');
    expect(display.ambiguous.join()).toContain('原持仓成本');
  });

  it('update_holding（mode=open）投影建仓数量与成本', () => {
    const display = displayOf(
      'update_holding',
      { mode: 'open', stockId: '601398.SH', quantity: 100, avgCost: 5.5 },
      'portfolio',
    );
    expect(display.targetObject).toContain('持仓');
    expect(display.fields.length).toBeGreaterThan(0);
  });

  it('create_watchlist：targetObject 与 user/default 来源判定', () => {
    const display = displayOf('create_watchlist', {
      name: '超跌反弹',
      kind: 'personal',
      membershipPolicy: 'manual',
    });
    expect(display.targetObject).toContain('超跌反弹');
    expect(display.fields.map((item) => item.name)).toContain('名称');
  });

  it('analyze_stock：advice 草案投影股票与备注', () => {
    const display = displayOf(
      'analyze_stock',
      { stockId: '002594.SZ', notes: '看现金流' },
      'advice',
    );
    expect(display.targetObject).toContain('002594.SZ');
    expect(display.fields).toEqual(
      expect.arrayContaining([{ name: '备注', value: '看现金流', source: 'user' }]),
    );
  });

  it('save_strategy_version：无专用 summarizer 时使用 tool 描述回落', () => {
    const display = summarizeDraft({
      tool: 'save_strategy_version',
      kind: 'strategy',
      input: { action: 'save-version', strategyId: 's-1' },
      parsed: { action: 'save-version', strategyId: 's-1' },
      description: '策略定义写入口',
    });
    expect(display.targetObject).toBe('策略定义写入口');
    expect(display.fields.map((item) => item.name)).toEqual(['action', 'strategyId']);
    expect(DraftDisplaySchema.safeParse(display).success).toBe(true);
  });

  it('无专用 summarizer 的 tool 回落到最小投影', () => {
    const display = summarizeDraft({
      tool: 'save_trading_plan',
      kind: 'portfolio',
      input: { name: 'S4 交易计划' },
      parsed: { name: 'S4 交易计划' },
      description: '创建或更新交易计划',
    });
    expect(display.targetObject).toBe('创建或更新交易计划');
    expect(display.fields.map((item) => item.name)).toContain('name');
    expect(DraftDisplaySchema.safeParse(display).success).toBe(true);
  });

  const watchlistId = 'watch-1';
  const priceLevel = { id: 'r-1', kind: 'price-level', side: 'below', level: 220 };
  const priceChangeRules = [
    { id: 'r-2', kind: 'price-change', pct: 0.02, direction: 'down' },
    { id: 'r-3', kind: 'price-change', pct: 0.04, direction: 'down' },
    { id: 'r-4', kind: 'price-change', pct: 0.06, direction: 'down' },
  ];

  it('save_alert_plan：草案逐条列出用户点名的规则，不产生多余提醒', () => {
    const display = displayOf(
      'save_alert_plan',
      { name: '宁德预警', watchlistId, rules: [priceLevel] },
      'alert-plan',
      '给宁德时代设预警：跌破 220 元提醒我',
    );
    const ruleFields = display.fields.filter((item) => item.name.startsWith('规则 '));
    expect(ruleFields).toEqual([{ name: '规则 1', value: '价格下穿 220 元', source: 'user' }]);
    expect(display.ambiguous).toEqual([]);
  });

  it('save_alert_plan：用户没提到的规则被标为推断并单独列出待确认', () => {
    const display = displayOf(
      'save_alert_plan',
      { name: '宁德预警', watchlistId, rules: [priceLevel, ...priceChangeRules] },
      'alert-plan',
      '给宁德时代设预警：跌破 220 元提醒我',
    );
    const ruleFields = display.fields.filter((item) => item.name.startsWith('规则 '));
    expect(ruleFields.map((item) => item.source)).toEqual([
      'user',
      'inferred',
      'inferred',
      'inferred',
    ]);
    expect(display.ambiguous).toHaveLength(3);
    expect(display.ambiguous[0]).toContain('规则 2');
    expect(display.ambiguous[0]).toContain('未在你这条消息里出现');
    expect(display.ambiguous.join()).not.toContain('规则 1');
  });

  it('save_alert_plan：用户明确要了多条规则时全部标为用户输入', () => {
    const display = displayOf(
      'save_alert_plan',
      { name: '宁德预警', watchlistId, rules: [priceLevel, priceChangeRules[0]] },
      'alert-plan',
      '宁德时代跌破 220 或跌超 2% 都提醒我',
    );
    expect(display.fields.filter((item) => item.name.startsWith('规则 '))).toEqual([
      { name: '规则 1', value: '价格下穿 220 元', source: 'user' },
      { name: '规则 2', value: '跌超 2%', source: 'user' },
    ]);
    expect(display.ambiguous).toEqual([]);
  });

  it('save_alert_plan：缺少用户原话时至少提示逐条核对多规则草案', () => {
    const display = displayOf('save_alert_plan', {
      name: '宁德预警',
      watchlistId,
      rules: [priceLevel, ...priceChangeRules],
    });
    expect(display.ambiguous.join()).toContain('4 条规则');
  });

  it('input 非对象时按空 raw 处理', () => {
    const display = summarizeDraft({
      tool: 'create_watchlist',
      kind: 'watchlist',
      input: 'not-an-object',
      parsed: {},
      description: '创建 Watchlist',
    });
    expect(display.targetObject).toBe('Watchlist「」');
  });
});
