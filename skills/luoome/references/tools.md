# Tool selection

MCP discovery is the authoritative tool inventory. Tool names, descriptions and input schemas may evolve; inspect the connected tool schema before calling it. For local diagnosis, `luoome tools list --json` lists registry metadata and `luoome tools inspect <name>` shows a tool schema.

## Read

Use read tools to identify subjects and inspect current state before deeper analysis or mutation:

- Accounts and positions: `list_accounts`, `get_account`, `list_holdings`, `get_holding`, `list_trades`,
  `get_account_facts`, `reconcile_account_cash`. Account facts are unavailable when quotes are
  missing, cash does not reconcile, or quantity coverage has gaps. Do not infer precise assets
  or position sizes from incomplete facts. Cash reconciliation includes persisted holding
  adjustments, including registrations whose positions have since been sold.
- Stock discovery and calculations: `search_stocks`, `compute_indicators`. Indicators include
  RSI14, MA20/MA60 distance and cross recency, plus Bollinger 20-day bands, bandwidth and position.
- Strategies and signals: `list_strategies`, `get_strategy`, `list_strategy_runs`,
  `get_strategy_run`, `strategy_signals_by_stock`, `list_strategy_autonomy_actions` (audit trail
  of AI-managed lifecycle actions such as automatic pauses). `run_local_selector_research` performs a
  deterministic PIT cross-sectional research ranking from batch qfq DailyBar revisions; its score
  is a same-batch rank, not a probability. `assess_adaptive_personality` only checks whether an
  immutable parameter version has separate training/validation evidence; `unavailable` means no
  adaptive conclusion may be shown. `list_strategy_runs` supports `since` / `until` on run start
  time; use both for a historical report window so later runs cannot displace its results.
  `get_strategy_insight_facts` and `generate_strategy_insight` accept the same historical window;
  their industry directory and AlertPlan configuration still reflect current state.
- Watchlists and monitoring: `list_watchlists`, `get_watchlist`, `list_watchlist_changes`,
  `list_strategy_watchlist_subscriptions`.
  `list_alert_plans`, `list_watch_triggers`, `get_watch_status`, `get_intraday_delivery_audit`.
- Research and events: `list_research_topics`, `list_research_documents`, `get_stock_research_view`, `get_research_embedding_status`, `list_stock_events`.
  The `profile` returned by `get_stock_research_view` is a ResearchTopic/ResearchDocument read
  model with evidence, counter-evidence and unknowns. It is not a Strategy, Advice or expected-return estimate.
- Limit-up ladder snapshot (Phase 1): `limit_up_ladder` for a single-day ladder, `limit_up_ladder_compare` for cross-day diff. Pure read-only structured data — never interpret level as a buy/sell signal.
- Dragon-tiger list: `dragon_tiger_list` returns one trading day's billboard entries (close, change, turnover, reason, net/buy/sell amounts). Pure read-only structured data — never interpret billboard presence as a buy/sell signal.
- Northbound flow: `northbound_flow` returns the daily northbound (Shanghai + Shenzhen Connect) series — turnover always present; daily net buy/sell amounts are only available before 2024-08-16 (exchange disclosure change) and are `null` afterwards. Pure read-only structured data.
- Financial news: `fetch_news` returns paged eastmoney or 10jqka headline streams (title, summary, inferred category, media source, publish time, url). Use `source` to select a stream and `page` for pagination. Category is a title-keyword heuristic, not an upstream fact. Pure read-only.
- Sector quotes: `fetch_sector_quotes` returns eastmoney industry-sector realtime snapshots (code, name, price, changePct, amount, up/down counts, leading stock), sortable by changePct (default) or amount. Pure read-only structured data — never interpret sector strength as a buy/sell signal.
- Health and audit: `get_market_data_status`, `list_workflow_runs`, `get_closing_batch_audit`,
  advice statistics and calibration tools. Closing batch audit reads each account's batch runs,
  main report, supplements and notification state for one trading day.

Market View Phase 4: `get_stock_minute_bars` returns independent OHLCV MinuteBar facts for the
current session when a configured provider has `minute-bars` capability. It reports partial gaps,
stale local fallback, or unavailable explicitly; historical dates are limited to retained local
data and are never synthesized from `PriceSnapshot` or cumulative `IntradayMinute` rows.

