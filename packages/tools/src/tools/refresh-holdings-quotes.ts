import { z } from 'zod';

import { defineTool, errNotFound } from '../define-tool.js';
import { resolveQuotes } from '../internal/resolve-quotes.js';

/**
 * 显式刷新持仓行情（task-14 拆分）。
 *
 * **为什么要从 `list_holdings` 拆出来**：`list_holdings` 曾声明 `sideEffect: 'read'`，
 * 却经 `resolveQuotes` **访问外部行情源并 `quote.save` 写库**。`sideEffect` 是给模型看的契约——
 * 模型据此判断「调用它安全」。名实不符等于给模型一个**错误的安全担保**，不是代码风格问题。
 *
 * 拆分后的分工：
 * - `list_holdings`（read）：只读已落库报价，缺的如实标 `priceStatus: 'unpriced'`
 * - 本工具（external）：唯一回源并写库的入口，由**明确意图**触发
 *
 * **本工具只如实报「刷新成功/失败」，不替调用方做取舍**：能不能「用旧价继续」是调用方的上下文
 * 决定的（报告 vs 面板 vs 盯盘），工具不猜。
 */

export const RefreshHoldingsQuotesInput = z
  .object({
    /** 账户 id；缺省为当前用户默认账户。 */
    accountId: z.string().min(1).optional(),
    /** 只刷这些标的；缺省 = 该账户全部未平仓持仓的标的。 */
    stockIds: z.array(z.string().min(1)).max(500).optional(),
  })
  .strict();

export const RefreshHoldingsQuotesOutput = z
  .object({
    accountId: z.string().min(1),
    /** 本次实际尝试刷新的标的数（去重后）。 */
    requested: z.number().int().nonnegative(),
    /** 拿到实时报价并已落库的标的数。 */
    refreshed: z.number().int().nonnegative(),
    /** 刷新失败的标的（逐条点名 + 原因），**不静默降级**。 */
    failed: z.array(z.object({ stockId: z.string().min(1), reason: z.string().min(1) }).strict()),
    /**
     * 刷新是否**全部**成功。
     *
     * 刻意用布尔而不是「失败数组是否为空」的隐含约定：调用方要能一眼判断「要不要走缺价分支」，
     * 不该自己解释数组语义。
     */
    allRefreshed: z.boolean(),
    /** = 本次刷新里最新的 observedAt；一个都没成功时缺席（不编一个时间）。 */
    dataAsOf: z.coerce.date().optional(),
  })
  .strict();

export const refreshHoldingsQuotesTool = defineTool({
  name: 'refresh_holdings_quotes',
  description:
    '为账户持仓显式回源刷新行情并落库（访问外部行情源 + 写 price_snapshots）。' +
    '逐股报告成功与失败原因；失败不静默降级、不返回伪成功。读取持仓与估值请用只读的 list_holdings',
  sideEffect: 'external',
  input: RefreshHoldingsQuotesInput,
  output: RefreshHoldingsQuotesOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const account = await ctx.repos.account.findById(accountId);
    if (account === null) return errNotFound('Account', accountId);

    const stockIds =
      input.stockIds === undefined
        ? [
            ...new Set(
              (await ctx.repos.holding.listByAccount(accountId))
                .filter((holding) => holding.closedAt === null && holding.quantity > 0)
                .map((holding) => holding.stockId),
            ),
          ]
        : [...new Set(input.stockIds)];

    if (stockIds.length === 0)
      return {
        accountId,
        requested: 0,
        refreshed: 0,
        failed: [],
        allRefreshed: true,
      };

    const resolved = await resolveQuotes(ctx, stockIds, { context: 'display' });
    const failed: { stockId: string; reason: string }[] = [];
    const refreshedAt: Date[] = [];
    for (const item of resolved) {
      if (item.status === 'ok') {
        refreshedAt.push(item.quote.observedAt);
        continue;
      }
      failed.push({
        stockId: item.stockId,
        reason: item.status === 'unresolved' ? `无法解析标的：${item.reason}` : item.reason,
      });
    }
    // `resolveQuotes` 对整批失败是「回落本地快照」而不是抛错——所以这里必须靠
    // `status !== 'ok'` 判失败，不能靠异常。
    return {
      accountId,
      requested: stockIds.length,
      refreshed: resolved.length - failed.length,
      failed,
      allRefreshed: failed.length === 0,
      ...(refreshedAt.length === 0
        ? {}
        : { dataAsOf: new Date(Math.max(...refreshedAt.map((item) => item.getTime()))) }),
    };
  },
});
