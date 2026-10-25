/**
 * 队列工具名（设计文档 §5.4.4 消费者实例暴露面）。
 * 部署侧按此名单二次收窄 MCP 暴露面，漏配只会让工具更少。
 */
export const QUEUE_TOOL_NAMES = [
  'claim_analysis_jobs',
  'complete_analysis_job',
  'fail_analysis_job',
  'record_advice',
  'record_analysis_result',
  'get_analysis_context',
  'get_analysis_metrics',
  'list_analysis_jobs',
  'get_analysis_job',
] as const;

/**
 * 交互式分析面的工具名（DSH 独立实例 `luoome-analysis`）。
 *
 * 只收「取事实包 + 校验写回」三个入口，不含 worker 的 claim/complete/fail
 * 与队列管理工具。名单单独维护，不复用 QUEUE_TOOL_NAMES：worker 是批量消费者，
 * 交互面不创建 analysis_job，两者语义不同，不能让一份名单的增删互相牵连。
 */
export const INTERACTIVE_ANALYSIS_TOOL_NAMES = [
  'get_analysis_context',
  'record_advice',
  'record_analysis_result',
] as const;
