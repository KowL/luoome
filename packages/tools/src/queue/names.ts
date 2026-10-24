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
