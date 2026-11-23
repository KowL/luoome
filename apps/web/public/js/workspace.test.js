import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

import { holdingRows } from './workspace.js';

class TestNode {
  constructor(tag = '', text = '') {
    this.tag = tag;
    this.children = [];
    this.text = text;
  }
  append(...children) {
    this.children.push(...children);
  }
  set textContent(value) {
    this.text = value;
  }
  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
}

const withDom = (run) => {
  const originalDocument = globalThis.document;
  const originalNode = globalThis.Node;
  globalThis.Node = TestNode;
  globalThis.document = {
    createElement: (tag) => new TestNode(tag),
    createTextNode: (text) => new TestNode('', text),
  };
  try {
    return run();
  } finally {
    globalThis.document = originalDocument;
    globalThis.Node = originalNode;
  }
};

const holding = (overrides = {}) => ({
  holding: { stockId: '600519', quantity: 100 },
  stockName: '贵州茅台',
  currentPrice: 1500,
  pnl: 1000,
  pnlPct: 0.02,
  todayPnlPct: -0.01,
  ...overrides,
});

describe('首页「持仓，先看变化」区块', () => {
  it('无持仓时只给空态，不渲染空成绩单卡片', () => {
    const nodes = withDom(() => holdingRows([]));
    expect(nodes).toHaveLength(1);
    expect(nodes[0].textContent).toContain('还没有持仓');
    expect(nodes[0].textContent).not.toContain('成绩单');
    expect(nodes[0].textContent).not.toContain('生成 --');
  });

  it('有持仓时按持股展示数量、现价、今日与浮动盈亏', () => {
    const nodes = withDom(() => holdingRows([holding()]));
    expect(nodes).toHaveLength(1);
    expect(nodes[0].tag).toBe('div');
    const text = nodes[0].textContent;
    expect(text).toContain('贵州茅台');
    expect(text).toContain('数量100');
    expect(text).toContain('现价1,500.00');
    expect(text).toContain('今日-1.00%');
    expect(text).toContain('浮动盈亏+1000.00（2.00%）');
  });

  it('缺今日基准时不伪造涨跌幅，只用占位符', () => {
    const nodes = withDom(() => holdingRows([holding({ todayPnlPct: null })]));
    expect(nodes[0].textContent).toContain('今日--');
  });
});

describe('首页持仓区块数据来源', () => {
  const source = readFileSync(new URL('./workspace.js', import.meta.url), 'utf8');

  it('只读当前账户持仓，不再用报告列表占位', () => {
    expect(source).toContain("callApi('/api/holdings')");
    expect(source).not.toContain('/api/reports');
  });
});
