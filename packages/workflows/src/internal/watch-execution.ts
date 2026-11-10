import type { ToolResult } from '@luoome/core';

import type { WorkflowContext, WorkflowStep } from '../define-workflow.js';

export type WatchWorkflowContext = WorkflowContext;

export type WatchWorkflowStep = (input: unknown, ctx: WatchWorkflowContext) => Promise<unknown>;

/** 进程内互斥：单机不再需要数据库租约表或跨实例 fencing。 */
let running = false;

const unwrapStepValue = (
  value: unknown,
):
  | { readonly done: false; readonly value: unknown }
  | { readonly done: true; readonly result: unknown } => {
  if (typeof value === 'object' && value !== null && 'ok' in value) {
    if (!(value as ToolResult<unknown>).ok) return { done: true, result: value };
    return { done: false, value: 'data' in value ? (value as { data: unknown }).data : undefined };
  }
  return { done: false, value };
};

/**
 * 盘中与事件共用同一执行入口：进程内互斥串行保护边沿、配额与发送。
 * 步骤返回值遵循 workflow 引擎语义（ToolResult 自动解包、error 短路）。
 */
export const watchExecutionStep =
  (steps: readonly WatchWorkflowStep[]): WorkflowStep =>
  async (input, ctx) => {
    if (running) {
      return {
        ok: false,
        error: { kind: 'internal', cause: '预警已有运行正在执行，请稍后重试' },
      };
    }
    running = true;
    const guardedContext: WatchWorkflowContext = ctx;
    try {
      let current = input;
      for (const step of steps) {
        const value = await step(current, guardedContext);
        const unwrapped = unwrapStepValue(value);
        if (unwrapped.done) return unwrapped.result;
        current = unwrapped.value;
      }
      return current;
    } finally {
      running = false;
    }
  };
