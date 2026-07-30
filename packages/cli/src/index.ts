// @luoome/cli —— luoome 命令行入口（bin/luoome 转发到此，Bun 直跑 TS，无构建步骤）。
// 手写极简 argv 解析，不引第三方 CLI 框架。
// 子命令清单见 printHelp()；mcp / tui / web 为懒加载（对应包由 W4a/W4c/W4d 并行实现，
// 未就绪时给出友好错误而非栈追踪，联调存疑点见各 runLazy* 调用处注释）。

import { STANDARD_DISCLAIMERS } from '@luoome/core';
import { toolRegistry } from '@luoome/tools';

import { createCliContext } from './context.js';
import { isDaemonized, respawnDetached } from './daemon.js';
import { loadProjectEnv } from './env.js';
import { cmdMarketLimitUp } from './market-limit-up.js';
import { findPidOnPort, killPid, waitForProcessExit } from './restart.js';

const VERSION = '0.9.0';

// ---------- argv 解析 ----------

/** 需要跟值的 flag（`--key value` 或 `--key=value`）；其余 `--key` 视为 boolean 开关。 */
const VALUE_FLAGS = new Set([
  'input',
  'since',
  'until',
  'date',
  'days',
  'source',
  'port',
  'host',
  'limit',
  'pnl',
  'holding-hours',
  'notes',
  // v0.6 watch 子命令
  'interval',
  'alert-plan',
]);

interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string | boolean>;
}

/** 用法错误（exit code 2），区别于运行时失败（exit code 1）。 */
class CliUsageError extends Error {
  override readonly name = 'CliUsageError';
}

const parseArgv = (argv: readonly string[]): ParsedArgs => {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === '-h') {
      flags.set('help', true);
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq >= 0) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
        continue;
      }
      const key = token.slice(2);
      if (VALUE_FLAGS.has(key)) {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new CliUsageError(`flag --${key} 需要一个值（--${key} <value>）`);
        }
        flags.set(key, value);
        i += 1;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
};

const flagString = (
  flags: ReadonlyMap<string, string | boolean>,
  name: string,
): string | undefined => {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

// ---------- 输出工具：人类可读表格（CJK 宽字符对齐） ----------

/** 粗粒度宽字符判定（CJK / 全角），用于等宽终端列对齐。 */
const isWideCodePoint = (code: number): boolean =>
  (code >= 0x1100 && code <= 0x115f) ||
  (code >= 0x2e80 && code <= 0xa4cf) ||
  (code >= 0xac00 && code <= 0xd7a3) ||
  (code >= 0xf900 && code <= 0xfaff) ||
  (code >= 0xfe30 && code <= 0xfe4f) ||
  (code >= 0xff00 && code <= 0xff60) ||
  (code >= 0xffe0 && code <= 0xffe6) ||
  (code >= 0x20000 && code <= 0x3fffd);

const displayWidth = (s: string): number => {
  let width = 0;
  for (const ch of s) width += isWideCodePoint(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return width;
};

const padDisplay = (s: string, width: number): string => {
  const pad = width - displayWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
};

const truncateDisplay = (s: string, max: number): string => {
  if (displayWidth(s) <= max) return s;
  return `${[...s].slice(0, Math.max(1, max - 1)).join('')}…`;
};

const renderTable = (headers: readonly string[], rows: readonly (readonly string[])[]): string => {
  const widths = headers.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? ''))),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => padDisplay(c, widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    line(headers),
    line(widths.map((w) => '─'.repeat(Math.max(1, w)))),
    ...rows.map(line),
  ].join('\n');
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 本地时区 'YYYY-MM-DD HH:mm'；无效值原样转字符串兜底。 */
const fmtDateTime = (value: unknown): string => {
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const fmtPercent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

const fmtMoney = (value: number): string => value.toFixed(2);

const printJson = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2));
};

// ---------- --since 解析：相对时长（30m/24h/7d/4w）或 ISO 日期 ----------

const RELATIVE_SINCE_RE = /^(\d+)([mhdw])$/;

