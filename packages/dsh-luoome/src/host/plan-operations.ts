// 交易计划的精确 Operation policy（task-39 批次 A）。
//
// **这里只做「冻结与回执」，不发明领域约束。**
// 计划能否保存的判断全在 `save_trading_plan` 里（`trading-plan.ts:100-130`）：
// 账户事实摘要、active 时事实完整性、active 时约束校验。policy 不复述、也不加严。
//
// ## 已知缺口：没有乐观锁
//
// `SaveTradingPlanInput` 只有 `{ plan, limits }`，**没有 `expectedRevision` 之类的基线字段**，
// 所以这里**不冻结一个不存在的版本号**——冻结一个「调用方自报的 revision」等于让调用方自己
// 担保并发安全，比没有锁更危险（用户会以为有锁）。
//
// 实际保护只来自两处：
// 1. `plan.accountFactsDigest` —— 账户事实变了就拒（防「基于旧前提保存」）；
// 2. 版本链 `supersedesVersionId` —— 事后可发现「我编辑期间被插了一版」。
//
// **不覆盖「同一账户事实下、两个会话并发编辑同一份计划」**：两者都能通过 digest 校验，
// 后写的静默覆盖前写的。这是已知缺口（task-40 附近登记），不是疏忽。
import { type ToolContext, tradingPlanVersionId } from '@luoome/core';
import {
  type ConfirmablePluginTool,
  PluginOperationScopeError,
  type PluginPrincipal,
  SaveTradingPlanInput,
  saveTradingPlanTool,
} from '@luoome/tools';

export const saveTradingPlanOperation: ConfirmablePluginTool = {
  tool: saveTradingPlanTool,
  scheduled: false,
  // `accountId` 嵌在 `plan` 里，不在顶层 —— `hostBoundFields` 只表达顶层字段，
  // 所以这里只声明「不需要额外绑定」，账户核对在 `bind` 里做。
  hostBoundFields: [],
  bind(raw, principal: PluginPrincipal) {
    const input = SaveTradingPlanInput.parse(raw);
    if (input.plan.accountId !== principal.accountId)
      throw new PluginOperationScopeError('accountId');
    // **原样冻结整个 plan 与 limits**：prepare 与 execute 之间若账本变化，
    // `accountFactsDigest` 校验会在 execute 阶段拒绝——这就是冻结输入的实质意义。
    return input;
  },
  async receipt(raw, ctx: ToolContext) {
    const input = SaveTradingPlanInput.parse(raw);
    // 版本身份的唯一实现是 core 的 `tradingPlanVersionId`（`<id>:v<version>`），
    // 这里复用它，不自己拼字符串（拼错会让回执永远找不到计划）。
    const versionId = tradingPlanVersionId(input.plan);
    const plan = await ctx.repos.tradingPlan.findByVersionId(versionId);
    if (plan === null) return null;
    // 回执里带**保存后的 versionId**：UI 据此发现「编辑期间被替换」（见 plans.js）。
    return {
      ok: true,
      data: {
        versionId,
        planId: plan.id,
        version: plan.version,
        supersedesVersionId: plan.supersedesVersionId,
        status: plan.status,
      },
    };
  },
};
