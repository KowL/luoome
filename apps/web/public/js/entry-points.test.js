/* apps/web/public/js/entry-points.test.js —— 行情页入口结构断言。
 *
 * 「行情」不再有侧栏菜单项，入口改为：持仓 / Watchlist 点击股票、顶栏搜索；
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

  it('预警页面菜单使用简化文案「预警」', () => {
    expect(html).toMatch(/href="#alerts" data-route="alerts"><span>预警<\/span>/);
    expect(html).not.toMatch(/href="#alerts" data-route="alerts"><span>预警计划<\/span>/);
  });
});

describe('行情页入口', () => {
  it('股票搜索统一放在顶栏，仪表盘和行情页不再重复展示', () => {
    expect(html).toContain('id="topbar-stock-search"');
    expect(html).not.toContain('id="market-search"');
    expect(html).not.toContain('id="dashboard-stock-search"');
    expect(appJs).toContain('bindTopbarStockSearch');
  });
});

describe('策略页布局', () => {
  it('策略目录作为顶部横向切换条，工作台独占下方宽度', () => {
    const strategySection = html.slice(
      html.indexOf('id="route-strategies"'),
      html.indexOf('id="route-watchlists"'),
    );
    expect(html).toContain('class="strategy-layout"');
    expect(html).toContain('id="strategies-list" class="strategy-catalog-list"');
    expect(html).toContain('class="card strategy-detail-pane"');
    expect(strategySection).not.toContain('class="split-pane"');
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

describe('首页 = 最新收盘报告', () => {
  it('侧栏首项为「首页」，#route-home 与 #home-report 容器齐全', () => {
    expect(html).toContain('href="#home" data-route="home"');
    expect(html.indexOf('data-route="home"')).toBeLessThan(html.indexOf('data-route="dashboard"'));
    expect(html).toContain('id="route-home"');
    expect(html).toContain('id="home-report"');
    expect(html).toContain('href="#reports"');
  });

  it('app.js 默认路由改为 home 并接入 renderHome；dashboard 降级为二级路由不删除', () => {
    expect(appJs).toContain("'home'");
    expect(appJs).toContain("ROUTES.includes(name) ? name : 'home'");
    expect(appJs).toContain("ROUTES.includes(path) ? path : 'home'");
    expect(appJs).toContain('renderHome(setStatus)');
    expect(appJs).toContain('renderDashboard(setStatus)');
  });

  it('首页复用 list_reports/get_report 现有 API；空态诚实说明生成路径', () => {
    const pages = read('./pages.js');
    expect(pages).toContain("callApi('/api/reports?kind=closing&limit=1')");
    expect(pages).toContain('reportSheetNodes');
    expect(pages).toContain('尚无收盘报告');
    expect(pages).toContain('去「报告」页生成');
  });

  it('报告 advice 条目深链接 #advice?id=…，建议页按 id 置顶定位', () => {
    const pages = read('./pages.js');
    expect(pages).toContain('`#advice?id=${' + 'encodeURIComponent(item.entityId)}`');
    expect(pages).toContain('routeAdviceId');
    expect(pages).toContain('data-advice-id');
    expect(pages).toContain('card.dataset.adviceId = advice.id');
  });
});

describe('策略工作台高级 tab 收深', () => {
  const route = read('./strategy-workspace-route.js');
  const workspace = read('./strategy-workspace.js');

  it('路由文件声明基础 / 高级 tab 分组（实验、AI 洞察、闭环收深）', () => {
    expect(route).toContain("export const BASIC_TABS = ['overview', 'pool', 'runs', 'settings']");
    expect(route).toContain("export const ADVANCED_TABS = ['experiment', 'insights', 'cycle']");
  });

  it('tab 条基础按钮 + 「高级」折叠分组；高级 tab 的渲染分发保持直连', () => {
    expect(workspace).toContain('strategy-tabs-advanced');
    expect(workspace).toContain('ADVANCED_TABS.includes(state.tab)');
    expect(workspace).toContain("state.tab === 'experiment'");
    expect(workspace).toContain("state.tab === 'insights'");
    expect(workspace).toContain("state.tab === 'cycle'");
  });
});

describe('飞书通知设置入口', () => {
  it('提供脱敏 Webhook 配置与显式测试按钮', () => {
    expect(html).toContain('id="feishu-settings-form"');
    expect(html).toContain('id="feishu-webhook-url"');
    expect(html).toContain('type="password"');
    expect(html).toContain('id="btn-feishu-test"');
    expect(appJs).toContain('initFeishuSettings');
    expect(read('./feishu-settings.js')).toContain('/api/settings/feishu/test');
  });
});

describe('数据导出导入入口', () => {
  it('设置页提供分类选择、导出和导入控件', () => {
    const dataTransfer = read('./data-transfer.js');
    expect(html).toContain('id="data-transfer-categories"');
    expect(html).toContain('id="btn-data-export"');
    expect(html).toContain('id="data-import-file"');
    expect(html).toContain('id="btn-data-import"');
    expect(appJs).toContain('initDataTransfer');
    expect(dataTransfer).toContain('/api/data/export');
    expect(dataTransfer).toContain('/api/data/import');
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
    expect(html).toContain('id="research-hybrid-search"');
    expect(html).toContain('id="research-embedding-status"');
    expect(html).toContain('id="research-embedding-rebuild-btn"');
    expect(html).toContain('id="research-embedding-evaluate-btn"');
  });

  it('页面写入经过预览确认和统一 tool call', () => {
    expect(read('./pages.js')).toContain('确认写入 managed Vault');
    expect(read('./pages.js')).toContain('/api/tools/${' + 'toolName}/call');
    expect(read('./pages.js')).toContain('import_local_research_document');
    expect(read('./pages.js')).toContain('import_remote_research_document');
    expect(read('./pages.js')).toContain('/api/settings/research-vault');
    expect(read('./pages.js')).toContain('/api/research/search/hybrid');
    expect(read('./pages.js')).toContain('/api/research/embeddings/rebuild');
    expect(read('./pages.js')).toContain('/api/research/embeddings/evaluate');
    expect(read('./pages.js')).toContain("result.status === 'failed'");
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
  it('指数条 / 市场概览 / 迷你热力 / 要闻 / 实时看板 / 今日预警容器齐全', () => {
    expect(html).toContain('id="dashboard-indices"');
    expect(html).toContain('id="dashboard-overview"');
    expect(html).toContain('id="dash-sector-heatmap"');
    expect(html).toContain('id="dash-news-list"');
    expect(html).toContain('id="dashboard-board"');
    expect(html).toContain('id="dashboard-board-meta"');
    expect(html).toContain('id="dash-trigger-list"');
    expect(html).toContain('id="dash-advice-list"');
  });

  it('区块顺序：指数条 → 市场概览 → 热力/要闻两栏 → 看板 → 两栏 → watch rail → 数据健康（页底）', () => {
    const order = [
      'id="dashboard-indices"',
      'id="dashboard-overview"',
      'id="dash-sector-heatmap"',
      'id="dash-news-list"',
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

  it('持仓汇总卡片已迁出看盘页（无 dashboard-stats / dash-total-value）', () => {
    expect(html).not.toContain('id="dashboard-stats"');
    expect(html).not.toContain('id="dash-total-value"');
    expect(html).not.toContain('id="dash-holdings-count"');
  });

  it('今日建议条数并入建议卡片 meta（dash-advice-meta），不丢信息', () => {
    expect(html).toContain('id="dash-advice-meta"');
    expect(read('./pages.js')).toContain("$('#dash-advice-meta')");
  });
});

describe('持仓页汇总卡片', () => {
  it('持仓页顶部有 holdings-stats（总市值 / 总盈亏 / 持仓数），数据来自 /api/holdings', () => {
    expect(html).toContain('id="holdings-stats"');
    expect(html).toContain('id="holdings-stat-total-value"');
    expect(html).toContain('id="holdings-stat-total-pnl"');
    expect(html).toContain('id="holdings-stat-count"');
    const pages = read('./pages.js');
    expect(pages).toContain("$('#holdings-stat-total-value')");
    expect(pages).toContain("$('#holdings-stat-count')");
  });
});

describe('看盘页市场行情区块', () => {
  it('dashboard-market.js 接入 app.js 的 dashboard 路由，且不进 5s 轮询', () => {
    const appJs = read('./app.js');
    expect(appJs).toContain("import { renderDashboardMarketBlocks } from './dashboard-market.js'");
    expect(appJs).toContain('renderDashboardMarketBlocks()');
    // 5s 轮询只调 renderDashboard，行情区块按路由进入加载一次
    expect(appJs).toContain("currentHash() === 'dashboard') void renderDashboard(setStatus)");
  });

  it('迷你热力与 sectors 页共用 sector-heatmap.js', () => {
    expect(read('./dashboard-market.js')).toContain("from './sector-heatmap.js'");
    expect(read('./sectors.js')).toContain("from './sector-heatmap.js'");
    expect(read('./dashboard-market.js')).toContain("'#sectors'");
  });

  it('要闻区块走 /api/news（fetch_news tool）', () => {
    const news = read('./dashboard-market.js');
    expect(news).toContain('/api/news');
    expect(news).toContain('encodeURIComponent(source)');
    expect(news).toContain('wrap.onscroll');
    expect(news).toContain('openModal(item.title');
    expect(html).toContain('data-news-source="eastmoney"');
    expect(html).toContain('data-news-source="10jqka"');
    expect(html).toContain('data-news-source="10jqka">同花顺</button>');
    expect(html).not.toContain('id="dash-news-meta"');
  });

  it('板块页支持日期上下文、列表排序与双侧 15 个极值热力图', () => {
    const sectors = read('./sectors.js');
    const heatmap = read('./sector-heatmap.js');
    expect(sectors).toContain("type = 'date'");
    expect(sectors).toContain('板块列表');
    expect(sectors).toContain('sortItems');
    expect(sectors).toContain('all=true');
    expect(heatmap).toContain('selectSectorExtremes');
    expect(heatmap).toContain('limit = 15');
  });
});

describe('行情页指数条', () => {
  it('个股详情移除标题区和指数条', () => {
    const marketSection = html.slice(
      html.indexOf('id="route-market"'),
      html.indexOf('id="route-holdings"'),
    );
    expect(marketSection).not.toContain('class="route-header"');
    expect(html).not.toContain('id="market-indices"');
    expect(read('./market.js')).not.toContain('/api/market/indices');
  });
});

describe('个股估值信息', () => {
  it('报价卡展示市值、PE、PS、PB 与股本字段', () => {
    expect(html).toContain('id="market-quote-total-market-cap"');
    expect(html).toContain('id="market-quote-pe-ttm"');
    expect(html).toContain('id="market-quote-ps-ttm"');
    expect(html).toContain('id="market-quote-pb"');
    expect(read('./market-quote.js')).toContain('quote.quote.totalMarketCap');
  });
});

describe('看盘页指数卡片', () => {
  it('dashboard 用 renderIndexCards 渲染 4 张核心指数卡（数据空仍渲染）', () => {
    const pages = read('./pages.js');
    expect(pages).toContain("import { renderIndexCards } from './index-strip.js'");
    expect(pages).toContain("renderIndexCards('dashboard-indices'");
    expect(read('./index-strip.js')).toContain('renderIndexCards');
    expect(html).toContain('id="dashboard-indices" class="index-card-grid dashboard-index-grid"');
  });

  it('看盘页直接展示 4 张指数卡，点击卡片进入指数页并带上指数 code', () => {
    expect(html).toContain('id="dashboard-indices" class="index-card-grid dashboard-index-grid"');
    const pages = read('./pages.js');
    expect(pages).toContain('indices?code=');
    expect(pages).toContain('encodeURIComponent(code)');
  });
});

describe('指数页结构', () => {
  it('导航「看盘」后有「指数」菜单项，#route-indices section 存在', () => {
    expect(html).toContain('href="#indices" data-route="indices"');
    expect(html).toContain('id="route-indices"');
  });

  it('指数页容器齐全：6 卡网格 / 分时图 / 明细', () => {
    expect(html).toContain('id="indices-cards"');
    expect(html).toContain('id="indices-chart-card"');
    expect(html).toContain('id="indices-chart-title"');
    expect(html).toContain('id="indices-chart"');
    expect(html).toContain('id="indices-detail"');
  });

  it('app.js 接入 indices 路由并负责 teardown（10s 轮询定时器）', () => {
    expect(appJs).toContain("'indices'");
    expect(appJs).toContain("import { renderIndicesPage, teardownIndices } from './indices.js'");
    expect(appJs).toContain('teardownIndices();');
    expect(appJs).toContain('renderIndicesPage(setStatus)');
  });

  it('指数定义表独立成 index-defs.js，被卡片渲染与指数页共用', () => {
    expect(read('./index-defs.js')).toContain('INDEX_DEFS');
    expect(read('./index-defs.js')).toContain('DASHBOARD_INDEX_CODES');
    expect(read('./pages.js')).toContain("from './index-defs.js'");
    expect(read('./indices.js')).toContain("from './index-defs.js'");
  });
});

describe('行情页空态 A 股情绪面板', () => {
  it('报价头股票代码是安全的新标签页雪球外链', () => {
    expect(html).toContain('class="muted mono market-quote-code-link"');
    expect(html).toContain('id="market-quote-code"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(read('./market-quote.js')).toContain('xueqiuStockUrl(stock.id)');
  });

  it('空态容器存在，数据源为 get_ashare_sentiment（includeIndexes: false）', () => {
    expect(html).toContain('id="market-sentiment"');
    const sentiment = read('./market-sentiment.js');
    expect(sentiment).toContain('get_ashare_sentiment');
    expect(sentiment).toContain('includeIndexes: false');
    expect(read('./market.js')).toContain('renderMarketSentiment');
  });
});

describe('设置页数据同步入口', () => {
  it('状态表 / 两个同步按钮 / app.js init 接线齐全', () => {
    expect(html).toContain('id="market-sync-status"');
    expect(html).toContain('id="btn-sync-universe"');
    expect(html).toContain('id="btn-sync-daily-bars"');
    expect(html).toContain('id="market-sync-message"');
    expect(appJs).toContain('initMarketSync');
    expect(appJs).toContain('renderMarketSyncStatus');
    const sync = read('./market-sync.js');
    expect(sync).toContain('/api/market-data-status');
    expect(sync).toContain('sync_stock_universe');
    expect(sync).toContain('sync_daily_bars');
    expect(sync).toContain('timeoutMs: 300_000');
  });
});

describe('建议页删除', () => {
  it('头部筛选旁有「删除」模式按钮；批量操作条初始隐藏', () => {
    expect(html).toContain('id="btn-advice-delete-mode" class="btn btn-outline btn-sm"');
    expect(html).toContain('id="advice-batch-bar" class="batch-bar" hidden');
  });

  it('adviceCard 只按选择模式渲染勾选框（不再有卡片行尾删除按钮）', () => {
    const ui = read('./ui.js');
    expect(ui).toContain("'advice-select'");
    expect(ui).toContain('onToggleSelect');
    expect(ui).not.toContain('advice-delete');
    expect(ui).not.toContain('onDelete');
    expect(ui).toContain('event.target instanceof HTMLInputElement');
  });

  it('pages.js 接线：选择模式状态 / 批量条确认删除置灰 / confirmDialog / POST /api/advice/delete', () => {
    const pages = read('./pages.js');
    expect(pages).toContain('adviceSelectMode');
    expect(pages).toContain('selectedAdviceIds');
    expect(pages).toContain('resetAdviceDeleteMode');
    expect(pages).toContain('toggleAdviceDeleteMode');
    expect(pages).toContain("$('#advice-batch-bar')");
    expect(pages).toContain('confirmDelete.disabled = selectedAdviceIds.size === 0');
    expect(pages).toContain(
      "import { alertDialog, confirmDialog, promptDialog } from './modal.js'",
    );
    expect(pages).toContain("callApi('/api/advice/delete'");
  });

  it('app.js 接线：模式按钮绑定；筛选切换与路由离开都重置选择模式', () => {
    expect(appJs).toContain('resetAdviceDeleteMode');
    expect(appJs).toContain('toggleAdviceDeleteMode');
    expect(appJs).toContain("$('#btn-advice-delete-mode')");
    expect(appJs).toContain("if (safe !== 'advice') resetAdviceDeleteMode();");
  });
});

describe('龙虎榜页面入口', () => {
  const dragonJs = read('./dragon-tiger.js');

  it('侧栏「涨停梯队」后有「龙虎榜」菜单项，#route-dragon-tiger section 存在', () => {
    expect(html).toContain('href="#limit-up" data-route="limit-up"');
    expect(html).toContain('href="#dragon-tiger" data-route="dragon-tiger"><span>龙虎榜</span>');
    expect(html).toContain('id="route-dragon-tiger"');
    // 位置：涨停梯队之后、板块热力之前
    const navOrder = ['data-route="limit-up"', 'data-route="dragon-tiger"', 'data-route="sectors"'];
    const positions = navOrder.map((marker) => html.indexOf(marker));
    for (const pos of positions) expect(pos).toBeGreaterThan(-1);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('app.js 接入 dragon-tiger 路由并负责 teardown（60s 轮询定时器）', () => {
    expect(appJs).toContain("'dragon-tiger'");
    expect(appJs).toContain(
      "import { renderDragonTiger, teardownDragonTiger } from './dragon-tiger.js'",
    );
    expect(appJs).toContain('teardownDragonTiger();');
    expect(appJs).toContain('renderDragonTiger(setStatus)');
  });

  it('dragon-tiger.js 走 /api/dragon-tiger，60s 刷新且页面隐藏跳过，行详情复用 openModal', () => {
    expect(dragonJs).toContain('callApi(`/api/dragon-tiger?date=');
    expect(dragonJs).toContain("input.type = 'date'");
    expect(dragonJs).toContain('groupEntriesByStock');
    expect(dragonJs).toContain('entry.details.map');
    expect(dragonJs).toContain('detail.buySeats');
    expect(dragonJs).toContain('detail.sellSeats');
    expect(dragonJs).toContain('dragon-seat-table');
    expect(dragonJs).toContain('60_000');
    expect(dragonJs).toContain("document.visibilityState !== 'visible'");
    expect(dragonJs).toContain("import { closeModal, openModal } from './modal.js'");
    expect(dragonJs).toContain('stockCodeLink(entry.code, entry.code)');
    expect(dragonJs).toContain("'non-trading-day'");
    expect(dragonJs).toContain("'empty-list'");
  });

  it('涨停梯队代码与板块领涨股复用行情链接组件', () => {
    expect(read('./limit-up-ladder.js')).toContain('stockCodeLink(entry.code, entry.code)');
    expect(read('./sector-heatmap.js')).toContain('stockCodeLink(');
    expect(read('./sectors.js')).toContain('stockCodeLink(');
  });

  it('服务端暴露 GET /api/dragon-tiger（dragon_tiger_list tool）', () => {
    const serverTs = read('../../src/server.ts');
    expect(serverTs).toContain("app.get('/api/dragon-tiger'");
    expect(serverTs).toContain("invokeTool('dragon_tiger_list'");
  });
});
