// @luoome/tui —— opentui 应用主体（布局 + 交互 + 数据加载）。
// 布局按 MVP-TASK §2.7：顶部固定免责声明横幅；左栏「持仓」表格；右栏「今日建议」；
// 底部快捷键栏；[d]/[s] 弹层。数据流按 ARCHITECTURE §11 场景 B：
// list_holdings → get_advice（已有建议）→ 缺失标的并发 analyze_stock。
//
// 注意：@opentui/core 是命令式 API（new Renderable / renderer.root.add），
// 不是 React 式声明式 API。本文件不 import 任何 React 概念。

import {
  type AccountSchema,
  type AdviceSchema,
  STANDARD_DISCLAIMERS,
  type ToolContext,
} from '@luoome/core';
import {
  AnalyzeStockOutput,
  GetAdviceOutput,
  GetAdviceStatsOutput,
  GetConfidenceCalibrationOutput,
  ListAccountsOutput,
  ListHoldingsOutput,
  ListTacticsOutput,
  RunTacticOutput,
  ScoreSignalsOutput,
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
type AccountView = z.infer<typeof AccountSchema>;

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
  /** 弹层语义分支（仅用于键盘路由：账户选择 = accounts，可用 j/k/Enter）。 */
  readonly kind?: 'detail' | 'stats' | 'tactics' | 'outcomes' | 'accounts';
  scroll: number;
}

interface AppState {
  rows: HoldingRow[];
  totals: Totals | null;
  selectedIndex: number;
  loading: boolean;
  error: string | null;
  /** 全部账户列表（每次 refresh 同步，与 ctx 切账户语义一致）。 */
  accounts: AccountView[];
  /** 当前激活账户 id（与 ctxRef.current.user.defaultAccountId 同步）。 */
  currentAccountId: string;
  /** 账户选择弹层的高亮 cursor（overlay 打开时使用）。 */
  accountCursor: number;
  overlay: OverlayState | null;
}

/**
 * 用对象包裹 ctx 引用，便于运行时切换 defaultAccountId；所有 callTool 走 ctxRef.current。
 * 切账户 = clone(ctx).user = clone(user) + 覆盖 defaultAccountId，不动 repos / adapters /
 * notification / clock / logger。
 */
