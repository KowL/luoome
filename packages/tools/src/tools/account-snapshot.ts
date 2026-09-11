import {
  type AccountSnapshot,
  AccountSnapshotSchema,
  AccountSnapshotSourceSchema,
  type AccountSnapshotStatus,
  AccountSnapshotStatusSchema,
  money,
  type ToolContext,
} from '@luoome/core';
import { z } from 'zod';

import { defineTool, errInvalidInput, errNotFound } from '../define-tool.js';

const SnapshotPositionInput = z.object({
  stockId: z.string().min(1),
  quantity: z.number().int().nonnegative(),
  availableQuantity: z.number().int().nonnegative().optional(),
  marketValue: z.number().finite().nonnegative(),
  industry: z.string().trim().min(1).optional(),
  price: z.number().positive().optional(),
  observedAt: z.coerce.date().optional(),
});

export const SaveAccountSnapshotInput = z.object({
  accountId: z.string().min(1).optional(),
  asOf: z.coerce.date().optional(),
  status: AccountSnapshotStatusSchema.default('complete'),
  cashBalance: z.number().finite().nonnegative().optional(),
  positions: z.array(SnapshotPositionInput).default([]),
  note: z.string().max(500).optional(),
  source: AccountSnapshotSourceSchema.default('manual'),
});

export const SaveAccountSnapshotOutput = z.object({
  snapshot: AccountSnapshotSchema,
  accountVersion: z.number().int().positive(),
});

const snapshotLocks = new Map<string, Promise<void>>();

const withSnapshotLock = async <T>(accountId: string, task: () => Promise<T>): Promise<T> => {
  const previous = snapshotLocks.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  snapshotLocks.set(accountId, current);
  await previous;
  try {
    return await task();
  } finally {
    if (snapshotLocks.get(accountId) === current) snapshotLocks.delete(accountId);
    release();
  }
};

const nextSnapshotVersion = async (accountId: string, ctx: ToolContext): Promise<number> => {
  const latest = await ctx.repos.accountSnapshot.latestByAccount(accountId);
  return (latest?.version ?? 0) + 1;
};

export const saveAccountSnapshotTool = defineTool({
  name: 'save_account_snapshot',
  description: '手动保存账户资金与持仓估值版本；未能同时核对时保留待核对状态',
  sideEffect: 'write',
  input: SaveAccountSnapshotInput,
  output: SaveAccountSnapshotOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    return withSnapshotLock(accountId, async () => {
      const account = await ctx.repos.account.findById(accountId);
      if (account === null) return errNotFound('Account', accountId);
      for (const position of input.positions) {
        if ((position.availableQuantity ?? position.quantity) > position.quantity) {
          return errInvalidInput(`持仓 ${position.stockId} 的 availableQuantity 不能大于 quantity`);
        }
        const stock = await ctx.repos.stock.findById(position.stockId);
        if (stock === null) return errNotFound('Stock', position.stockId);
      }
      const now = ctx.clock();
      const positions = input.positions.map((position) => ({
        stockId: position.stockId,
        quantity: position.quantity,
        availableQuantity: position.availableQuantity ?? position.quantity,
        marketValue: money(position.marketValue),
        ...(position.industry === undefined ? {} : { industry: position.industry }),
        ...(position.price === undefined ? {} : { price: money(position.price) }),
        ...(position.observedAt === undefined ? {} : { observedAt: position.observedAt }),
      }));
      const version = await nextSnapshotVersion(accountId, ctx);
      let snapshot: AccountSnapshot;
      if (input.status === 'complete') {
        if (input.cashBalance === undefined)
          return errInvalidInput('complete 快照必须提供 cashBalance');
        const stockMarketValue = money(
          positions.reduce((sum, position) => sum + position.marketValue, 0),
        );
        snapshot = {
          id: `account-snapshot-${globalThis.crypto.randomUUID()}`,
          accountId,
          version,
          asOf: input.asOf ?? now,
          cashBalance: money(input.cashBalance),
          stockMarketValue,
          totalAssets: money(input.cashBalance + stockMarketValue),
          status: 'complete',
          positions,
          source: input.source,
          ...(input.note === undefined ? {} : { note: input.note }),
          createdAt: now,
        };
      } else {
        snapshot = {
          id: `account-snapshot-${globalThis.crypto.randomUUID()}`,
          accountId,
          version,
          asOf: input.asOf ?? now,
          cashBalance:
            input.status === 'needs-reconciliation' && input.cashBalance !== undefined
              ? money(input.cashBalance)
              : null,
          stockMarketValue: null,
          totalAssets: null,
          status: input.status,
          positions,
          source: input.source,
          ...(input.note === undefined ? {} : { note: input.note }),
          createdAt: now,
        };
      }
      await ctx.repos.accountSnapshot.save(snapshot);
      return { snapshot, accountVersion: version };
    });
  },
});

export const GetAccountSnapshotInput = z.object({
  accountId: z.string().min(1).optional(),
});
export const GetAccountSnapshotOutput = z.object({ snapshot: AccountSnapshotSchema });

export const getAccountSnapshotTool = defineTool({
  name: 'get_account_snapshot',
  description: '读取账户当前手动维护的估值与持仓版本',
  sideEffect: 'read',
  input: GetAccountSnapshotInput,
  output: GetAccountSnapshotOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const snapshot = await ctx.repos.accountSnapshot.latestByAccount(accountId);
    return snapshot === null ? errNotFound('AccountSnapshot', accountId) : { snapshot };
  },
});

export const ListAccountSnapshotsInput = z.object({
  accountId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).default(30),
});
export const ListAccountSnapshotsOutput = z.object({
  snapshots: z.array(AccountSnapshotSchema),
});

export const listAccountSnapshotsTool = defineTool({
  name: 'list_account_snapshots',
  description: '查询账户估值版本历史',
  sideEffect: 'read',
  input: ListAccountSnapshotsInput,
  output: ListAccountSnapshotsOutput,
  handler: async (input, ctx) => ({
    snapshots: [
      ...(await ctx.repos.accountSnapshot.listByAccount(
        input.accountId ?? ctx.user.defaultAccountId,
        input.limit,
      )),
    ],
  }),
});

export type SaveAccountSnapshotStatus = AccountSnapshotStatus;
