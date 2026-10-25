// dsh-luoome 可安装插件的 host 入口（M1c 空壳，需求 §6.3）。
//
// 生产 apply 直接复用 task-6 的 composition root：Node SQLite + 真实 adapters + 真实只读/市场
// 工具 + 宿主认证路由 + M2b 的原生确认写回 policies。owner、LUOOME_HOME 与 adapters env 全部
// 来自受信任部署环境，不接受 HTTP/模型参数提升。M3b 起随包注册四个投研技能；M4 起
// 提供宿主认证的 GET /api/luoome/state?panel=overview|strategies|review 与随包 client bundle。
import type { Context } from '@deepseek-ai/cordis';
import { apply as applyProductionHost, REQUIRED_HOST_SERVICES } from './production.js';
import { registerBundledSkills } from './skills.js';

export {
  createAnalysisOperationPolicies,
  createRecordAdviceOperation,
  createRecordAnalysisResultOperation,
  type TrustedAnalysisProvenance,
} from './analysis-operations.js';
export { createBatchOperationPolicies } from './batch-operations.js';
export {
  assertExternalMarketAllowlist,
  createMarketSurface,
  DEFAULT_MARKET_TIMEOUT_MS,
  type MarketSurface,
  type MarketSurfaceConfig,
  registerMarketTools,
} from './market-surface.js';
export {
  createPanelStateHandler,
  DEFAULT_PANEL_MARKET_TIMEOUT_MS,
  MAX_STRATEGY_WORKSPACES,
  PANEL_NAMES,
  PANEL_PLANS,
  type PanelName,
  type PanelStateResponse,
  type PanelStateTool,
  projectPanelTool,
  STRATEGY_WORKSPACE_TOOL,
} from './panels.js';
export {
  createProductionHost,
  createProductionOperationPolicies,
  TRUSTED_ANALYSIS_PROVENANCE,
} from './production.js';
export {
  DEFAULT_MARKET_TOOL_ALLOWLIST,
  DEFAULT_READ_TOOL_ALLOWLIST,
} from './production-config.js';
export {
  createAdviceOutcomeOperationPolicies,
  createCreateStrategyOperation,
  createCreateStrategyVersionOperation,
  createPublishStrategyVersionOperation,
  createRecordAdviceOutcomeOperation,
  createStrategyLifecycleOperationPolicies,
  createStrategyOperationPolicies,
  createValidateStrategyVersionOperation,
  operationStrategyId,
} from './strategy-operations.js';

/**
 * DSH/Cordis 插件依赖声明：缺少任一宿主服务时插件不激活，而不是降级成无认证/半成品入口。
 * 身份 guard 在工具执行时读取活 Agent；必须在插件作用域声明该依赖。
 */
export const inject = [
  ...REQUIRED_HOST_SERVICES,
  // 随包技能注册需要 DSH skill registry；缺失时插件不激活（fail-loud），不降级成无技能启动。
  'skills',
] as const;

/**
 * DSH 插件生产入口：装配只读 host 并把 dispose 交给宿主生命周期。
 * 装配失败（owner 缺失、trade 硬卡、allowlist 误配、宿主服务缺失）直接抛错，由
 * DSH fail-loud 报告，不写入任何业务数据。
 */
export const apply = async (ctx: Context): Promise<void> => {
  // 先装配生产 host，再注册随包技能：装配失败不会留下半注册的 catalog。
  // effect 挂在插件 fiber 上，宿主 dispose 插件时四个技能注册一起撤销。
  await applyProductionHost(ctx);
  ctx.effect(() => registerBundledSkills(ctx));
};
