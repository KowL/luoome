// 告警规则的精确 Operation policy（task-39 批次 B）。
//
// **这里只做「冻结与回执」，不发明领域约束。** 规则能否保存的判断全在工具里
// （`alert-plan.ts` 的 `validateReferences` + `assertAlertPlanInvariants`），policy 不复述。
//
// `delete_alert_plan` 是**不可逆**的，所以它的回执价值最高：`bind` 在 prepare 阶段
// 冻结**被删对象的完整快照**（不只是 id），用户才能从回执看出「我删掉的是什么」。
// 这是「回执」相对「日志」的意义所在。
import type { ToolContext } from '@luoome/core';
import {
  type ConfirmablePluginTool,
  CreateAlertPlanInput,
  createAlertPlanTool,
  DeleteAlertPlanInput,
  deleteAlertPlanTool,
  UpdateAlertPlanInput,
  updateAlertPlanTool,
} from '@luoome/tools';

/** 创建：冻结完整输入；回执按 `plan.id` 读回刚写的那条。 */
export const createAlertPlanOperation: ConfirmablePluginTool = {
  tool: createAlertPlanTool,
  scheduled: false,
  hostBoundFields: [],
  bind(raw): unknown {
    return CreateAlertPlanInput.parse(raw);
  },
  async receipt(raw, ctx: ToolContext) {
    const input = CreateAlertPlanInput.parse(raw);
    if (input.id === undefined) return null;
    const plan = await ctx.repos.alertPlan.findById(input.id);
    return plan === null ? null : { ok: true, data: { plan } };
  },
};

/** 更新：冻结完整 patch；回执读回**更新后**的整条规则。 */
export const updateAlertPlanOperation: ConfirmablePluginTool = {
  tool: updateAlertPlanTool,
  scheduled: false,
  hostBoundFields: [],
  bind(raw): unknown {
    return UpdateAlertPlanInput.parse(raw);
  },
  async receipt(raw, ctx: ToolContext) {
    const input = UpdateAlertPlanInput.parse(raw);
    const plan = await ctx.repos.alertPlan.findById(input.alertPlanId);
    return plan === null ? null : { ok: true, data: { plan } };
  },
};

/**
 * 删除。
 *
 * **已知缺口（已上报）**：`delete_alert_plan` 只返回 `{ deleted: true }`，
 * 而 `policy.receipt` 只在 reconcile 路径被调用（`plugin-operations.ts:492`），
 * 正常 confirm 成功路径只返回工具自身输出。
 * ⇒ **「回执证明删了什么」在当前契约下做不到**，需要让 `DeleteAlertPlanOutput` 带快照
 * （改工具契约，超出本任务边界）。这里如实返回 `null`，**不伪造一个看起来像回执的东西**。
 */
export const deleteAlertPlanOperation: ConfirmablePluginTool = {
  tool: deleteAlertPlanTool,
  scheduled: false,
  hostBoundFields: [],
  bind(raw): unknown {
    return DeleteAlertPlanInput.parse(raw);
  },
  async receipt() {
    return null;
  },
};

export const ALERT_PLAN_OPERATION_POLICIES: readonly ConfirmablePluginTool[] = [
  createAlertPlanOperation,
  updateAlertPlanOperation,
  deleteAlertPlanOperation,
];
