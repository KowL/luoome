// @luoome/tui —— opentui 应用主体（布局 + 交互 + 数据加载）。
// 布局按 MVP-TASK §2.7：顶部固定免责声明横幅；左栏「持仓」表格；右栏「今日建议」；
// 底部快捷键栏；[d]/[s] 弹层。数据流按 ARCHITECTURE §11 场景 B：
// list_holdings → get_advice（已有建议）→ 缺失标的并发 analyze_stock。
//
// 注意：@opentui/core 是命令式 API（new Renderable / renderer.root.add），
// 不是 React 式声明式 API。本文件不 import 任何 React 概念。

import { type AdviceSchema, STANDARD_DISCLAIMERS, type ToolContext } from '@luoome/core';
import {
  AnalyzeStockOutput,
  GetAdviceOutput,
  GetAdviceStatsOutput,
  ListHoldingsOutput,
  toolRegistry,
} from '@luoome/tools';
import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  createCliRenderer,
  type KeyEvent,
  TextRenderable,
} from '@opentui/core';
import type { z } from 'zod';

// ---------- 配色（低饱和暖色系；A 股惯例：红涨绿跌） ----------

const COLORS = {
  banner: '#d4a24e', // 暖黄：免责声明横幅
  header: '#8a8f98', // 表头灰
  text: '#d6d6d6', // 正文
  muted: '#7a7f87', // 次要信息
  up: '#e06c75', // 涨 / 盈利：柔和红
  down: '#6a9955', // 跌 / 亏损：柔和绿
  warn: '#d4a24e', // hold / 提示：暖黄
  info: '#6aa9c9', // watch：灰蓝
  error: '#e06c75',
  selectedBg: '#2f3640', // 选中行底色
  overlayBg: '#1f232a',
  overlayBorder: '#5a6270',
} as const;

/**
 * 视图层使用的 Advice 类型取 zod schema 推导（与 tool 输出 parse 结果一致），
 * 而不是 core 的 Advice interface：exactOptionalPropertyTypes 下 core 的
 * `sourceTool?: string` 不接收 zod 推导的 `sourceTool?: string | undefined`。
 */
type AdviceView = z.infer<typeof AdviceSchema>;
type StatsView = z.infer<typeof GetAdviceStatsOutput>;

type AdviceDecisionName = AdviceView['decision'];

const DECISION_COLORS: Record<AdviceDecisionName, string> = {
  buy: COLORS.up,
  sell: COLORS.down,
  hold: COLORS.warn,
  watch: COLORS.info,
  avoid: COLORS.muted,
};

// ---------- 终端显示宽度工具（CJK 全角按 2 列计） ----------