Market View chart contract: `get_stock_market_view` returns quote, candles, indicators and
`markers` — chart facts pinned to trading days (trade / advice / watch-trigger / strategy-signal /
report / research / limit-up). Marker field rules:
`date` is always the day-level fact date; under weekly/monthly `granularity` the server adds
`barDate` pointing at the last bar of the aggregation bucket, so chart annotations must anchor on
`barDate ?? date` (a marker whose whole bucket is suspended gets no `barDate`).
`direction` (`bullish` / `bearish` / `neutral`) and `ruleId` are present only on strategy-signal
markers — direction drives annotation coloring/grouping, ruleId identifies the triggering rule
(for example to collapse consecutive same-rule signals). Treat both as absent for other fact kinds.

Prefer one filtered list or batch tool over repeated per-item calls. `batch_quote` is classified as external because it contacts a market source.
Use `add_watchlist_members` for one or more manual Watchlist additions so the whole request is validated and confirmed once.

Account-scoped decision review reads: `get_decision_review_context`, `list_decision_reviews`,
`get_decision_write_receipt`, and `get_decision_review_snapshot`. Keep the account and
`throughSequence` fixed while paging; `timeBasis` selects source time or revision recording time
for the half-open `since`/`until` window.
A missing feedback or PnL remains unknown rather than zero.

## Advice

Use advice tools only for an explicit analysis request:

- `analyze_stock` for a stock-level recommendation.
- `analyze_position` for a recommendation grounded in an existing holding.
- `market_outlook` for a market or sector view.

## Write

Write tools create or change local records, including accounts, holdings, trades, Strategies,
Watchlists, explicit Strategy → Watchlist subscriptions, AlertPlans, stock events and feedback.
`confirm_strategy_autonomy_action` and `reject_strategy_autonomy_action` are the human-review
queue for AI-managed Strategy lifecycle: they only act on `blocked` actions, and confirm
publishes the candidate version. `archive_strategy` finalizes a paused user Strategy as a
terminal state (no automatic resume) and removes its schedule; active, draft and builtin
Strategies are rejected. Before calling one:

1. Read the target state and resolve stable IDs.
2. Restate exact values, especially stock, side, quantity, price, time and account.
3. Obtain explicit authorization for that mutation.
4. Call using the discovered input schema.
5. Verify the returned result and re-read state when correctness matters.

`save_decision_review` records explicit account feedback and trade links; `refresh_decision_review_report`
creates an immutable local-only closing/weekly supplement with `notificationPolicy=never`.
`record_decision_trade` registers an already executed external trade into the local ledger and is
classified `trade`; MCP does not expose it. Never use it to place an order. Use a stable
`requestId` and check the receipt before retrying an uncertain response.

Holding writes can reject a concurrent change. Refresh the holding before retrying; never replay
stale quantities or costs. Cash changes and their ledger records commit together.

The built-in investment assistant can draft `create_account`, `add_holding`, `update_holding`,
`close_holding`, and `create_portfolio_cash_flow` in portfolio/general conversations. These change
local ledger records, never broker orders. Do not guess amounts, quantities, costs, or dates.
The Web-only `settle_chat_draft` capability requires both write and external opt-in and an
explicitly approved persisted session/message/toolCallId. It is not exposed through MCP or the
generic registry. The Web confirmation endpoint executes only saved draft input and returns its
durable status and actual ToolResult; repeated confirmations do not repeat execution. External
agents should use the exposed target tools with normal confirmation. Never fabricate assistant
messages or retry an interrupted `executing` draft before reconciling the actual ledger.

`create_strategy_observation_candidates` defaults to published operational runs. Evaluation observations
require an explicit `evaluationSessionId` matching a completed run in that session; they remain research
facts and never create Watchlist membership or Advice. `complete_strategy_observations` can restrict
completion to `runIds` and uses local qfq bars only.

Internal persistence tools such as watch-run or trigger recording are intended for workflows; do not invoke them for normal user requests unless their MCP description explicitly supports the requested operation.

`watch_execution`, `commit_watch_evaluation`, `begin_watch_delivery` are workflow-only write
primitives; `list_watch_delivery_retries` is workflow-only read. They are not in public registry/MCP
discovery. Alert previews do not write triggers or consume live state. Live delivery retries are
bounded to three attempts within the Shanghai calendar day and count against daily quotas.

`subscribe_strategy_to_watchlist` and `unsubscribe_strategy_from_watchlist` are the explicit subscription
contract. A Strategy has no Watchlist projection without an active subscription. Published operational runs
may project only to subscribed targets; complete sync can end missing Strategy sources, while partial/failed
sync only marks them stale. Evaluation, trial, `persist=false`, withheld, non-publishing and failed runs never
change a Watchlist. The internal projection bridge is orchestration-only and is not registry/MCP-exposed.

## External

