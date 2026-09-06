import type { ToolResult } from '@luoome/core';

import type { WorkflowContext, WorkflowStep, WorkflowToolMap } from '../define-workflow.js';

export interface WatchWorkflowContext extends WorkflowContext {
  readonly watchExecutionOwner: string;
}
export type WatchWorkflowStep = (input: unknown, ctx: WatchWorkflowContext) => Promise<unknown>;

/** 盘中与事件共用同一个租约，保护全局配额；每个工具调用前续租并检查所有权。 */
export const watchExecutionStep =
  (steps: readonly WatchWorkflowStep[]): WorkflowStep =>
  async (input, ctx) => {
    const owner = crypto.randomUUID();
    const lease = ctx.tools.watch_execution;
    const acquired = await lease.execute({ action: 'acquire', owner });
    if (!acquired.ok) return acquired;
    if (!acquired.data.acquired)
      return {
        ok: false,
        error: { kind: 'internal', cause: '预警已有运行正在执行，请稍后重试' },
      };
    let lost = false;
    const renew = async (): Promise<boolean> => {
      if (lost) return false;
      try {
        const result = await lease.execute({ action: 'renew', owner });
        lost = !result.ok || !result.data.acquired;
      } catch {
        lost = true;
      }
      return !lost;
    };
    const timer = setInterval(() => void renew(), 30_000);
    const guarded = Object.fromEntries(
      Object.entries(ctx.tools).map(([name, accessor]) => [
        name,
        {
          execute: async (value: unknown): Promise<ToolResult<unknown>> => {
            if (!(await renew()))
              return {
                ok: false,
                error: { kind: 'internal', cause: '预警执行租约已丢失，本轮停止' },
              };
            return accessor.execute(value);
          },
        },
      ]),
    ) as unknown as WorkflowToolMap;
    const guardedContext: WatchWorkflowContext = {
      ...ctx,
      tools: guarded,
      watchExecutionOwner: owner,
    };
    try {
      let current = input;
      for (const step of steps) {
        const value = await step(current, guardedContext);
        if (typeof value === 'object' && value !== null && 'ok' in value) {
          if (!value.ok) return value;
          if ('data' in value) current = value.data;
        } else current = value;
      }
      return current;
    } finally {
      clearInterval(timer);
      await lease.execute({ action: 'release', owner });
    }
  };