const parseSince = (raw: string): Date => {
  const match = RELATIVE_SINCE_RE.exec(raw.trim());
  if (match !== null) {
    const n = Number(match[1]);
    const unit = match[2];
    const unitMs =
      unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000; // 'w'
    return new Date(Date.now() - n * unitMs);
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new CliUsageError(
      `无法解析 --since 值: "${raw}"（支持相对时长 30m/24h/7d/4w 或 ISO 日期）`,
    );
  }
  return new Date(parsed);
};

const parsePositiveInt = (raw: string, flagName: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CliUsageError(`flag --${flagName} 需要正整数，收到 "${raw}"`);
  }
  return n;
};

// ---------- tools 子命令 ----------

const unknownToolError = (name: string): CliUsageError =>
  new CliUsageError(
    `未知 tool: "${name}"（可用: ${[...toolRegistry.all()]
      .map((t) => t.name)
      .sort()
      .join(', ')}）`,
  );

const cmdToolsList = (json: boolean): void => {
  const tools = [...toolRegistry.all()].sort((a, b) => a.name.localeCompare(b.name));
  if (json) {
    printJson(
      tools.map((t) => ({ name: t.name, sideEffect: t.sideEffect, description: t.description })),
    );
    return;
  }
  console.log(
    renderTable(
      ['NAME', 'SIDE_EFFECT', 'DESCRIPTION'],
      tools.map((t) => [t.name, t.sideEffect, t.description]),
    ),
  );
  console.log(`\n共 ${tools.length} 个 tool。`);
};

const cmdToolsInspect = (name: string): void => {
  // registry.toMCP() 的 inputSchema 即 z.toJSONSchema(io: 'input') 产物，与 MCP 暴露口径一致。
  const descriptor = toolRegistry.toMCP().find((d) => d.name === name);
  if (descriptor === undefined) throw unknownToolError(name);
  printJson(descriptor.inputSchema);
};

const cmdToolsCall = async (
  name: string,
  flags: ReadonlyMap<string, string | boolean>,
  json: boolean,
  requiredInput: Readonly<Record<string, unknown>> = {},
): Promise<number> => {
  const tool = toolRegistry.get(name);
  if (tool === undefined) throw unknownToolError(name);

  const rawInput = flagString(flags, 'input') ?? '{}';
  let input: unknown;
  try {
    input = JSON.parse(rawInput);
  } catch {
    throw new CliUsageError(`--input 不是合法 JSON: ${rawInput}`);
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CliUsageError('--input 必须是 JSON 对象');
  }
  input = { ...input, ...requiredInput };

  const handle = await createCliContext();
  try {
    const result = await tool.execute(input, handle.ctx);
    if (json) {
      printJson(result);
      return result.ok ? 0 : 1;
    }
    if (result.ok) {
      printJson(result.data);
      return 0;
    }
    console.error(`error [${result.error.kind}]:`);
    console.error(JSON.stringify(result.error, null, 2));
    return 1;
  } finally {
    handle.close();
  }
};

const requireId = (value: string | undefined, usage: string): string => {
  if (value === undefined) throw new CliUsageError(usage);
  return value;
};

const cmdStrategy = async (
  sub: string | undefined,
  rest: readonly string[],
  flags: ReadonlyMap<string, string | boolean>,
  json: boolean,
): Promise<number> => {
  if (sub === 'list') return cmdToolsCall('list_strategies', flags, json);
  if (sub === 'get') {
    return cmdToolsCall('get_strategy', flags, json, {
      strategyId: requireId(rest[0], '用法: luoome strategy get <strategyId>'),
    });
  }
  if (sub === 'validate') {
    return cmdToolsCall('validate_strategy_version', flags, json, {
      versionId: requireId(rest[0], '用法: luoome strategy validate <versionId>'),
    });
  }
  if (sub === 'run') {
    return cmdToolsCall('run_strategy', flags, json, {
      strategyId: requireId(rest[0], '用法: luoome strategy run <strategyId>'),
    });
  }
  throw new CliUsageError(
    `未知 strategy 子命令: "${sub ?? ''}"（支持 list / get / validate / run）`,
  );
};