interface CtxRef {
  current: ToolContext;
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
  const ctxRef: CtxRef = { current: ctx };
  const state: AppState = {
    rows: [],
    totals: null,
    selectedIndex: 0,
    loading: false,
    error: null,
    accounts: [],
    currentAccountId: ctx.user.defaultAccountId,
    accountCursor: 0,
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

  // TUI 顶部第二行：当前账户（紧贴 banner 下沿），默认 / 切账户后实时刷新；
  // 始终贴左写入，右半边 footer 的快捷键提示通过 truncate 自然容纳。
  const accountBar = new TextRenderable(renderer, {
    id: 'account-bar',
    height: 1,
    truncate: true,
    fg: COLORS.info,
    content: '账户：--',
  });
  renderer.root.add(accountBar);

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
    content:
      '[r] 刷新  [q] 退出  [d] 详情  [s] 统计  [c] 校准  [t] 战法  [o] 复盘  [a] 账户  [↑/↓] 滚动  [esc] 关闭',
  });
  renderer.root.add(footer);

  // 弹层（建议详情 / 复盘统计共用）：absolute 居中，默认隐藏。
  const overlay = new BoxRenderable(renderer, {
    id: 'overlay',
    position: 'absolute',
    top: 3,
    left: '8%',
    width: '84%',
    height: Math.max(10, renderer.height - 5),
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
    overlay.height = Math.max(10, renderer.height - 5);
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
    renderAccountBar();
    requestRender();
  };

  /** 把当前账户名渲染到顶栏 accountBar；缺省显示（未加载完）。 */
  const renderAccountBar = (): void => {
    const current = state.accounts.find((a) => a.id === state.currentAccountId);
    if (current === undefined) {
      accountBar.content = `账户：--（按 [a] 选择账户）`;
      return;
    }
    const total = state.accounts.length;
    const tally = state.rows.reduce((sum, r) => sum + r.pnl, 0);
    const tallyStr = state.rows.length === 0 ? '' : `    浮盈 ${formatSigned(tally)}`;
    accountBar.content =
      `账户：[${current.name}] (${current.currency} ${formatMoney(current.initialCapital)})    ` +
      `共 ${total} 个账户${tallyStr}    [a] 切换`;
  };

  // ----- 数据加载 -----

  const loadData = async (): Promise<void> => {
    // 0) 账户列表（每次 refresh 同步；切账户 → 当前账户 id 跟随）
    const accountsRaw = await callTool('list_accounts', {}, ctxRef.current);
    const accountsData = ListAccountsOutput.parse(accountsRaw);
    state.accounts = accountsData.accounts;
    if (state.currentAccountId === '' && state.accounts.length > 0) {
      const first = state.accounts[0];
      if (first !== undefined) state.currentAccountId = first.id;
    }
    // 1) 持仓（含现价与 PnL 汇总）
    const holdingsRaw = await callTool('list_holdings', {}, ctxRef.current);
    const holdingsData = ListHoldingsOutput.parse(holdingsRaw);

    // 2) 已有建议（get_advice，默认不含已过期），按 subjectId 取最新一条
    const adviceRaw = await callTool(
      'get_advice',
      { subjectKind: 'stock', limit: 200 },
      ctxRef.current,
    );
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
          const raw = await callTool('analyze_stock', { stockId: row.stockId }, ctxRef.current);
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

  /**
   * openOverlay 的扩展版（v0.5 多账户切换）：允许 caller 指定 kind，
   * 键盘 handler 据此路由 j/k/Enter 等专用按键。
   */
  const openOverlayWithKind = (
    title: string,
    lines: readonly string[],
    kind: NonNullable<OverlayState['kind']>,
  ): void => {
    state.overlay = { title, lines, scroll: 0, kind };
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
      const raw = await callTool('get_advice_stats', {}, ctxRef.current);
      const stats = GetAdviceStatsOutput.parse(raw);
      // 若统计期间用户已关闭弹层，不强行再打开。
      if (state.overlay === null || state.overlay.title !== '复盘统计') return;
      openOverlay('复盘统计', statsLines(stats));
    } catch (error) {
      if (state.overlay === null) return;
      openOverlay('复盘统计', [`统计失败：${describeError(error)}`, '', '[esc] 关闭']);
    }
  };

  /**
   * 战法扫描（v0.3）：list_tactics → 并发 run_tactic × N → score_signals 精排 → top 10。
   * 与 workflow tactic-scan 等价语义，但通过 tool 直接串（不依赖 workflows 包）。
   */
  const openTactics = async (): Promise<void> => {
    openOverlay('战法扫描', [
      '扫描中…（list_tactics → run_tactic × N → score_signals）',
      '',
      '[esc] 关闭',
    ]);
    try {
      const listRaw = await callTool('list_tactics', { includeBuiltins: true }, ctxRef.current);
      const list = ListTacticsOutput.parse(listRaw);
      const tacticIds = list.tactics.map((t) => t.id);
      if (tacticIds.length === 0) {
        openOverlay('战法扫描', ['（无战法）', '', '[esc] 关闭']);
        return;
      }
      const runs = await Promise.all(
        tacticIds.map((id) =>
          callTool('run_tactic', { tacticId: id, scope: 'holdings' }, ctxRef.current),
        ),
      );
      const signals: Array<z.infer<typeof RunTacticOutput>['signals'][number]> = [];
      let totalEvaluated = 0;
      let totalTriggered = 0;
      for (const raw of runs) {
        const r = RunTacticOutput.parse(raw);
        totalEvaluated += r.evaluatedStocks;
        totalTriggered += r.triggeredCount;
        for (const s of r.signals) signals.push(s);
      }
      if (signals.length === 0) {
        openOverlay('战法扫描', [
          `战法数：${tacticIds.length}    评估：${totalEvaluated} 股    命中：${totalTriggered}`,
          '',
          '（当前持仓未命中任何战法信号）',
          '',
          '[esc] 关闭',
        ]);
        return;
      }
      const scoreRaw = await callTool(
        'score_signals',
        {
          signals: signals.map((s) => ({
            tacticId: s.tacticId,
            tacticName: s.tacticName,
            tacticTag: s.tacticTag,
            stockId: s.stockId,
            ts: s.ts,
            score: s.score,
            direction: s.direction,
            evidence: [...s.evidence],
          })),
        },
        ctxRef.current,
      );
      const scored = ScoreSignalsOutput.parse(scoreRaw);
      const top = scored.ranked.slice(0, 10);
      const lines: string[] = [
        `战法 ${tacticIds.length} 个    评估 ${totalEvaluated} 股    ` +
          `命中 ${totalTriggered}    精排 top ${top.length}`,
        '',
        `${padEnd('标的', 13)}${padEnd('战法', 14)}${padEnd('方向', 8)}${padStart('评分', 6)}  依据`,
      ];
      for (const s of top) {
        const code = s.stockId.split('.')[0] ?? s.stockId;
        lines.push(
          `${padEnd(code, 13)}${padEnd(s.tacticName, 14)}${padEnd(s.direction, 8)}` +
            `${padStart(s.llmScore.toFixed(1), 6)}  ${s.rationale}`,
        );
      }
      lines.push('', '[esc] 关闭    [↑/↓] 滚动');
      // 若扫描期间用户已关闭弹层，不强行再打开。
      if (state.overlay === null || state.overlay.title !== '战法扫描') return;
      openOverlay('战法扫描', lines);
    } catch (error) {
      if (state.overlay === null) return;
      openOverlay('战法扫描', [`扫描失败：${describeError(error)}`, '', '[esc] 关闭']);
    }
  };

  /**
   * outcome 复盘列表（v0.3）：拉最近 advice 列表，逐条标「已回填 / 待回填」状态。
   * 真正回填走 CLI / agent（write 副作用，TUI 不直接写）。
   */
  const openOutcomes = async (): Promise<void> => {
    openOverlay('outcome 复盘', ['加载中…', '', '[esc] 关闭']);
    try {
      const raw = await callTool('get_advice', { limit: 20, includeExpired: true }, ctxRef.current);
      const data = GetAdviceOutput.parse(raw);
      const lines: string[] = [
        `近 ${data.advices.length} 条建议（按创建时间倒序）`,
        '',
        `${padEnd('标的', 13)}${padEnd('决策', 8)}${padStart('信心', 6)}  outcome / 盈亏`,
      ];
      if (data.advices.length === 0) {
        lines.push('（暂无建议）');
      }
      for (const a of data.advices) {
        const code = a.subjectId.split('.')[0] ?? a.subjectId;
        const status = a.outcome === undefined ? '（待回填）' : a.outcome.outcome;
        const pnl = a.outcome?.pnl !== undefined ? formatSigned(a.outcome.pnl) : '--';
        lines.push(
          `${padEnd(code, 13)}${padEnd(a.decision.toUpperCase(), 8)}` +
            `${padStart(`${a.confidence}%`, 6)}  ${padEnd(status, 18)}${pnl}`,
        );
      }
      lines.push(
        '',
        '回填方式：luoome advice outcome <id> --followed true|false --pnl <amount>',
        '[esc] 关闭    [↑/↓] 滚动',
      );
      if (state.overlay === null || state.overlay.title !== 'outcome 复盘') return;
      openOverlay('outcome 复盘', lines);
    } catch (error) {
      if (state.overlay === null) return;
      openOverlay('outcome 复盘', [`加载失败：${describeError(error)}`, '', '[esc] 关闭']);
    }
  };

  // ----- 键盘 -----

  // ----- 账户切换（v0.5 W3）-----

  /**
   * 列出所有账户，高亮当前账户，提供 j/k 移动 cursor + Enter 选中。
   * 切账户 = 用新 defaultAccountId 构造新 ctx；repos / adapters / notification / clock /
   * logger 全部沿用（共享内存仓）。
   */

  // ----- confidence 自校准（v0.5 W4）-----

  /**
   * 历史 advice 按 confidence 桶聚合（10 一档：0-9 / 10-19 / ... / 90-100）。
   * 弹层显示：每桶 total / hits / hitRate / avgPnl / avgConfidence；
   * 用于让用户直观判断系统 confidence 是否被高估/低估，事后可在 review 阶段调 prompt。
   */
  const openCalibration = async (): Promise<void> => {
    openOverlay('confidence 校准', ['统计中…', '', '[esc] 关闭']);
    try {
      const raw = await callTool('get_confidence_calibration', {}, ctxRef.current);
      const data = GetConfidenceCalibrationOutput.parse(raw);
      if (state.overlay === null || state.overlay.title !== 'confidence 校准') return;
      openOverlay('confidence 校准', calibrationLines(data));
    } catch (error) {
      if (state.overlay === null) return;
      openOverlay('confidence 校准', [`加载失败：${describeError(error)}`, '', '[esc] 关闭']);
    }
  };

  const calibrationLines = (data: CalibrationView): string[] => {
    const lines: string[] = [
      `总条数：${data.totalAdvices}    已回填：${data.totalWithOutcome}    ` +
        `整体命中率：${formatPct(data.overallHitRate)}`,
      `生成时间：${formatDateTime(data.calibratedAt)}`,
      '',
      `${padEnd('信心桶', 9)}${padStart('条', 4)}  ${padStart('回填', 4)}  ` +
        `${padStart('命中', 4)}  ${padStart('hit', 7)}  ${padStart('avgPnl', 10)}  ${padStart('avgConf', 7)}`,
      ''.padEnd(60, '-'),
    ];
    for (const b of data.buckets) {
      const range = `${b.range.min}-${b.range.max}`;
      lines.push(
        `${padEnd(range, 9)}${padStart(String(b.total), 4)}  ` +
          `${padStart(String(b.withOutcome), 4)}  ${padStart(String(b.hits), 4)}  ` +
          `${padStart(formatPct(b.hitRate), 7)}  ${padStart(formatSigned(b.avgPnl), 10)}  ` +
          `${padStart(b.avgConfidence.toFixed(1), 7)}`,
      );
    }
    lines.push(
      '',
      '读法：横看每个信心桶的 hitRate。',
      '  • 高信心桶 hitRate 高 → confidence 校准有效；',
      '  • 高信心桶 hitRate 低 → 系统 confidence 可能高估；',
      '  • 低信心桶 hitRate 高 → 系统 confidence 偏保守。',
      '',
      '[esc] 关闭',
    );
    return lines;
  };

  const openAccounts = (): void => {
    if (state.accounts.length === 0) {
      openOverlay('切换账户', ['（无可用账户，按 esc 关闭）', '', '[esc] 关闭']);
      return;
    }
    // cursor 默认指向当前账户
    const idx = state.accounts.findIndex((a) => a.id === state.currentAccountId);
    state.accountCursor = idx >= 0 ? idx : 0;
    openOverlayWithKind('切换账户', formatAccountsLines(state.accountCursor), 'accounts');
  };

  const formatAccountsLines = (cursor: number): string[] => {
    const lines: string[] = [
      '账户切换：上下移动光标，Enter 选中，esc 取消',
      `当前账户：${state.accounts.find((a) => a.id === state.currentAccountId)?.name ?? '--'}`,
      '',
    ];
    for (let i = 0; i < state.accounts.length; i++) {
      const a = state.accounts[i];
      if (a === undefined) continue;
      const marker = i === cursor ? '> ' : '  ';
      const flag = a.id === state.currentAccountId ? '  [当前]' : '';
      lines.push(
        `${marker}${padEnd(a.name, 14)}${padStart(`${a.kind}/${a.currency}`, 12)}  ` +
          `${formatMoney(a.initialCapital)}${flag}`,
      );
    }
    lines.push('', '[esc] 取消    [↑/↓] 移动    [Enter] 选中');
    return lines;
  };

  /**
   * 切换账户：构造一份新 ctx（user.defaultAccountId 替换），不重新打开 DB。
   * 切换成功 → 关闭弹层 → 触发 refresh（持仓 / 建议 / 战法 全部按新账户重读）。
   */
  const setAccount = (accountId: string): void => {
    if (accountId === state.currentAccountId) {
      closeOverlay();
      return;
    }
    const next = state.accounts.find((a) => a.id === accountId);
    if (next === undefined) return;
    ctxRef.current = {
      ...ctxRef.current,
      user: { ...ctxRef.current.user, defaultAccountId: accountId },
    };
    state.currentAccountId = accountId;
    state.selectedIndex = 0;
    state.rows = [];
    state.totals = null;
    closeOverlay();
    void refresh();
  };

  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (renderer.isDestroyed) return;
    if (state.overlay !== null) {
      // 账户选择弹层专用按键路由（v0.5 W3）：上下移动 cursor + Enter 选中，
      // esc/q 仍走统一关闭。其他 kind（detail/stats/...）走原滚动逻辑。
      if (state.overlay.kind === 'accounts') {
        if (key.name === 'escape' || key.name === 'q') {
          closeOverlay();
        } else if (key.name === 'up' || key.name === 'k') {
          if (state.accountCursor > 0) {
            state.accountCursor -= 1;
            openOverlayWithKind('切换账户', formatAccountsLines(state.accountCursor), 'accounts');
          }
        } else if (key.name === 'down' || key.name === 'j') {
          if (state.accountCursor < state.accounts.length - 1) {
            state.accountCursor += 1;
            openOverlayWithKind('切换账户', formatAccountsLines(state.accountCursor), 'accounts');
          }
        } else if (key.name === 'return' || key.name === 'enter') {
          const next = state.accounts[state.accountCursor];
          if (next !== undefined) setAccount(next.id);
        }
        return;
      }
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
      case 'c':
        void openCalibration();
        break;
      case 't':
        void openTactics();
        break;
      case 'o':
        void openOutcomes();
        break;
      case 'a':
        openAccounts();
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
type CalibrationView = z.infer<typeof GetConfidenceCalibrationOutput>;
