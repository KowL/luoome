import type { ToolContext } from '@luoome/core';

/**
 * 长期无数据成员的观察窗口（自然日）。
 *
 * 退市代码（`000003.SZ` / `000013.SZ` / `000024.SZ` 这类）仍会留在行情目录里，但任何源都拿不到
 * 它们的日线：实测 eastmoney `rc=102`、tencent 501、sina `no_data`、fuyao `Unknown thscode`。
 * 让它们进策略请求集，每轮都要为每只白拉 2–3 个源，并把 checkpoint 覆盖率按下去。
 *
 * 唯一可靠的判据是「库里从来没有过任何一根日线」。但这条判据同样命中**当天刚上市**的股票，
 * 而一旦被剔除就再也不会被请求，它永远拿不到第一根 bar——所以按「首次进入目录的时间」留窗口：
 * 窗口内照常请求，窗口外仍无数据才判定不可交易。
 */
export const UNTRADEABLE_GRACE_DAYS = 30;

const DAY_MS = 86_400_000;

export interface OperationalUniverse {
  readonly kept: readonly string[];
  /** 判定为不可交易（长期无任何日线）而剔除的成员。 */
  readonly untradeable: readonly string[];
}

/**
 * 从「当前目录成员」里剔掉长期无数据的代码。
 *
 * 调用点必须成对：`prepare_strategy_data` 与 `run_strategy` 都用它算成员集合，
 * 否则两边的 `memberChecksum` 对不上，scheduled 运行会直接报「成员集合不匹配」。
 * `replay` / 显式 `stockIds` 不经过这里——历史回放要保留当时的全量成员，显式请求要照办。
 */
export const excludeUntradeableStockIds = async (
  ctx: ToolContext,
  stockIds: readonly string[],
  now: Date,
): Promise<OperationalUniverse> => {
  if (stockIds.length === 0) return { kept: [], untradeable: [] };
  const [withBars, firstSeenAt] = await Promise.all([
    ctx.repos.dailyBar.listStockIdsWithBars(),
    ctx.repos.stockUniverse.listFirstSeenAt({ coverage: 'CN_A_SHARES_SH_SZ' }),
  ]);
  const cutoff = now.getTime() - UNTRADEABLE_GRACE_DAYS * DAY_MS;
  const kept: string[] = [];
  const untradeable: string[] = [];
  for (const stockId of stockIds) {
    if (withBars.has(stockId)) {
      kept.push(stockId);
      continue;
    }
    const seenAt = firstSeenAt.get(stockId);
    // 没有目录观察记录 = 刚出现的成员，给窗口；窗口内同样保留。
    if (seenAt === undefined || seenAt.getTime() > cutoff) {
      kept.push(stockId);
      continue;
    }
    untradeable.push(stockId);
  }
  return { kept, untradeable };
};