const cmdWatchlist = async (
  sub: string | undefined,
  rest: readonly string[],
  flags: ReadonlyMap<string, string | boolean>,
  json: boolean,
): Promise<number> => {
  if (sub === 'list') return cmdToolsCall('list_watchlists', flags, json);
  if (sub === 'get') {
    return cmdToolsCall('get_watchlist', flags, json, {
      watchlistId: requireId(rest[0], '用法: luoome watchlist get <watchlistId>'),
    });
  }
  if (sub === 'sync') return cmdWorkflowRun('sync-portfolio-watchlists', flags, json);
  throw new CliUsageError(`未知 watchlist 子命令: "${sub ?? ''}"（支持 list / get / sync）`);
};

const cmdAlert = (
  sub: string | undefined,
  flags: ReadonlyMap<string, string | boolean>,
  json: boolean,
): Promise<number> => {
  if (sub === 'list') return cmdToolsCall('list_alert_plans', flags, json);
  throw new CliUsageError(`未知 alert 子命令: "${sub ?? ''}"（支持 list）`);
};

// ---------- advice 子命令 ----------

interface AdviceView {
  readonly id: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly decision: string;
  readonly confidence: number;
  readonly horizon: string;
  readonly sourceTool?: string;
  readonly reasoning: { readonly premise: string };
  readonly validUntil: unknown;
}

interface AdviceListData {
  readonly advices: readonly AdviceView[];
  readonly total: number;
}

const cmdAdviceList = async (
  flags: ReadonlyMap<string, string | boolean>,
  json: boolean,
): Promise<number> => {
  const tool = toolRegistry.get('get_advice');
  if (tool === undefined) throw unknownToolError('get_advice');

  const input: Record<string, unknown> = { includeExpired: flags.has('include-expired') };
  const sinceRaw = flagString(flags, 'since');
  if (sinceRaw !== undefined) input.since = parseSince(sinceRaw).toISOString();
  const untilRaw = flagString(flags, 'until');
  if (untilRaw !== undefined) input.until = parseSince(untilRaw).toISOString();
  const limitRaw = flagString(flags, 'limit');
  if (limitRaw !== undefined) input.limit = parsePositiveInt(limitRaw, 'limit');

  const handle = await createCliContext();
  try {
    const result = await tool.execute(input, handle.ctx);
    if (!result.ok) {
      if (json) printJson(result);
      else console.error(`error [${result.error.kind}]: ${JSON.stringify(result.error)}`);
      return 1;
    }
    const data = result.data as AdviceListData;
    if (json) {
      printJson(result);
      return 0;
    }
    if (data.advices.length === 0) {
      console.log('（无匹配建议；--include-expired 可包含已过期，--since 可调整时间窗）');
      return 0;
    }
    console.log(
      renderTable(
        ['ID', 'SUBJECT', 'DECISION', 'CONF', 'HORIZON', 'VALID_UNTIL', 'PREMISE'],
        data.advices.map((a) => [
          truncateDisplay(a.id, 20),
          `${a.subjectKind}:${a.subjectId}`,
          a.decision,
          String(a.confidence),
          a.horizon,
          fmtDateTime(a.validUntil),
          truncateDisplay(a.reasoning.premise, 48),
        ]),
      ),
    );
    console.log(`\n共 ${data.total} 条。`);
    // AGENTS.md 硬约束：向用户复述 advice 必须带 disclaimers。Advice 不变量保证
    // 每条建议均含 STANDARD_DISCLAIMERS 三条，列表尾部统一展示（docs/archive/MVP-TASK.md §6 验收口径）。
    console.log('\n免责声明（每条建议均含）:');
    for (const line of STANDARD_DISCLAIMERS) console.log(`  - ${line}`);
    return 0;
  } finally {
    handle.close();
  }
};

interface FlatStatsView {
  readonly totalAdvices: number;
  readonly avgConfidence: number;
  readonly outcomeRate: {
    readonly followed: number;
    readonly partiallyFollowed: number;
    readonly ignored: number;
  };
  readonly pnlWhenFollowed: number;
  readonly pnlWhenIgnored: number;
  readonly hitRate: number;
}

interface AdviceStatsData extends FlatStatsView {
  readonly byDecision: Record<string, FlatStatsView>;
}