External tools fetch market/event data, validate or run Strategies, synchronize data or send
notifications. A bounded single-version sample uses the external-only `trial_strategy` tool;
it forces `persist=false` and does not accept `mode=scheduled`. Full-market or persisted Strategy
runs require confirmation and both capabilities; use `run_strategy` with `persist=true`.

Research semantic search and cross-model evaluation are external calls. `search_research_documents_hybrid` sends the query text to the configured embedding provider and must preserve its `complete`, capability, EvidenceRef, counter-evidence, risks and unknowns fields. `rebuild_research_embeddings` additionally sends private research chunks and writes a rebuildable projection, so it requires both external and write authorization. Never interpret zero hits from an incomplete projection as absence of evidence.

Research Vault 的 `pull_research_vault_git` 是 workflow-only，故意不在 registry/MCP discovery 中。
远端同步只能由用户通过 CLI 的 `sync-research-vault-remote` workflow 或本地 Web 研究页显式确认；
它需要 write/external 双 opt-in，且不会自动 commit、push、reset、rebase 或解决冲突。

## Never exposed

Real order placement and cancellation are outside the luoome MCP surface. Do not search for a workaround, call a broker directly, reinterpret a write tool as an order, or claim an Advice was executed.

For permission and response requirements, read [safety and errors](./safety.md).


`get_watchlist` accepts optional `accountId` for a scoped view: portfolio sources from other accounts are omitted, while independent manual/strategy sources remain. Omitting it keeps the shared workspace view. `list_watch_triggers` adds `stockName` when the local stock directory can resolve it; missing names must not be inferred from codes. Both remain read-only tools.

`list_watch_triggers` filters in the repository before pagination and returns an exact `total`. Use `offset` (default 0) and `limit` to page; `priority`, `feedback` (including `unreviewed`), `deliveryStatus`, and `triggerType` are supported. For browsing a fixed time window, keep `since` and `until` unchanged across pages. It no longer scans only the latest 10,000 records. Set `includeSummary: true` to also receive priority, delivery and feedback counts and per-stock counts, highest priority and latest event across the entire filtered window, independently of pagination. Summary is omitted by default. Use `orderBy: "priority"` to sort urgent, important, then normal before pagination; within a priority, newer events come first with descending ID as a tie-breaker. The default `orderBy: "recent"` preserves chronological browsing. Summary latest events always follow time order.

### 交易计划与盘中通知

- `get_intraday_delivery_audit` 按账户、上海自然日统计全部持久化盘中行动候选，不受触发历史分页限制；
  分开返回渠道受理是否在 10 分钟内、超时、失败/抑制等终态及缺失源时间。渠道受理不等于设备送达。
- `list_trading_plans` 可传 `includeMonitoring=true`，读取每个版本的监控资格、阻塞原因与下一步；
  同时返回服务端选择的当前版本 `views` 和实际截止时间 `monitoring.expiresAt`；
  `lastReviewedAt` / `nextReviewAt` 结合复核审计呈现最近与下次复核时间，不修改原版本期限。
  `currentOnly=true` 按账户、股票计划聚合后应用 `limit`，保留主版本与最新修订草案。
  `get_trading_plan` 返回不可变原始计划与当前监控资格。草案最多两个交易日，重复生成不续命。
  `createdSince` / `createdUntil` 按版本创建时间筛选，先过滤再应用 `limit`，可用于交易日复盘；
  `active` 是保存状态，`ready` 是当前资格，均不能证明后台正在监控或飞书已送达。
- `list_workflow_runs` 返回 `inputSummary`，可按留存的账户归属识别计划复核；`summary.reviews` 中的
  新增、维持与重复草案按目标日和确切版本统计，不能用“没有新增版本”推断未复核。
- `intraday-trading-plan-watch` 按全部入场条件合成单个提醒，风险/退出条件优先；盘中不调用 AI、不自动改写计划。
  观察条件满足只提示重新评估；未持仓风险只提示暂停入场。通知保留反证、风险和卖出限制。
- `notify=false` 为不消耗边沿与通知额度的试跑；正式调用仍需 write/external 授权。
  Workflow 输出已移除 `reviewedPlans`，后续计划版本由盘后批次或用户主动复核产生。

### 飞书摘要

`render_report` 支持 `format=notification`，输出有长度预算的移动通知摘要；完整内容仍用
`markdown` / `plain-text`。摘要仅允许市场、策略研究、预警和事件板块，不包含账户估值、持仓仓位、交易计划、
交易归因及个人复盘，也不披露其数据缺口；隐藏内部 ID、原始证据和宽表格，保留研究风险及有效期。
策略推荐将同一批次的规则兜底合并为「分析未完成」通知，不能把它当作 AI 推荐或交易依据。
