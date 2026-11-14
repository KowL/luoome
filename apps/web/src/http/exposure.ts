import type { SideEffect } from '@luoome/core';
import { toolRegistry } from '@luoome/tools';

/**
 * Web 端暴露面（对齐 ARCHITECTURE §7.1）：默认只放行 read + advice。
 * write 需 LUOOME_EXPOSE_WRITE=true、external 需 LUOOME_EXPOSE_EXTERNAL=true 且命中
 * WEB_ALLOWED_EXTERNAL 白名单才放行（见 /api/tools/:name/call 的门控）；
 * MCP 暴露面同样默认只读（write 需 LUOOME_EXPOSE_WRITE）。
 */
export const EXPOSED_SIDE_EFFECTS: ReadonlySet<SideEffect> = new Set(['read', 'advice', 'write']);

/**
 * external 白名单仅包含目标模型运行、行情读取与显式同步；
 * sync_quotes / send_notification 等仍不对通用 Web tool call 开放。
 */
export const WEB_ALLOWED_EXTERNAL: ReadonlySet<string> = new Set([
  'fetch_quote',
  'batch_quote',
  'fetch_index_quotes',
  'fetch_intraday_minutes',
  'get_stock_minute_bars',
  'get_ashare_sentiment',
  'get_stock_market_view',
  'get_account_performance',
  'sync_stock_universe',
  'sync_daily_bars',
  'run_strategy',
  'trial_strategy',
  'generate_strategy_insight',
  'propose_strategy_version_draft',
  'trial_strategy_version',
]);

/**
 * external（白名单外）/trade tool 不通过 web 暴露：已在 registry 实现的被
 * sideEffect 门拦截（403 文案准确）；本表覆盖「契约里有名字但尚未实现」的
 * tool——同样按契约返回 403 permission_denied，而不是 404 not_found。
 * （write 默认不放行；未实现的 write 类契约 tool 走 not_found。）
 */
export const KNOWN_UNEXPOSED_TOOLS: Readonly<Record<string, SideEffect>> = {
  generate_report: 'external',
  place_order: 'trade',
  cancel_order: 'trade',
};

// Inventory only; side effects, Origin and scene permissions are checked by their callers.
export const WEB_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  toolRegistry.all().map((tool) => tool.name),
);