const cmdAdviceStats = async (
  flags: ReadonlyMap<string, string | boolean>,
  json: boolean,
): Promise<number> => {
  const tool = toolRegistry.get('get_advice_stats');
  if (tool === undefined) throw unknownToolError('get_advice_stats');

  const input: Record<string, unknown> = {};
  const sinceRaw = flagString(flags, 'since');
  if (sinceRaw !== undefined) input.since = parseSince(sinceRaw).toISOString();
  const untilRaw = flagString(flags, 'until');
  if (untilRaw !== undefined) input.until = parseSince(untilRaw).toISOString();

  const handle = await createCliContext();
  try {
    const result = await tool.execute(input, handle.ctx);
    if (!result.ok) {
      if (json) printJson(result);
      else console.error(`error [${result.error.kind}]: ${JSON.stringify(result.error)}`);
      return 1;
    }
    const stats = result.data as AdviceStatsData;
    if (json) {
      printJson(result);
      return 0;
    }
    const window = sinceRaw === undefined ? '全部时间' : `since ${sinceRaw}`;
    console.log(`建议准确率统计（${window}，口径含已过期 advice）`);
    console.log(
      `总条数 ${stats.totalAdvices}  平均信心度 ${stats.avgConfidence}  ` +
        `命中率(高信心跟单盈利) ${fmtPercent(stats.hitRate)}`,
    );
    console.log(
      `outcome 比例: followed ${fmtPercent(stats.outcomeRate.followed)} / ` +
        `partially_followed ${fmtPercent(stats.outcomeRate.partiallyFollowed)} / ` +
        `ignored ${fmtPercent(stats.outcomeRate.ignored)}`,
    );
    console.log(
      `跟单 PnL ${fmtMoney(stats.pnlWhenFollowed)}  忽略 PnL ${fmtMoney(stats.pnlWhenIgnored)}`,
    );
    const decisionRows = Object.entries(stats.byDecision).map(([decision, s]) => [
      decision,
      String(s.totalAdvices),
      String(s.avgConfidence),
      fmtPercent(s.hitRate),
      fmtMoney(s.pnlWhenFollowed),
      fmtMoney(s.pnlWhenIgnored),
    ]);
    console.log('\n按决策分解:');
    console.log(
      renderTable(
        ['DECISION', 'COUNT', 'AVG_CONF', 'HIT_RATE', 'PNL_FOLLOWED', 'PNL_IGNORED'],
        decisionRows,
      ),
    );
    return 0;
  } finally {
    handle.close();
  }
};

const cmdAdviceOutcome = async (
  args: readonly string[],
  flags: ReadonlyMap<string, string | boolean>,
): Promise<number> => {
  const adviceId = args[0];
  if (adviceId === undefined || adviceId.length === 0) {
    throw new CliUsageError('advice outcome 需要 adviceId 作为位置参数');
  }
  const followedRaw = flagString(flags, 'followed') ?? 'true';
  const followed = followedRaw === 'true' || followedRaw === '1';
  const pnl = Number(flagString(flags, 'pnl') ?? '0');
  const holdingHoursStr = flagString(flags, 'holding-hours');
  const holdingHours = holdingHoursStr !== undefined ? Number(holdingHoursStr) : undefined;
  const notes = flagString(flags, 'notes');
  const handle = await createCliContext();
  try {
    const tool = toolRegistry.get('record_advice_outcome');
    if (tool === undefined) throw unknownToolError('record_advice_outcome');
    const res = await tool.execute(
      {
        adviceId,
        followed,
        pnl,
        ...(holdingHours !== undefined ? { holdingHours } : {}),
        ...(notes !== undefined ? { notes } : {}),
      },
      handle.ctx,
    );
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  } finally {
    handle.close();
  }
};

// ---------- 懒加载 surfaces（mcp / tui / web，由 W4a/W4c/W4d 并行实现） ----------

const LAZY_HINT = '该 surface 包由并行 agent 实现；若持续失败请检查其导出契约与实现状态';

/**
 * 动态 import 未就绪的兄弟包。specifier 故意用变量：
 * 1) tsc 不做静态模块解析（apps/web 的 src 可能尚不存在，静态 import 会 TS2307）；
 * 2) 运行时装载失败可转成友好错误，而非让 CLI 启动即崩。
 */
