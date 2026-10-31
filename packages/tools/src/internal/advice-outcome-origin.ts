import type { AdviceOutcomeOrigin, ToolContext } from '@luoome/core';

/**
 * 回填来源只能由**执行通道**决定，不能由调用方参数决定（REQ-M3-18 §2）。
 *
 * 装配方按 surface 注入 `ctx.adviceOutcomeOrigin`：用户亲自点击的复盘页注入 `user`，
 * 导入入口注入 `import`；其余（agent 会话、定时任务、脚本、测试）保持缺省。
 * 缺省按 `model` 盖章是刻意选的方向：把真人回填误记成 `model` 只会让默认统计少算
 * 一条并披露，而反过来让模型把自己写成 `user`，命中率就变成模型自评自证。
 */
export const adviceOutcomeOriginOf = (ctx: ToolContext): AdviceOutcomeOrigin =>
  ctx.adviceOutcomeOrigin ?? 'model';
