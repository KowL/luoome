// 账户维护的人工记账写策略（REQ-M2-08 / T47）：账户改名 + 登记成交 + 平仓 + 现金流水。
//
// 这些写工具不注册成 agent 工具，只作为 `luoome_confirmed_operation` 的 policy 执行：
// prepare 冻结输入（账户由 host 绑定、缺省时间在 prepare 时定死），个人版随后直接 confirm，
// 同一个 operationId 重复提交只会读回同一份回执，不会重复写库。
//
// `add_trade` 是人工记账，不是交易能力：它的 sideEffect 必须保持 `write`
// （AGENTS.md 硬约束 + ddd §1），本文件不得为它声明 `trade` capability。
import type { ToolContext } from '@luoome/core';
import {
  AddTradeInput,
  addTradeTool,
  CloseHoldingInput,
  type ConfirmablePluginTool,
  CreatePortfolioCashFlowInput,
  closeHoldingTool,
  createPortfolioCashFlowTool,
  PluginOperationScopeError,
  type PluginPrincipal,
  UpdateAccountInput,
  updateAccountTool,
} from '@luoome/tools';
import { z } from 'zod';

export const updateAccountOperation: ConfirmablePluginTool = {
  tool: updateAccountTool,
  scheduled: false,
  hostBoundFields: ['accountId'],
  bind(raw, principal) {
    const input = UpdateAccountInput.parse(raw);
    if (input.accountId !== undefined && input.accountId !== principal.accountId)
      throw new Error('Operation scope mismatch');
    return { ...input, accountId: principal.accountId };
  },
  async receipt(raw, ctx) {
    const input = UpdateAccountInput.parse(raw);
    if (input.accountId === undefined) return null;
    const account = await ctx.repos.account.findById(input.accountId);
    return account?.name === input.name ? { ok: true, data: { account } } : null;
  },
};

/**
 * 账户写操作只对当前 owner 生效：principal 必须就是上下文里的本地用户，账户一律由 host 绑定，
 * 客户端自报的别的 accountId 直接拒绝（与 `research-operations.ts` 的 bindScope 同一口径）。
 */
const boundOwnerInput = (
  raw: unknown,
  principal: PluginPrincipal,
  ctx: ToolContext,
): Record<string, unknown> => {
  const input = z.record(z.string(), z.unknown()).parse(raw);
  if (principal.userId !== ctx.user.id || principal.accountId !== ctx.user.defaultAccountId)
    throw new PluginOperationScopeError('accountId');
  if (input.accountId !== undefined && input.accountId !== principal.accountId)
    throw new PluginOperationScopeError('accountId');
  return input;
};

const sameInstant = (left: Date, right: Date): boolean => left.getTime() === right.getTime();

/**
 * 登记成交（人工记账，write）。
 *
 * `executedAt` 缺省「现在」，但「现在」在 prepare 时由 host 决定并冻结：否则重复提交或
 * 崩溃后 reconcile 会落到另一个时刻，既核不准回执，也会让同一笔成交看起来像两笔。
 */
const addTradeOperation: ConfirmablePluginTool = {
  tool: addTradeTool,
  scheduled: false,
  hostBoundFields: ['accountId'],
  bind(raw, principal, _operationId, ctx) {
    const input = AddTradeInput.parse({
      ...boundOwnerInput(raw, principal, ctx),
      accountId: principal.accountId,
    });
    return { ...input, executedAt: input.executedAt ?? ctx.clock() };
  },
  async receipt(raw, ctx) {
    const input = AddTradeInput.parse(raw);
    const { accountId, executedAt } = input;
    if (accountId === undefined || executedAt === undefined) return null;
    // 只按本账户 + 同一标的 + 同一执行时刻回读；字段级全等才认作本次写入，避免把旧成交当回执。
    const candidates = await ctx.repos.trade.listByAccount(accountId, {
      stockId: input.stockId,
      executedAtFrom: executedAt,
    });
    const trade = candidates.find(
      (row) =>
        row.source === 'manual' &&
        row.side === input.side &&
        row.quantity === input.quantity &&
        row.price === input.price &&
        row.fee === input.fee &&
        sameInstant(row.executedAt, executedAt) &&
        row.adviceId === input.adviceId &&
        row.researchHypothesisVersionId === input.researchHypothesisVersionId &&
        row.strategyVersionId === input.strategyVersionId,
    );
    if (trade === undefined) return null;
    const holding = await ctx.repos.holding.findByAccountAndStock(accountId, input.stockId);
    return {
      ok: true,
      data: holding === null ? { trade, replayed: true } : { trade, holding, replayed: true },
    };
  },
};

