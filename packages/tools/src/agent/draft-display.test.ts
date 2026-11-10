import { describe, expect, it } from 'vitest';
import { toolRegistry } from '../registry.js';
import { DraftDisplaySchema, summarizeDraft } from './draft-display.js';

describe('summarizeDraft（34 核心 Agent Tool 的写入草案）', () => {
  const displayOf = (tool: string, input: Record<string, unknown>, kind = 'watchlist') => {
    const target = toolRegistry.get(tool);
    if (target === undefined) throw new Error(`missing tool: ${tool}`);
    const display = summarizeDraft({
      tool,
      kind: kind as never,
      input,
      parsed: target.inputSchema.parse(input) as Record<string, unknown>,
      description: target.description,
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
      tool: 'save_alert_plan',
      kind: 'alert-plan',
      input: { name: 'S4 预警' },
      parsed: { name: 'S4 预警' },
      description: '创建或更新股票池盘中预警规则',
    });
    expect(display.targetObject).toBe('创建或更新股票池盘中预警规则');
    expect(display.fields.map((item) => item.name)).toContain('name');
    expect(DraftDisplaySchema.safeParse(display).success).toBe(true);
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