const runLazyEntry = async (
  specifier: string,
  exportName: string,
  args: readonly unknown[],
): Promise<number> => {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (error) {
    console.error(`error: 加载 ${specifier} 失败（${LAZY_HINT}）`);
    console.error(`cause: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const entry = mod[exportName];
  if (typeof entry !== 'function') {
    console.error(`error: ${specifier} 未导出 ${exportName}()（${LAZY_HINT}）`);
    return 1;
  }
  await (entry as (...fnArgs: unknown[]) => unknown)(...args);
  return 0;
};

/** mcp serve：契约 startMcpServer() 来自 docs/archive/plan.md（stdio，env 控制暴露面）。 */
const cmdWatch = async (
  _rest: readonly string[],
  flags: ReadonlyMap<string, string | boolean>,
  json: boolean,
): Promise<number> => {
  const intervalRaw = flagString(flags, 'interval') ?? '60';
  const intervalSec = parsePositiveInt(intervalRaw, 'interval');
  const intervalMs = intervalSec * 1000;
  // --pool 是旧 stock-pool 模型的残留 flag，已随 strategy-watchlist 迁移移除；
  // 不在 VALUE_FLAGS 会被静默吞掉，这里显式报错并指向替代 flag。
  if (flags.has('pool')) {
    throw new CliUsageError('--pool 已移除：盯盘对象改为 AlertPlan，请使用 --alert-plan <id>');
  }
  const alertPlanFlag = flagString(flags, 'alert-plan');
  const once = flags.has('once');
  const notify = !flags.has('no-notify');

  // 延迟 import：workflow 包包含 LLM / context 等较重依赖
  const { runIntradayWatchObserved } = await import('@luoome/workflows');
  const { clampInterval, formatTriggersForLog, isTradingHours, nextRunDelayMs } = await import(
    './watch.js'
  );
  const { createCliContext } = await import('./context.js');

  const handle = await createCliContext();
  const { ctx } = handle;

  const clampedMs = clampInterval(intervalMs);
  if (clampedMs !== intervalMs && !json) {
    console.warn(
      `interval=${intervalSec}s 被 clamp 到 ${clampedMs / 1000}s（quote 缓存 TTL 60s；< 60s 拿到的是缓存数据）`,
    );
  }

  const alertPlanIds =
    alertPlanFlag === undefined
      ? undefined
      : alertPlanFlag.split(',').filter((value) => value.length > 0);

  // 单轮：跑一次即退出
  if (once) {
    const r = await runIntradayWatchObserved(
      {
        ...(alertPlanIds !== undefined ? { alertPlanIds } : {}),
        notify,
      },
      ctx,
      'once',
    );
    if (!r.ok) {
      console.log(JSON.stringify(r, null, 2));
      handle.close();
      return 1;
    }
    if (json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      console.log(`盘中盯盘（单轮）评估完毕`);
      console.log(
        `  AlertPlan ${r.data.evaluatedPlans} / 股票 ${r.data.evaluatedStocks} / 触发 ${r.data.triggers.length}（通知 ${r.data.notified} / 冷却 ${r.data.suppressedByCooldown}）`,
      );
      if (r.data.triggers.length > 0) {
        console.log(formatTriggersForLog(r.data.triggers));
      }
    }
    handle.close();
    return 0;
  }

  // 长驻：循环
  let stopping = false;
  const handleSigint = (): void => {
    stopping = true;
    console.warn('\n收到 SIGINT，准备退出（在当前轮结束后）…');
  };
  process.on('SIGINT', handleSigint);

  let firstIteration = true;
  while (!stopping) {
    const now = new Date();
    if (!isTradingHours(now)) {
      if (firstIteration && !json) {
        console.warn(`当前北京时间非交易时段，跳过本轮（等 60s 重试）`);
        firstIteration = false;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, nextRunDelayMs(now, clampedMs)));
      continue;
    }
    firstIteration = false;
    if (!json) console.warn(`[${now.toISOString()}] 跑一轮…`);
    const r = await runIntradayWatchObserved(
      {
        ...(alertPlanIds !== undefined ? { alertPlanIds } : {}),
        notify,
      },
      ctx,
      'daemon',
    );
    if (!r.ok) {
      console.error(`本轮失败: ${JSON.stringify(r, null, 2)}`);
    } else if (!json) {
      console.log(formatTriggersForLog(r.data.triggers));
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, nextRunDelayMs(new Date(), clampedMs)),
    );
  }
  process.off('SIGINT', handleSigint);
  handle.close();
  return 0;
};

const cmdWorkflowRun = async (
  name: string,
  flags: ReadonlyMap<string, string | boolean>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _json: boolean,
): Promise<number> => {
  const inputRaw = flagString(flags, 'input') ?? '{}';
  let input: unknown;
  try {
    input = JSON.parse(inputRaw);
  } catch (error) {
    throw new CliUsageError(`--input 必须是合法 JSON: ${(error as Error).message}`);
  }
  const mode = flagString(flags, 'mode');
  if (mode !== undefined) {
    if (mode !== 'manual' && mode !== 'scheduled') {
      throw new CliUsageError('--mode 仅支持 manual / scheduled');
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new CliUsageError('使用 --mode 时，--input 必须是 JSON 对象');
    }
    input = { ...input, mode };
  }
  // workflow 注册表：v0.2 起 sync-quotes / daily-advice。
  const workflows = await import('@luoome/workflows');
  type Wf = {
    run: (
      input: unknown,
      ctx: unknown,
    ) => Promise<{ ok: boolean; data?: unknown; error?: unknown }>;
  };
  const reg = workflows as unknown as Record<string, Wf>;
  // hyphen-case → camelCase：sync-quotes → syncQuotes；lookup 时拼 Workflow 后缀
  const camel = name.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
  const wf: Wf | undefined = reg[`${camel}Workflow`];
  if (wf === undefined) {
    throw new CliUsageError(
      `未知 workflow: "${name}"（支持 sync-quotes / sync-stock-universe / post-market-data / daily-advice / run-strategies / sync-portfolio-watchlists / risk-report / daily-review / intraday-watch / sync-stock-events / evaluate-event-rules / opening-report / closing-report / weekly-report）`,
    );
  }
  const handle = await createCliContext();
  try {
    const res = await wf.run(input, handle.ctx);
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  } finally {
    handle.close();
  }
};

const cmdMcpServe = (): Promise<number> => runLazyEntry('@luoome/mcp', 'startMcpServer', []);

/**
 * tui：W4c 实际导出 startTuiApp()（opentui app，布局 docs/archive/MVP-TASK.md §2.7，见 packages/tui/src/index.ts）。
 * W5 联调已核对导出名一致。
 */
const cmdTui = (): Promise<number> => runLazyEntry('@luoome/tui', 'startTuiApp', []);

/**
 * web serve：W4d 实际导出 startWeb({ port })（Hono，默认 5173，见 apps/web/src/server.ts）。
 * W5 联调已对齐：docs/archive/plan.md 未写死导出名，此处以 web 包实现为准。
 * 默认后台运行（同 start），--foreground 保持前台。
 */
const cmdWebServe = (flags: ReadonlyMap<string, string | boolean>): Promise<number> => {
  const portRaw = flagString(flags, 'port') ?? '5173';
  const port = parsePositiveInt(portRaw, 'port');
  if (port > 65535) throw new CliUsageError(`flag --port 超出范围: ${port}`);
  const host = flagString(flags, 'host') ?? '127.0.0.1';
  const daemon = maybeDaemonize(flags, false);
  if (daemon !== null) return Promise.resolve(daemon);
  return runLazyEntry('@luoome/web', 'startWeb', [{ port, host }]);
};

/**
 * 一键 restart：按端口反查旧 PID 优雅停掉，再 start；省去「查 PID → kill → 启动」的组合命令。
 * 默认后台运行（见 maybeDaemonize），--foreground 保持前台阻塞。
 */
const cmdRestart = async (
  flags: ReadonlyMap<string, string | boolean>,
  json: boolean,
): Promise<number> => {
  const port = parsePositiveInt(flagString(flags, 'port') ?? '5173', 'port');
  if (port > 65535) throw new CliUsageError(`flag --port 超出范围: ${port}`);

  const oldPid = await findPidOnPort(port);
  if (oldPid !== null) {
    if (!json) console.log(`stopping pid=${oldPid} on port ${port}`);
    killPid(oldPid, 'SIGTERM');
    const exited = await waitForProcessExit(oldPid, 5000);
    if (!exited) {
      if (!json) console.log(`pid=${oldPid} 5s 未退，SIGKILL`);
      killPid(oldPid, 'SIGKILL');
      await waitForProcessExit(oldPid, 2000);
    }
  }

  // start 会复用 flags 里的 host/port；旧进程已让位，端口空闲。
  return cmdStart(flags, json);
};

/** 未显式 --foreground 时后台重开当前命令；返回退出码 0，或 null 表示继续前台跑。 */
const maybeDaemonize = (
  flags: ReadonlyMap<string, string | boolean>,
  json: boolean,
): number | null => {
  if (flags.has('foreground') || isDaemonized()) return null;
  const { pid, logPath } = respawnDetached();
  if (json) {
    console.log(JSON.stringify({ pid, logPath }));
  } else {
    console.log(`已在后台启动 pid=${pid}，日志：tail -f ${logPath}（前台运行加 --foreground）`);
  }
  return 0;
};

/** 一键 MVP：同一进程启动 Web，并在后台职责上进入 watch 长驻循环。 */
const cmdStart = async (
  flags: ReadonlyMap<string, string | boolean>,
  json: boolean,
): Promise<number> => {
  const port = parsePositiveInt(flagString(flags, 'port') ?? '5173', 'port');
  if (port > 65535) throw new CliUsageError(`flag --port 超出范围: ${port}`);
  const host = flagString(flags, 'host') ?? '127.0.0.1';
  const daemon = maybeDaemonize(flags, json);
  if (daemon !== null) return daemon;
  const mod = (await import('@luoome/web')) as {
    startWeb: (options: { port: number; host: string }) => Promise<Bun.Server<undefined>>;
  };
  const server = await mod.startWeb({ port, host });
  if (!json) console.log(`MVP 已就绪：http://${host}:${server.port}`);

  if (flags.has('no-watch')) {
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.off('SIGINT', stop);
        resolve();
      };
      process.on('SIGINT', stop);
    });
    server.stop(true);
    return 0;
  }

  try {
    return await cmdWatch([], flags, json);
  } finally {
    server.stop(true);
  }
};