/**
 * 平仓（软关闭，write）。
 *
 * bind 先核对持仓归属与「尚未平仓」：范围不符或已平仓的请求在 prepare 阶段就拒绝，
 * 不会留下一个必然失败的 pending 操作。
 */
const closeHoldingOperation: ConfirmablePluginTool = {
  tool: closeHoldingTool,
  scheduled: false,
  async bind(raw, principal, _operationId, ctx) {
    const input = CloseHoldingInput.parse(boundOwnerInput(raw, principal, ctx));
    const holding = await ctx.repos.holding.findById(input.holdingId);
    if (holding === null) throw new Error('目标持仓不存在');
    if (holding.accountId !== principal.accountId) throw new PluginOperationScopeError('accountId');
    if (holding.closedAt !== null) throw new Error('该持仓已平仓，无需重复操作');
    return input;
  },
  async receipt(raw, ctx) {
    const input = CloseHoldingInput.parse(raw);
    const holding = await ctx.repos.holding.findById(input.holdingId);
    // 平仓没有业务幂等键：closedAt 非空是唯一的可回读事实。prepare 已拒绝已平仓的持仓，
    // 所以这里命中即代表本次写入已提交。
    return holding !== null && holding.closedAt !== null
      ? { ok: true, data: { holding, replayed: true } }
      : null;
  },
};

/**
 * 现金流水（入金 / 出金 / 分红 / 费用，write）。
 *
 * 领域层只有 `create_portfolio_cash_flow` 这一个现金写工具，它自带 id（handler 内生成 uuid），
 * 因此回执按冻结输入逐字段匹配：同一账户、同一发生时刻、同一类型与金额。同一分钟里
 * 两笔完全相同的流水无法与本次写入区分——重复提交必须复用同一个 operationId，
 * 让内核的幂等去挡，而不是靠回执去猜。
 */
const createPortfolioCashFlowOperation: ConfirmablePluginTool = {
  tool: createPortfolioCashFlowTool,
  scheduled: false,
  hostBoundFields: ['accountId'],
  bind(raw, principal, _operationId, ctx) {
    return CreatePortfolioCashFlowInput.parse({
      ...boundOwnerInput(raw, principal, ctx),
      accountId: principal.accountId,
    });
  },
  async receipt(raw, ctx) {
    const input = CreatePortfolioCashFlowInput.parse(raw);
    const flows = await ctx.repos.portfolioCashFlow.listByAccount(input.accountId);
    const flow = flows.find(
      (row) =>
        sameInstant(row.occurredAt, input.occurredAt) &&
        row.kind === input.kind &&
        row.amount === input.amount &&
        row.currency === input.currency &&
        row.stockId === input.stockId &&
        row.source === input.source &&
        row.note === input.note,
    );
    return flow === undefined ? null : { ok: true, data: { flow, replayed: true } };
  },
};

/** 账户维护的全部写策略：改名、登记成交、平仓、现金流水。 */
export const createAccountOperationPolicies = (): readonly ConfirmablePluginTool[] => [
  updateAccountOperation,
  addTradeOperation,
  closeHoldingOperation,
  createPortfolioCashFlowOperation,
];
