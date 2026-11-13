import {
  type AdjustmentFactor,
  type AdjustmentFactorRepository,
  AdjustmentFactorSchema,
} from '@luoome/core';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { adjustmentFactors, type Schema } from '../../schema/index.js';

type FactorRow = typeof adjustmentFactors.$inferSelect;

const toFactor = (row: FactorRow): AdjustmentFactor => ({
  stockId: row.stockId,
  exDate: row.exDate,
  factor: row.factor,
  dividendPerShare: row.dividendPerShare,
  perShareBonus: row.perShareBonus,
  allotmentRatio: row.allotmentRatio,
  allotmentPrice: row.allotmentPrice,
  source: row.source,
});

/** 除权除息因子；(stockId, exDate) 唯一，重复导入覆盖同一事件。 */
export class DrizzleAdjustmentFactorRepository implements AdjustmentFactorRepository {
  constructor(private readonly db: BunSQLiteDatabase<Schema>) {}

  async saveMany(factors: readonly AdjustmentFactor[]): Promise<void> {
    if (factors.length === 0) return;
    const rows = factors.map((input) => {
      const parsed = AdjustmentFactorSchema.parse(input);
      return {
        stockId: parsed.stockId,
        exDate: parsed.exDate,
        factor: parsed.factor,
        dividendPerShare: parsed.dividendPerShare,
        perShareBonus: parsed.perShareBonus,
        allotmentRatio: parsed.allotmentRatio,
        allotmentPrice: parsed.allotmentPrice,
        source: parsed.source,
      };
    });
    // 全量因子一次可达 3.5 万行；按 500 行分块，避免超过 SQLite 绑定参数上限。
    // 单事务提交：部分导入会让 qfq 缓存误判「因子已完整」，进而二次复权。
    this.db.transaction((tx) => {
      for (let index = 0; index < rows.length; index += 500) {
        tx.insert(adjustmentFactors)
          .values(rows.slice(index, index + 500))
          .onConflictDoUpdate({
            target: [adjustmentFactors.stockId, adjustmentFactors.exDate],
            set: {
              factor: sql`excluded."factor"`,
              dividendPerShare: sql`excluded."dividend_per_share"`,
              perShareBonus: sql`excluded."per_share_bonus"`,
              allotmentRatio: sql`excluded."allotment_ratio"`,
              allotmentPrice: sql`excluded."allotment_price"`,
              source: sql`excluded."source"`,
            },
          })
          .run();
      }
    });
  }

  async listAfter(stockId: string, since: Date): Promise<readonly AdjustmentFactor[]> {
    return this.db
      .select()
      .from(adjustmentFactors)
      .where(and(eq(adjustmentFactors.stockId, stockId), gt(adjustmentFactors.exDate, since)))
      .orderBy(asc(adjustmentFactors.exDate))
      .all()
      .map(toFactor);
  }

  async listAfterForStocks(
    stockIds: readonly string[],
    since: Date,
  ): Promise<ReadonlyMap<string, readonly AdjustmentFactor[]>> {
    const unique = [...new Set(stockIds)].sort();
    const result = new Map<string, AdjustmentFactor[]>();
    for (let index = 0; index < unique.length; index += 400) {
      const chunk = unique.slice(index, index + 400);
      for (const row of this.db
        .select()
        .from(adjustmentFactors)
        .where(and(inArray(adjustmentFactors.stockId, chunk), gt(adjustmentFactors.exDate, since)))
        .orderBy(asc(adjustmentFactors.stockId), asc(adjustmentFactors.exDate))
        .all()) {
        const existing = result.get(row.stockId);
        if (existing === undefined) result.set(row.stockId, [toFactor(row)]);
        else existing.push(toFactor(row));
      }
    }
    return result;
  }

  async removeByStock(stockId: string): Promise<number> {
    const removed = this.db
      .delete(adjustmentFactors)
      .where(eq(adjustmentFactors.stockId, stockId))
      .returning({ stockId: adjustmentFactors.stockId })
      .all();
    return removed.length;
  }
}