// ---------- help / 分发 ----------

const printHelp = (): void => {
  console.log(`luoome ${VERSION} —— 本地优先的个人投资管理 advisor agent

用法: luoome <command> [options]

全局:
  --version                      输出版本号
  --help, -h                     输出本帮助
  --json                         以 JSON 输出（所有查询类子命令支持）

Tools:
  tools list                            列出全部 tool（name / sideEffect / description）
  tools inspect <name>                  输出 tool 的 input JSON Schema
  tools call <name> --input '<json>'    调用 tool，打印 data 或 error JSON

Strategy / Watchlist / Alert:
  strategy list|get|validate|run         查询、校验或运行 Strategy
  watchlist list|get|sync                查询 Watchlist 或同步持仓来源
  alert list                             查询 AlertPlan

Advice:
  advice list [--since 7d] [--include-expired] [--limit N]   查询历史建议
  advice stats [--since 30d]                                 建议准确率统计
  advice outcome <id> [--followed true|false] [--pnl N]        回填建议结果

Surfaces:
  mcp serve                    启动 MCP stdio server（env 控制暴露面）
  tui                          启动终端 TUI
  start [--port 5173] [--host 127.0.0.1] [--interval 60] [--no-watch] [--foreground]
                               一键启动完整 MVP（Web + 盘中盯盘）；默认后台运行，日志
                               追加到 $LUOOME_HOME/logs/luoome.log，--foreground 前台跑
  restart [--port 5173] [--host 127.0.0.1] [--interval 60] [--no-watch] [--foreground]
                               按端口反查旧进程 SIGTERM 后再 start，无需手动 kill
  web serve [--port 5173] [--host 127.0.0.1] [--foreground]
                               仅启动 Web 仪表盘；默认后台运行（同 start）
  workflow run <name>          跑内置 workflow（含 opening-report / closing-report / weekly-report）
  watch [--interval 60] [--alert-plan <id>] [--once] [--no-notify]
                                盘中长驻盯盘；Ctrl+C 优雅退出
                                仅扫描启用的 AlertPlan 与其 Watchlist 成员

环境变量:
  LUOOME_HOME   数据目录（默认 ~/.luoome）；SQLite 位于 $LUOOME_HOME/luoome.db

--since/--until 支持相对时长（30m / 24h / 7d / 4w）或 ISO 日期。`);
};

