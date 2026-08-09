/* apps/web/public/js/entry-points.test.js —— 行情页入口结构断言。
 *
 * 「行情」不再有侧栏菜单项，入口改为：持仓 / Watchlist 点击股票、仪表盘搜索；
 * #market 路由与 #route-market section 必须保留（深链接仍可用）。
 * 无 DOM 环境，直接对 index.html / app.js 源码做结构断言。
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const html = read('../index.html');
const appJs = read('./app.js');

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

describe('研究 managed 写入入口', () => {
  it('提供创建主题、导入资料和写入状态容器', () => {
    expect(html).toContain('id="research-vault-settings-form"');
    expect(html).toContain('id="research-vault-path"');
    expect(html).toContain('id="research-vault-save-btn"');
    expect(html).toContain('id="research-create-topic-btn"');
    expect(html).toContain('id="research-import-document-btn"');
    expect(html).toContain('id="research-import-remote-btn"');
    expect(html).toContain('id="research-write-status"');
  });

  it('页面写入经过预览确认和统一 tool call', () => {
    expect(read('./pages.js')).toContain('确认写入 managed Vault');
    expect(read('./pages.js')).toContain('/api/tools/${' + 'toolName}/call');
    expect(read('./pages.js')).toContain('import_local_research_document');
    expect(read('./pages.js')).toContain('import_remote_research_document');
    expect(read('./pages.js')).toContain('/api/settings/research-vault');
  });
});

describe('主题皮肤入口', () => {
  it('顶栏存在主题抽屉按钮，抽屉面板与主题卡片齐全', () => {
    expect(html).toContain('id="theme-drawer-toggle"');
    expect(html).toContain('id="theme-drawer"');
    expect(html).toContain('id="theme-grid"');
    expect(html).toContain('id="follow-system-input"');
    expect(html).toContain('class="theme-card"');
    expect(html).toContain('data-theme="teal"');
    expect(html).toContain('data-theme="crimson"');
    expect(html).toContain('data-theme="blue"');
    expect(html).toContain('data-theme="violet"');
    expect(html).toContain('data-theme="rose"');
    expect(html).toContain('data-theme="amber"');
    expect(html).toContain('data-theme="sage"');
    expect(html).toContain('data-theme="slate"');
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('id="bg-layer"');
    expect(html).toContain('id="bg-file-input"');
    expect(html).toContain('id="bg-upload-btn"');
    expect(html).toContain('id="bg-clear-btn"');
    expect(html).toContain('id="panel-opacity-input"');
    expect(html).toContain('id="panel-opacity-value"');
  });

  it('app.js 初始化并绑定顶栏主题', () => {
    expect(appJs).toContain("import { bindTopbarTheme, initTheme } from './theme.js'");
    expect(appJs).toContain('initTheme();');
    expect(appJs).toContain('bindTopbarTheme();');
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