/** 常见全角 / 宽字符区间（足够覆盖中文、日文、韩文与全角符号）。 */
const WIDE_CHAR = /[ᄀ-ᅟ⺀-鿏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;

const charWidth = (ch: string): number => (WIDE_CHAR.test(ch) ? 2 : 1);

const displayWidth = (s: string): number => {
  let width = 0;
  for (const ch of s) width += charWidth(ch);
  return width;
};

const padEnd = (s: string, width: number): string =>
  s + ' '.repeat(Math.max(0, width - displayWidth(s)));

const padStart = (s: string, width: number): string =>
  ' '.repeat(Math.max(0, width - displayWidth(s))) + s;

// ---------- 数字 / 日期格式化 ----------

const formatMoney = (value: number): string => value.toFixed(2);

const formatSigned = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;

/** core Percentage 为小数比率（0.0741 → "7.41%"）。 */
const formatPct = (ratio: number): string => `${(ratio * 100).toFixed(2)}%`;

const pad2 = (n: number): string => String(n).padStart(2, '0');

const formatDateTime = (d: Date): string =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
  `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// ---------- 视图状态 ----------

interface HoldingRow {
  readonly stockId: string;
  readonly code: string;
  readonly name: string;
  readonly quantity: number;
  readonly avgCost: number;
  readonly currentPrice: number;
  readonly pnl: number;
  readonly pnlPct: number;
  advice: AdviceView | null;
}

interface Totals {
  readonly totalValue: number;
  readonly totalPnL: number;
  readonly totalPnLPct: number;
}

interface OverlayState {
  readonly title: string;
  readonly lines: readonly string[];
  scroll: number;
}

interface AppState {
  rows: HoldingRow[];
  totals: Totals | null;
  selectedIndex: number;
  loading: boolean;
  error: string | null;
  overlay: OverlayState | null;
}

interface LineSpec {
  readonly text: string;
  readonly fg?: string;
  readonly bg?: string;
}

// ---------- tool 调用辅助（Tool 永不抛异常；!ok → 抛给统一错误行） ----------

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const callTool = async (name: string, input: unknown, ctx: ToolContext): Promise<unknown> => {
  const tool = toolRegistry.get(name);
  if (tool === undefined) throw new Error(`tool "${name}" 未注册`);
  const result = await tool.execute(input, ctx);
  if (!result.ok) throw new Error(`${name} 失败: ${JSON.stringify(result.error)}`);
  return result.data;
};

// ---------- 弹层内容构建 ----------

const detailLines = (row: HoldingRow, advice: AdviceView): string[] => {
  const lines: string[] = [
    `${row.stockId} ${row.name}`,
    `决策：${advice.decision.toUpperCase()}    信心度：${advice.confidence}%    周期：${advice.horizon}`,
    `有效期至：${formatDateTime(advice.validUntil)}（过期后不再采纳）`,
    '',
    '【核心论点】',
    `  ${advice.reasoning.premise}`,
    '',
    '【支持证据】',
    ...advice.reasoning.evidence.map((e) => `  - ${e}`),
    '',
    '【反证】（对立信息，务必一并考量）',
    ...advice.reasoning.counterEvidence.map((e) => `  - ${e}`),
    '',
    '【风险提示】',
    ...advice.risks.map((r) => `  - ${r}`),
    '',
    '【免责声明】',
    ...advice.disclaimers.map((d) => `  - ${d}`),
    '',
    '[esc] 关闭    [↑/↓] 滚动',
  ];
  return lines;
};

const statsLines = (stats: StatsView): string[] => {
  const lines: string[] = [
    `统计口径：全部建议（含已过期）`,
    '',
    `总条数：${stats.totalAdvices}    平均信心度：${stats.avgConfidence.toFixed(1)}%`,
    `跟单比例：${formatPct(stats.outcomeRate.followed)}    ` +
      `部分跟单：${formatPct(stats.outcomeRate.partiallyFollowed)}    ` +
      `忽略：${formatPct(stats.outcomeRate.ignored)}`,
    `跟单盈亏：${formatSigned(stats.pnlWhenFollowed)}    ` +
      `忽略盈亏：${formatSigned(stats.pnlWhenIgnored)}`,
    `高信心命中率（信心≥70 且跟单盈利）：${formatPct(stats.hitRate)}`,
    '',
    '【按决策分解】',
  ];
  const decisions: readonly AdviceDecisionName[] = ['buy', 'sell', 'hold', 'watch', 'avoid'];
  for (const decision of decisions) {
    const s = stats.byDecision[decision];
    if (s.totalAdvices === 0) continue;
    lines.push(
      `  ${padEnd(decision.toUpperCase(), 7)}${padStart(String(s.totalAdvices), 3)} 条    ` +
        `平均信心 ${s.avgConfidence.toFixed(1)}%    命中率 ${formatPct(s.hitRate)}    ` +
        `跟单盈亏 ${formatSigned(s.pnlWhenFollowed)}`,
    );
  }
  lines.push('', '[esc] 关闭    [↑/↓] 滚动');
  return lines;
};

// ---------- 应用构建 ----------

/**
 * 在给定 renderer 上构建整个 TUI（布局 / 键盘 / 数据加载），并启动首次加载。
 * 返回的 Promise 在 renderer 销毁时 resolve（q 退出 / Ctrl+C / 外部 destroy）。
 *
 * 与 createCliRenderer 解耦：headless 冒烟用 @opentui/core/testing 的
 * createTestRenderer 驱动同一套代码。
 */
export const createTuiApp = (renderer: CliRenderer, ctx: ToolContext): Promise<void> => {
  const state: AppState = {
    rows: [],
    totals: null,
    selectedIndex: 0,
    loading: false,
    error: null,
    overlay: null,
  };

  // ----- 布局：column（banner / body / footer）+ absolute overlay -----

  renderer.root.flexDirection = 'column';

  // 顶部固定横幅：STANDARD_DISCLAIMERS 前两条拼接（tuple 索引，类型安全）。
  const banner = new TextRenderable(renderer, {
    id: 'banner',
    height: 1,
    truncate: true,
    fg: COLORS.banner,
    content: `${STANDARD_DISCLAIMERS[0]} ${STANDARD_DISCLAIMERS[1]}`,
  });
  renderer.root.add(banner);

  const body = new BoxRenderable(renderer, {
    id: 'body',
    flexDirection: 'row',
    flexGrow: 1,
    overflow: 'hidden',
  });
  renderer.root.add(body);

  const leftPanel = new BoxRenderable(renderer, {
    id: 'holdings-panel',
    width: '50%',
    border: true,
    title: '持仓',
    flexDirection: 'column',
    overflow: 'hidden',
  });
  body.add(leftPanel);

  const leftRows = new BoxRenderable(renderer, {
    id: 'holdings-rows',
    flexDirection: 'column',
    flexGrow: 1,
    overflow: 'hidden',
  });
  leftPanel.add(leftRows);

  const rightPanel = new BoxRenderable(renderer, {
    id: 'advice-panel',
    flexGrow: 1,
    border: true,
    title: '今日建议',
    flexDirection: 'column',
    overflow: 'hidden',
  });
  body.add(rightPanel);

  const rightRows = new BoxRenderable(renderer, {
    id: 'advice-rows',
    flexDirection: 'column',
    flexGrow: 1,
    overflow: 'hidden',
  });
  rightPanel.add(rightRows);

  const footer = new TextRenderable(renderer, {
    id: 'footer',
    height: 1,
    truncate: true,
    fg: COLORS.muted,
    content: '[r] 刷新  [q] 退出  [d] 建议详情  [s] 复盘统计  [↑/k ↓/j] 选择  [esc] 关闭弹层',
  });
  renderer.root.add(footer);

  // 弹层（建议详情 / 复盘统计共用）：absolute 居中，默认隐藏。
  const overlay = new BoxRenderable(renderer, {
    id: 'overlay',
    position: 'absolute',
    top: 2,
    left: '8%',
    width: '84%',
    height: Math.max(10, renderer.height - 4),
    border: true,
    backgroundColor: COLORS.overlayBg,
    borderColor: COLORS.overlayBorder,
    visible: false,
    zIndex: 100,
    flexDirection: 'column',
    overflow: 'hidden',
  });
  const overlayText = new TextRenderable(renderer, {
    id: 'overlay-text',
    flexGrow: 1,
    fg: COLORS.text,
    wrapMode: 'word',
    content: '',
  });
  overlay.add(overlayText);
  renderer.root.add(overlay);

  const requestRender = (): void => {
    if (!renderer.isDestroyed) renderer.requestRender();
  };

  renderer.on(CliRenderEvents.RESIZE, () => {
    overlay.height = Math.max(10, renderer.height - 4);
    requestRender();
  });

  // ----- 面板渲染 -----

  const setLines = (container: BoxRenderable, lines: readonly LineSpec[]): void => {
    for (const child of container.getChildren()) {
      container.remove(child);
      child.destroyRecursively();
    }
    for (const line of lines) {
      container.add(
        new TextRenderable(renderer, {
          height: 1,
          truncate: true,
          content: line.text,
          ...(line.fg !== undefined ? { fg: line.fg } : {}),
          ...(line.bg !== undefined ? { bg: line.bg } : {}),
        }),
      );
    }
  };

  const pnlColor = (pnl: number): string | undefined =>
    pnl > 0 ? COLORS.up : pnl < 0 ? COLORS.down : undefined;

  const renderHoldings = (): void => {
    if (state.error !== null) {
      setLines(leftRows, [{ text: `加载失败：${state.error}`, fg: COLORS.error }]);
      return;
    }
    const lines: LineSpec[] = [
      {
        text:
          padEnd('代码', 9) +
          padEnd('名称', 11) +
          padStart('数量', 6) +
          padStart('成本', 9) +
          padStart('现价', 9) +
          padStart('盈亏', 11),
        fg: COLORS.header,
      },
    ];
    state.rows.forEach((row, index) => {
      const text =
        padEnd(row.code, 9) +
        padEnd(row.name, 11) +
        padStart(String(row.quantity), 6) +
        padStart(formatMoney(row.avgCost), 9) +
        padStart(formatMoney(row.currentPrice), 9) +
        padStart(formatSigned(row.pnl), 11);
      const fg = pnlColor(row.pnl);
      lines.push({
        text,
        ...(fg !== undefined ? { fg } : {}),
        ...(index === state.selectedIndex ? { bg: COLORS.selectedBg } : {}),
      });
    });
    if (state.rows.length === 0 && !state.loading) {
      lines.push({ text: '（无持仓）', fg: COLORS.muted });
    }
    if (state.totals !== null) {
      const t = state.totals;
      const totalFg = pnlColor(t.totalPnL);
      lines.push({
        text: `合计 市值 ${formatMoney(t.totalValue)}  盈亏 ${formatSigned(t.totalPnL)} (${formatPct(t.totalPnLPct)})`,
        ...(totalFg !== undefined ? { fg: totalFg } : {}),
      });
    }
    setLines(leftRows, lines);
  };

  const renderAdvice = (): void => {
    if (state.loading && state.rows.length === 0) {
      setLines(rightRows, [{ text: '分析中…（对每个持仓生成 / 读取建议）', fg: COLORS.muted }]);
      return;
    }
    const lines: LineSpec[] = [
      {
        text:
          padEnd('代码', 9) +
          padEnd('名称', 11) +
          padEnd('决策', 8) +
          padStart('信心', 5) +
          '  周期',
        fg: COLORS.header,
      },
    ];
    state.rows.forEach((row, index) => {
      const advice = row.advice;
      const text =
        padEnd(row.code, 9) +
        padEnd(row.name, 11) +
        padEnd(advice === null ? '--' : advice.decision.toUpperCase(), 8) +
        padStart(advice === null ? '--' : `${advice.confidence}%`, 5) +
        `  ${advice === null ? '--' : advice.horizon}`;
      lines.push({
        text,
        fg: advice === null ? COLORS.muted : DECISION_COLORS[advice.decision],
        ...(index === state.selectedIndex ? { bg: COLORS.selectedBg } : {}),
      });
    });
    if (state.rows.length === 0 && !state.loading) {
      lines.push({ text: '（无建议）', fg: COLORS.muted });
    }
    setLines(rightRows, lines);
  };

  const renderOverlay = (): void => {
    const current = state.overlay;
    if (current === null) {
      overlay.visible = false;
      return;
    }
    overlay.title = current.title;
    overlayText.content = current.lines.join('\n');
    overlayText.scrollY = current.scroll;
    overlay.visible = true;
  };

  const renderAll = (): void => {
    if (renderer.isDestroyed) return;
    renderHoldings();
    renderAdvice();
    renderOverlay();
    requestRender();
  };

  // ----- 数据加载 -----

  const loadData = async (): Promise<void> => {
    // 1) 持仓（含现价与 PnL 汇总）
    const holdingsRaw = await callTool('list_holdings', {}, ctx);
    const holdingsData = ListHoldingsOutput.parse(holdingsRaw);

    // 2) 已有建议（get_advice，默认不含已过期），按 subjectId 取最新一条
    const adviceRaw = await callTool('get_advice', { subjectKind: 'stock', limit: 200 }, ctx);
    const adviceData = GetAdviceOutput.parse(adviceRaw);
    const latestBySubject = new Map<string, AdviceView>();
    for (const advice of adviceData.advices) {
      const existing = latestBySubject.get(advice.subjectId);
      if (existing === undefined || existing.createdAt.getTime() < advice.createdAt.getTime()) {
        latestBySubject.set(advice.subjectId, advice);
      }
    }

    const rows: HoldingRow[] = holdingsData.holdings.map((item) => {
      const code = item.holding.stockId.split('.')[0] ?? item.holding.stockId;
      return {
        stockId: item.holding.stockId,
        code,
        name: item.stockName,
        quantity: item.holding.quantity,
        avgCost: item.holding.avgCost,
        currentPrice: item.currentPrice,
        pnl: item.pnl,
        pnlPct: item.pnlPct,
        advice: latestBySubject.get(item.holding.stockId) ?? null,
      };
    });

    // 3) 没有有效建议的标的：并发 analyze_stock 生成并持久化
    await Promise.all(
      rows.map(async (row) => {
        if (row.advice !== null) return;
        try {
          const raw = await callTool('analyze_stock', { stockId: row.stockId }, ctx);
          row.advice = AnalyzeStockOutput.parse(raw).advice;
        } catch {
          // 单标的分析失败不拖垮整屏：该行显示 '--'。
          row.advice = null;
        }
      }),
    );

    state.rows = rows;
    state.totals = {
      totalValue: holdingsData.totalValue,
      totalPnL: holdingsData.totalPnL,
      totalPnLPct: holdingsData.totalPnLPct,
    };
    if (state.selectedIndex >= rows.length) {
      state.selectedIndex = Math.max(0, rows.length - 1);
    }
  };

  const refresh = async (): Promise<void> => {
    if (state.loading || renderer.isDestroyed) return;
    state.loading = true;
    state.error = null;
    renderAll();
    try {
      await loadData();
    } catch (error) {
      state.error = describeError(error);
    } finally {
      state.loading = false;
      renderAll();
    }
  };

  // ----- 弹层操作 -----

  const openOverlay = (title: string, lines: readonly string[]): void => {
    state.overlay = { title, lines, scroll: 0 };
    renderAll();
  };

  const closeOverlay = (): void => {
    state.overlay = null;
    renderAll();
  };

  const scrollOverlay = (delta: number): void => {
    const current = state.overlay;
    if (current === null) return;
    current.scroll = Math.max(0, current.scroll + delta);
    renderAll();
  };

  const openDetail = (): void => {
    const row = state.rows[state.selectedIndex];
    if (row === undefined) return;
    if (row.advice === null) {
      openOverlay('建议详情', [
        `${row.stockId} ${row.name} 暂无有效建议。`,
        '',
        '（analyze_stock 未产出或已有建议均已过期；可按 r 刷新重试）',
        '',
        '[esc] 关闭',
      ]);
      return;
    }
    openOverlay(`建议详情 ${row.code} ${row.name}`, detailLines(row, row.advice));
  };

  const openStats = async (): Promise<void> => {
    openOverlay('复盘统计', ['统计中…', '', '[esc] 关闭']);
    try {
      const raw = await callTool('get_advice_stats', {}, ctx);
      const stats = GetAdviceStatsOutput.parse(raw);
      // 若统计期间用户已关闭弹层，不强行再打开。
      if (state.overlay === null || state.overlay.title !== '复盘统计') return;
      openOverlay('复盘统计', statsLines(stats));
    } catch (error) {
      if (state.overlay === null) return;
      openOverlay('复盘统计', [`统计失败：${describeError(error)}`, '', '[esc] 关闭']);
    }
  };

  // ----- 键盘 -----

  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (renderer.isDestroyed) return;
    if (state.overlay !== null) {
      if (key.name === 'escape' || key.name === 'q') closeOverlay();
      else if (key.name === 'up' || key.name === 'k') scrollOverlay(-1);
      else if (key.name === 'down' || key.name === 'j') scrollOverlay(1);
      return;
    }
    switch (key.name) {
      case 'q':
        renderer.destroy();
        break;
      case 'r':
        void refresh();
        break;
      case 'd':
        openDetail();
        break;
      case 's':
        void openStats();
        break;
      case 'up':
      case 'k':
        if (state.selectedIndex > 0) {
          state.selectedIndex -= 1;
          renderAll();
        }
        break;
      case 'down':
      case 'j':
        if (state.selectedIndex < state.rows.length - 1) {
          state.selectedIndex += 1;
          renderAll();
        }
        break;
      default:
        break;
    }
  });

  // 启动即加载（ARCHITECTURE §11 场景 B）。
  void refresh();

  // v0.2 起 5s 自动刷新（plan-v0.2-v0.3 §3.8）：保持右侧「今日建议」面板新鲜；
  // 用户按 r 也可手动刷新（走同一 refresh 路径）。setInterval 不会被 keypress
  // handler 中断；renderer 销毁时由 onDestroy 清掉 interval。
  const refreshIntervalMs = 5_000;
  const intervalHandle = setInterval(() => {
    void refresh();
  }, refreshIntervalMs);
  renderer.on(CliRenderEvents.DESTROY, () => {
    clearInterval(intervalHandle);
  });

  return new Promise<void>((resolve) => {
    renderer.on(CliRenderEvents.DESTROY, () => resolve());
  });
};

/**
 * 创建真实终端 renderer 并运行 TUI，直到用户退出。
 * 非 TTY 环境下 createCliRenderer 可能失败：包装为友好中文提示。
 */
export const runTui = async (ctx: ToolContext): Promise<void> => {
  let renderer: CliRenderer;
  try {
    renderer = await createCliRenderer();
  } catch (error) {
    throw new Error(
      `TUI 初始化失败：需要交互式终端（TTY）。请在真实终端中运行（如 luoome tui）。` +
        `原始错误：${describeError(error)}`,
    );
  }
  const done = createTuiApp(renderer, ctx);
  renderer.start();
  await done;
};
