// registry 之外的工具定义名单（T04 / REQ-M1-03 守卫）。
//
// `packages/tools/src/registry.ts` 只收 agent 面工具；仓库里另有一批「有 `defineTool`
// 定义、但按设计不进 registry」的工具：workflow 编排里的内部写回、批处理定时入口、
// 私人数据管道的 build/commit 对、以及只能由 operation policy 执行的写路径。
// 它们不是遗漏，但也不能靠「谁记得」维持 —— 本文件把它们登记成一份可守卫的事实。
//
// 配套守卫（`packages/dsh-luoome/src/host/surface-consistency.test.ts`）要求：
//
//   1. registry 名集合 ∪ WORKFLOW_ONLY_TOOL_NAMES ⊇ `packages/tools/src/{tools,queue}`
//      下所有 `defineTool({ name: ... })` 的定义名 —— 新增定义必须登记；
//   2. WORKFLOW_ONLY_TOOL_NAMES 与 registry 不重叠 —— 某个工具收编进 registry 后
//      必须从本名单摘除，名单只能跟着事实收缩。
//
// 两条合起来把「这个工具存不存在」变成可自动对账的问题：名字不在 registry，就必须
// 在这里有出处；名字在这里又被 registry 收了，就是该删的残留。
//
// 运行环境：本文件是纯数据 + 纯函数，不 import `node:sqlite`，Bun 与 Node 都能加载。
// 需要 `production.ts`（暴露面口径）的消费者才受 Node 限制，见 `registry-list.ts`。

/**
 * workflow 编排内部的写回/审计工具：由 `packages/workflows/src/define-workflow.ts`
 * 的 `buildWorkflowTools()` 注入 `ctx.tools`，不注册成 agent 工具。
 *
 * `enqueue_analysis_job` 也在这里：它是分析队列唯一的**生产者**，只由 workflow 编排
 * （`define-workflow.ts` 的 `enqueue_analysis_job` 访问器）调用，registry 永远不收它 ——
 * 所以「队列有消费者没有生产者」这件事在插件形态成立，是设计而不是缺件。
 */
export const WORKFLOW_INTERNAL_TOOL_NAMES: readonly string[] = Object.freeze([
  // 采集/同步
  'sync_watchlist_source',
  'pull_research_vault_git',
  'sync_strategy_watchlist_subscriptions',
  // 运行审计与状态机
  'record_workflow_run',
  'record_watch_run',
  'commit_watch_evaluation',
  'watch_execution',
  'begin_watch_delivery',
  'list_watch_delivery_retries',
  'list_watch_rule_states',
  'save_watch_rule_states',
  'set_watch_trigger_delivery_status',
  'get_watch_trigger_delivery_stats',
  'reconcile_stale_workflow_runs',
  'reconcile_stale_strategy_runs',
  // 账户计划批次
  'begin_account_plan_batch',
  'get_account_plan_batch',
  'finish_account_plan_batch',
  // 报表与触发
  'save_report',
  'set_report_delivery_status',
  'save_watch_trigger',
  // 策略排程
  'claim_due_strategy_schedules',
  'finish_strategy_schedule_claim',
  // 策略自治
  'create_strategy_autonomy_action',
  'transition_strategy_autonomy_action',
  // 分析队列生产者
  'enqueue_analysis_job',
]);

/**
 * 批处理（`packages/batch`）的 5 个 `run_*` 入口：只作为 `scheduled` operation policy
 * 被执行（`packages/dsh-luoome/src/host/batch-operations.ts`），从不注册成 agent 工具。
 *
 * 定义在 `packages/batch`，不在本仓 `packages/tools` 的定义扫描范围内；登记在这里是因为
 * 它们是「registry 之外的 policy 工具」这一事实的另一半，tools:list 与守卫都要认得。
 */
export const BATCH_SCHEDULED_TOOL_NAMES: readonly string[] = Object.freeze([
  'run_strategy_daily_cycle',
  'run_closing_report_cutoff',
  'run_portfolio_performance_snapshot',
  'run_intraday_plan_batch',
  'run_strategy_autonomy_weekly',
]);

/**
 * 只由 operation policy 执行、不作 agent 工具的写路径。
 *
 * **当前为空**：`execute_strict_strategy_backtest` 曾是唯一成员 —— 定义在本包
 * `tools/strategy-backtest.ts`、由插件 policy 执行，却不在 registry。REQ-M1-05 已把它
 * 收编进 registry（一份实现），插件侧不再有同名 policy，因此本组归零。
 *
 * 保留这个空组而不是删掉：它是「registry 之外没有任何 policy-only 工具」这条不变量本身。
 * `tools:list` 的 `surface.operationPoliciesOutsideRegistry` 与
 * `surface-consistency.test.ts` 的 KNOWN_DRIFT 都指向同一件事，谁先破谁红。
 */
export const OPERATION_POLICY_ONLY_TOOL_NAMES: readonly string[] = Object.freeze([]);

/**
 * 有定义、但 src 里没有任何地方引用（历史管道 / 宿主专用）的工具。
 *
 * 保留在名单里只回答「为什么它不在 registry」这一个问题；**是否应当摘除**属 M4-09，
 * 本单不摘除任何工具。它们被登记在此，是为了让定义名扫描不产生未解释的残留。
 */
export const UNWIRED_TOOL_NAMES: readonly string[] = Object.freeze([
  'build_watchlist_facts',
  'commit_watchlist_facts',
  'build_personal_alert_evaluation',
  'commit_personal_alert_evaluation',
  'ensure_default_account',
  'settle_chat_draft',
]);

/** 全部「registry 之外的工具名」，按上面四组顺序拼接；守卫与 tools:list 的唯一入口。 */
export const WORKFLOW_ONLY_TOOL_NAMES: readonly string[] = Object.freeze([
  ...WORKFLOW_INTERNAL_TOOL_NAMES,
  ...BATCH_SCHEDULED_TOOL_NAMES,
  ...OPERATION_POLICY_ONLY_TOOL_NAMES,
  ...UNWIRED_TOOL_NAMES,
]);

export const WORKFLOW_ONLY_TOOL_NAME_SET: ReadonlySet<string> = new Set(WORKFLOW_ONLY_TOOL_NAMES);

/**
 * 有 `defineTool` 定义、却既不在 registry 也不在本名单里的名字。
 *
 * 非空即守卫失败：新增了非 agent 工具却没登记（本单之前的状态就是这个函数返回 32 个名字）。
 */
export const unaccountedToolDefinitions = (
  definedNames: Iterable<string>,
  registryNames: ReadonlySet<string>,
): readonly string[] =>
  [...new Set(definedNames)].filter(
    (name) => !registryNames.has(name) && !WORKFLOW_ONLY_TOOL_NAME_SET.has(name),
  );

/**
 * 本名单里已经被 registry 收编的名字（收编后忘记摘除的残留）。
 *
 * 非空即守卫失败：名单只能收缩，不能与 registry 长期重叠。
 */
export const workflowOnlyNamesInRegistry = (
  registryNames: ReadonlySet<string>,
): readonly string[] => WORKFLOW_ONLY_TOOL_NAMES.filter((name) => registryNames.has(name));
