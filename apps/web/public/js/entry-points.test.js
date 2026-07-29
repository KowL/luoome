/* apps/web/public/js/entry-points.test.js —— 行情页入口结构断言。
 *
 * 「行情」不再有侧栏菜单项，入口改为：持仓 / 分组点击股票、仪表盘搜索；
 * #market 路由与 #route-market section 必须保留（深链接仍可用）。
 * 无 DOM 环境，直接对 index.html / app.js 源码做结构断言。
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../index.html');
const appJs = read('./app.js');
const pagesJs = read('./pages.js');

describe('侧栏与路由结构', () => {
  it('侧栏没有「行情」菜单项', () => {
    expect(html).not.toContain('href="#market" data-route="market"');
  });

  it('#route-market section 保留（深链接仍可用）', () => {
    expect(html).toContain('id="route-market"');
    expect(html).toContain('data-route="market"');
  });

  it('app.js 的 ROUTES 仍包含 market，路由分发不报错', () => {
    expect(appJs).toContain("'market'");
    expect(appJs).toContain('renderMarket');
  });

  it('导航 active 逻辑只遍历已存在的 .nav-item（无行情项时是空操作）', () => {
    expect(appJs).toContain("document.querySelectorAll('.nav-item')");
  });
});

describe('行情页入口', () => {
  it('行情页搜索容器保留（页内换股票）', () => {
    expect(html).toContain('id="market-search"');
  });

  it('仪表盘有股票搜索容器', () => {
    expect(html).toContain('id="dashboard-stock-search"');
  });
});

describe('报告页入口', () => {
  it('侧栏、路由和历史/详情容器齐全', () => {
    expect(html).toContain('href="#reports" data-route="reports"');
    expect(html).toContain('id="route-reports"');
    expect(html).toContain('id="report-history"');
    expect(html).toContain('id="report-detail"');
    expect(appJs).toContain("'reports'");
    expect(appJs).toContain('renderReports');
  });
});

describe('策略研究入口', () => {
  it('战法页包含同日共振容器，且不出现越界投资文案', () => {
    expect(html).toContain('id="tactic-consensus"');
    for (const phrase of ['AI 胜率', '重点买入', '追涨']) {
      expect(html).not.toContain(phrase);
    }
  });

  it('空战法列表也会加载同日共振结果', () => {
    const tacticsRenderer = pagesJs.slice(
      pagesJs.indexOf('const renderTacticsList'),
      pagesJs.indexOf('const renderTacticConsensus'),
    );
    expect(tacticsRenderer.indexOf('await renderTacticConsensus()')).toBeLessThan(
      tacticsRenderer.indexOf('r.data.tactics.length === 0'),
    );
  });
});

describe('看盘主页结构', () => {
  it('指数条 / 实时看板 / 今日预警容器齐全', () => {
    expect(html).toContain('id="dashboard-indices"');
    expect(html).toContain('id="dashboard-board"');
    expect(html).toContain('id="dashboard-board-meta"');
    expect(html).toContain('id="dash-trigger-list"');
    expect(html).toContain('id="dash-advice-list"');
  });

  it('区块顺序：指数条 → 统计 → 看板 → 两栏 → watch rail → 数据健康（页底）', () => {
    const order = [
      'id="dashboard-indices"',
      'id="dashboard-stats"',
      'id="dashboard-board"',
      'id="dash-trigger-list"',
      'id="dash-watch-rail"',
      'id="dashboard-data-health"',
    ];
    const positions = order.map((marker) => html.indexOf(marker));
    for (const pos of positions) expect(pos).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });
});
