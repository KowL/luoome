// 删除类工具的精确 Operation policy（决策 3-C / 外部评审①）。
//
// ## 为什么不加人工二次确认
//
// Codex 明确裁定：**当前个人版已经在 prepare 后内部直接 confirm**，接入 Operation
// **不意味着用户或模型必须再走一次确认交互**。
// 用户明确授权了具体删除对象及范围，就执行；另加一次人工审批
// **解决不了回执缺失，也不应被当成审计前提**。
//
// 而且这条路径**实测如此**：`operations.ts:59-72` 的 prepare 端点若拿到
// `confirmationToken` 会当场 confirm，响应是**已终结**的 Operation（`state: 'succeeded'`）
// 且回执里带 `result`。所以「接进 Operation」的真实含义是
// **一次请求完成删除 + 结果落 `resultJson` 可查**，不是「多一步确认」。
//
// ## 为什么 `receipt()` 一律返回 `null`
//
// 回执正文来自**工具自身的输出**（`plugin-operations.ts:365` 的成功路径写的就是
// `JSON.stringify(result)`）。决策 3-B 已让这些工具的输出带**有明确范围的摘要**，
// 所以摘要本来就进了 `resultJson`。在这里再算一份就是第二来源，容易与工具输出漂移。
// 这里返回 `null` = **不重复实现**，不是「做不到」。
//
// ## 为什么这里**没有** `delete_chat_session`（不是漏了）
//
// **H1 暴露面决策**（`packages/tools/src/exposure/classify.ts:19-22`）：
// > chat 面：会话由 DSH 宿主承载，领域层 chat 工具没有插件入口
//
// `DEFAULT_READ_TOOL_ALLOWLIST` 与 `createProductionOperationPolicies()` **都不收录**
// chat-session 工具，它们在只读面/可写面永远不可达（`classify.ts:70-80` 有同样的表述）。
// 把 `delete_chat_session` 接进来等于给领域层 chat 工具开插件入口——
// 那是**把宿主职责往领域层搬**，与整个架构方向相反。
//
// 所以它是**有摘要、不进 Operation**：删除结果仍通过工具输出返回（决策 3-B 已做），
// 只是没有 Operation 回执。**若将来要接，先推翻 H1，那是暴露面决策而非本文件的事。**
//
// ## 为什么全部 `scheduled: false`
//
// 删除是用户当下的明确动作，不应被定时任务调用。`scheduled: true` 会把它们
// 暴露给自动化授权路径，那是**扩大暴露面**而非本任务目标。
import type { ConfirmablePluginTool } from '@luoome/tools';
import {
  DeleteAdviceInput,
  DeleteReportInput,
  DeleteStockEventInput,
  DeleteStrategyInput,
  deleteAdviceTool,
  deleteReportTool,
  deleteStockEventTool,
  deleteStrategyTool,
} from '@luoome/tools';

/** 删除策略：级联删版本、调度、运行结果、信号与观察；不可逆。 */
export const deleteStrategyOperation: ConfirmablePluginTool = {
  tool: deleteStrategyTool,
  scheduled: false,
  hostBoundFields: [],
  bind(raw): unknown {
    return DeleteStrategyInput.parse(raw);
  },
  async receipt() {
    return null;
  },
};

/** 批量删除建议（1-100 条）：逐项结果在工具输出里，随回执落库。 */
export const deleteAdviceOperation: ConfirmablePluginTool = {
  tool: deleteAdviceTool,
  scheduled: false,
  hostBoundFields: [],
  bind(raw): unknown {
    return DeleteAdviceInput.parse(raw);
  },
  async receipt() {
    return null;
  },
};

/** 删除报告（历史账簿记录）；摘要含 kind / periodEnd / serializedChars，不塞正文。 */
export const deleteReportOperation: ConfirmablePluginTool = {
  tool: deleteReportTool,
  scheduled: false,
  hostBoundFields: [],
  bind(raw): unknown {
    return DeleteReportInput.parse(raw);
  },
  async receipt() {
    return null;
  },
};

/** 删除手工公司事件（external 事件被工具本身拒绝，不进这里）。 */
export const deleteStockEventOperation: ConfirmablePluginTool = {
  tool: deleteStockEventTool,
  scheduled: false,
  hostBoundFields: [],
  bind(raw): unknown {
    return DeleteStockEventInput.parse(raw);
  },
  async receipt() {
    return null;
  },
};

export const DELETION_OPERATION_POLICIES: readonly ConfirmablePluginTool[] = [
  deleteStrategyOperation,
  deleteAdviceOperation,
  deleteReportOperation,
  deleteStockEventOperation,
];