const run = async (argv: readonly string[]): Promise<number> => {
  const { positional, flags } = parseArgv(argv);
  const json = flags.has('json');

  if (flags.has('version')) {
    console.log(VERSION);
    return 0;
  }

  const [cmd, sub, ...rest] = positional;

  if (cmd === undefined || flags.has('help')) {
    printHelp();
    return 0;
  }

  if (cmd === 'tools') {
    if (sub === 'list') {
      cmdToolsList(json);
      return 0;
    }
    if (sub === 'inspect') {
      const name = rest[0];
      if (name === undefined) throw new CliUsageError('用法: luoome tools inspect <name>');
      cmdToolsInspect(name);
      return 0;
    }
    if (sub === 'call') {
      const name = rest[0];
      if (name === undefined) {
        throw new CliUsageError(`用法: luoome tools call <name> --input '<json>'`);
      }
      return cmdToolsCall(name, flags, json);
    }
    throw new CliUsageError(`未知 tools 子命令: "${sub ?? ''}"（支持 list / inspect / call）`);
  }

  if (cmd === 'strategy') return cmdStrategy(sub, rest, flags, json);
  if (cmd === 'watchlist') return cmdWatchlist(sub, rest, flags, json);
  if (cmd === 'alert') return cmdAlert(sub, flags, json);

  if (cmd === 'advice') {
    if (sub === 'list') return cmdAdviceList(flags, json);
    if (sub === 'stats') return cmdAdviceStats(flags, json);
    if (sub === 'outcome') return cmdAdviceOutcome(rest, flags);
    throw new CliUsageError(`未知 advice 子命令: "${sub ?? ''}"（支持 list / stats / outcome）`);
  }

  if (cmd === 'mcp') {
    if (sub === 'serve') return cmdMcpServe();
    throw new CliUsageError(`未知 mcp 子命令: "${sub ?? ''}"（支持 serve）`);
  }

  if (cmd === 'watch') {
    return cmdWatch(rest, flags, json);
  }

  if (cmd === 'start') return cmdStart(flags, json);
  if (cmd === 'restart') return cmdRestart(flags, json);

  if (cmd === 'workflow') {
    if (sub === 'run') {
      const name = rest[0];
      if (name === undefined) {
        throw new CliUsageError(
          `用法: luoome workflow run <name> [--input '<json>'] [--mode manual|scheduled]`,
        );
      }
      return cmdWorkflowRun(name, flags, json);
    }
    throw new CliUsageError(`未知 workflow 子命令: "${sub ?? ''}"（支持 run）`);
  }

  if (cmd === 'tui') return cmdTui();

  if (cmd === 'web') {
    if (sub === 'serve') return cmdWebServe(flags);
    throw new CliUsageError(`未知 web 子命令: "${sub ?? ''}"（支持 serve）`);
  }

  if (cmd === 'market') {
    if (sub === 'limit-up') {
      return cmdMarketLimitUp({ args: rest, flags, json });
    }
    throw new CliUsageError(`未知 market 子命令: "${sub ?? ''}"（支持 limit-up）`);
  }

  throw new CliUsageError(`未知命令: "${cmd}"（运行 luoome --help 查看用法）`);
};

const main = async (): Promise<void> => {
  try {
    loadProjectEnv();
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`error: ${error.message}`);
      console.error('运行 luoome --help 查看用法。');
      process.exitCode = 2;
    } else {
      console.error(
        `error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      process.exitCode = 1;
    }
  }
};

await main();
