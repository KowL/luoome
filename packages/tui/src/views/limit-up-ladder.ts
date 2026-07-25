import type { LimitUpLadder, LimitUpLadderEntry } from '@luoome/core';

/**
 * 连板天梯 TUI 渲染（Phase 1，docs/ddd/limit-up-ladder-detailed-design.md §7.2）。
 *
 * 布局与 Web 同构（每层展示前 3 只，超出提示 `<N> 只未显示，Enter 展开`）
 * 输出为多行字符串，TUI 在弹层（overlay）中按行展示。
 *
 * 设计约束：
 * - 不臆造字段：缺数据显示 `--`
 * - corrected=true 时现价加 `*` 角标，便于复盘识别 §6.4 修正条目
 * - 同 level 内只取前 3 只（DCS 设计 —— 终端窄）
 */

const TIM_MISSING = '--';
const DISPLAY_LIMIT_PER_LEVEL = 3;

const fmtPct = (n: number): string => `${(n * 100).toFixed(2)}%`;

const displayWidthOf = (s: string): number => {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xa3ff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd);
    w += wide ? 2 : 1;
  }
  return w;
};

const padRight = (s: string, width: number): string => {
  const pad = width - displayWidthOf(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
};

const formatEntry = (e: LimitUpLadderEntry): string => {
  const price = e.corrected ? `${e.price.toFixed(2)}*` : e.price.toFixed(2);
  return [
    '  ',
    padRight(e.code, 8),
    padRight(e.name, 12),
    padRight(price, 10),
    padRight(fmtPct(e.changePct), 8),
    padRight(`first ${e.firstTime ?? TIM_MISSING}`, 16),
    padRight(`final ${e.finalTime ?? TIM_MISSING}`, 16),
    `行业 ${e.industry}`,
    e.reason !== TIM_MISSING ? `原因 ${e.reason}` : '',
  ]
    .filter((x) => x.length > 0)
    .join(' ');
};

export const formatLimitUpLadderLines = (ladder: LimitUpLadder): string[] => {
  const lines: string[] = [];
  lines.push(`📈 连板天梯  ${ladder.date}  来源 ${ladder.source}`);
  lines.push(
    `总计 ${ladder.total} 只  最高 ${ladder.maxLevel} 连板  warnings: ${
      ladder.warnings.length > 0 ? ladder.warnings.join(' / ') : '无'
    }`,
  );

  if (ladder.levels.length === 0) {
    if (ladder.warnings.includes('non-trading-day')) {
      lines.push('该日为非 A 股交易日');
    } else if (ladder.warnings.includes('empty-ladder')) {
      lines.push('今日数据暂未更新（盘前 / 数据延迟）');
    } else {
      lines.push('（无可展示 entries）');
    }
    return lines;
  }

  for (const lv of ladder.levels) {
    lines.push('');
    lines.push(`${lv.name} (${lv.count} 只)`);
    const top = lv.stocks.slice(0, DISPLAY_LIMIT_PER_LEVEL);
    for (const s of top) lines.push(formatEntry(s));
    if (lv.stocks.length > DISPLAY_LIMIT_PER_LEVEL) {
      const hidden = lv.stocks.length - DISPLAY_LIMIT_PER_LEVEL;
      lines.push(`  … <${hidden} 只未显示，Enter 展开>`);
    }
  }

  return lines;
};
