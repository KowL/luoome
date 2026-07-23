import { z } from 'zod';

import { InvariantError } from '../error/index.js';

export const WatchRunModeSchema = z.enum(['once', 'daemon']);
export const WatchRunStatusSchema = z.enum(['running', 'succeeded', 'failed']);

export const WatchRunSchema = z.object({
  id: z.string().min(1),
  mode: WatchRunModeSchema,
  status: WatchRunStatusSchema,
  startedAt: z.coerce.date(),
  finishedAt: z.coerce.date().nullable(),
  evaluatedPools: z.number().int().nonnegative(),
  evaluatedStocks: z.number().int().nonnegative(),
  triggered: z.number().int().nonnegative(),
  notified: z.number().int().nonnegative(),
  suppressedByCooldown: z.number().int().nonnegative(),
  error: z.string().min(1).max(2000).optional(),
});

export type WatchRun = z.infer<typeof WatchRunSchema>;
export type WatchRunMode = z.infer<typeof WatchRunModeSchema>;
export type WatchRunStatus = z.infer<typeof WatchRunStatusSchema>;

export const assertWatchRunInvariants = (run: WatchRun): void => {
  if (run.status === 'running' && run.finishedAt !== null) {
    throw new InvariantError('running watch run 的 finishedAt 必须为 null');
  }
  if (run.status !== 'running' && run.finishedAt === null) {
    throw new InvariantError('已结束 watch run 必须有 finishedAt');
  }
  if (run.finishedAt !== null && run.finishedAt.getTime() < run.startedAt.getTime()) {
    throw new InvariantError('watch run finishedAt < startedAt');
  }
  if (run.status === 'failed' && run.error === undefined) {
    throw new InvariantError('failed watch run 必须有 error');
  }
  if (run.notified + run.suppressedByCooldown > run.triggered) {
    throw new InvariantError('watch run notified + suppressedByCooldown > triggered');
  }
};
