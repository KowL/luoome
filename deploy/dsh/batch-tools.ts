/**
 * 批处理面暴露给 DSH 定时任务的工具白名单。
 * 名单本体在 @luoome/dsh-bridge（profile 装配处），这里只做转发，
 * 避免 profile 与部署脚本各留一份名字表。
 */
export { BATCH_TOOL_NAMES } from '../../packages/dsh-bridge/src/standalone-profile.js';
