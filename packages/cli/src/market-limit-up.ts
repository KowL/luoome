import {
  type LimitUpLadder,
  LimitUpLadderQuerySchema,
  type LimitUpLadderSource,
} from '@luoome/core';

import { createCliContext } from './context.js';
import { dateInShanghai } from './holidays.js';
import { flagString, padDisplay, renderTable } from './output.js';

export const todayInShanghai = (): string => dateInShanghai(new Date());

/**
 * luoome market limit-up 子命令（Phase 1，docs/ddd/limit-up-ladder-detailed-design.md §7.3）。
 *
 * 入参：
 *   --date YYYY-MM-DD     基准日；缺省 = Asia/Shanghai 今天
 *   --source eastmoney    缺省 eastmoney（当前唯一数据源）
 *   --days N              样本窗口（默认 15）
 *   --include-star        允许科创板（默认排除）
 *   --include-bse         允许北交所（默认排除）
 *   --include-st          允许 ST（默认排除）
 *   --include-uncategorized  显示 level 缺失条目
 *   --json                输出与 tool schema 一致的 JSON
 */

const VALID_SOURCES: ReadonlySet<string> = new Set(['eastmoney']);

export interface CmdMarketLimitUpOptions {
  readonly args: readonly string[];
  readonly flags: ReadonlyMap<string, string | boolean>;
  readonly json: boolean;
}

export const cmdMarketLimitUp = async (opts: CmdMarketLimitUpOptions): Promise<number> => {
  const dateRaw = flagString(opts.flags, 'date') ?? todayInShanghai();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
    throw new Error(`--date 必须是 YYYY-MM-DD 格式，实际 "${dateRaw}"`);
  }

  const sourceRaw = flagString(opts.flags, 'source');
  let source: LimitUpLadderSource | undefined;
  if (sourceRaw !== undefined) {
    if (!VALID_SOURCES.has(sourceRaw)) {
      throw new Error(`--source 必须是 eastmoney，实际 "${sourceRaw}"`);
    }
    source = sourceRaw as LimitUpLadderSource;
  }

  const daysRaw = flagString(opts.flags, 'days');
  let days: number | undefined;
  if (daysRaw !== undefined) {
    const n = Number(daysRaw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--days 必须是正整数，实际 "${daysRaw}"`);
    }
    days = n;
  }

  const query = LimitUpLadderQuerySchema.parse({
    date: dateRaw,
    ...(source !== undefined ? { source } : {}),
    ...(days !== undefined ? { days } : {}),
    includeStar: opts.flags.has('include-star'),
    includeBse: opts.flags.has('include-bse'),
    includeST: opts.flags.has('include-st'),
    includeUncategorized: opts.flags.has('include-uncategorized'),
  });

  const handle = await createCliContext();
  try {
    if (handle.ctx.limitUpLadder === undefined) {
      throw new Error('limit-up-ladder manager 未注入');
    }
    const r = await handle.ctx.limitUpLadder.fetchLadder(query);
    if (!r.ok || r.data === undefined) {
      throw new Error(`limit-up-ladder failed: ${r.error?.message ?? 'unknown error'}`);
    }
    if (opts.json) {
      console.log(JSON.stringify(r.data, null, 2));
      return 0;
    }
    renderHuman(r.data);
    return 0;
  } finally {
    handle.close();
  }
};

const renderHuman = (ladder: LimitUpLadder): void => {
  const header = [
    `📈 连板天梯  ${ladder.date}  来源 ${ladder.source}  asOf ${ladder.asOf.toISOString()}`,
    `总计 ${ladder.total} 只   最高 ${ladder.maxLevel} 连板   warnings: ${
      ladder.warnings.length > 0 ? ladder.warnings.join(' / ') : '无'
    }`,
  ];
  console.log(header.join('\n'));

  if (ladder.levels.length === 0) {
    if (ladder.warnings.includes('non-trading-day')) {
      console.log('该日为非 A 股交易日');
    } else if (ladder.warnings.includes('empty-ladder')) {
      console.log('今日数据暂未更新（盘前 / 数据延迟）');
    } else {
      console.log('（无可展示 entries）');
    }
    return;
  }

  for (const lv of ladder.levels) {
    console.log('');
    console.log(`${lv.name} (${lv.count} 只)`);
    const rows = lv.stocks.map((s) => {
      const price = s.corrected ? `${s.price.toFixed(2)}*` : s.price.toFixed(2);
      const pct = `${(s.changePct * 100).toFixed(2)}%`;
      return [
        padDisplay(s.code, 8),
        padDisplay(s.name, 12),
        padDisplay(price, 10),
        padDisplay(pct, 8),
        `first ${s.firstTime ?? '--'}`,
        `final ${s.finalTime ?? '--'}`,
        `行业 ${s.industry}`,
        s.reason !== '--' ? `原因 ${s.reason}` : '',
      ].filter((x) => x.length > 0);
    });
    if (rows.length === 0) {
      console.log('  （无个股）');
      continue;
    }
    console.log(
      renderTable(['CODE', 'NAME', 'PRICE', 'PCT', 'FIRST', 'FINAL', 'INDUSTRY', 'REASON'], rows),
    );
  }
};
