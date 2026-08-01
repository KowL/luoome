# Tool selection

MCP discovery is the authoritative tool inventory. Tool names, descriptions and input schemas may evolve; inspect the connected tool schema before calling it. For local diagnosis, `luoome tools list --json` lists registry metadata and `luoome tools inspect <name>` shows a tool schema.

## Read

Use read tools to identify subjects and inspect current state before deeper analysis or mutation:

- Accounts and positions: `list_accounts`, `get_account`, `list_holdings`, `get_holding`, `list_trades`.
- Stock discovery and calculations: `search_stocks`, `compute_indicators`. Indicators include
  RSI14, MA20/MA60 distance and cross recency, plus Bollinger 20-day bands, bandwidth and position.
- Strategies and signals: `list_strategies`, `get_strategy`, `list_strategy_runs`,
  `get_strategy_run`, `strategy_signals_by_stock`.
- Watchlists and monitoring: `list_watchlists`, `get_watchlist`, `list_watchlist_changes`,
  `list_alert_plans`, `list_watch_triggers`, `get_watch_status`.
- Research and events: `list_research_topics`, `list_research_documents`, `get_stock_research_view`, `list_stock_events`.
- Limit-up ladder snapshot (Phase 1): `limit_up_ladder` for a single-day ladder, `limit_up_ladder_compare` for cross-day diff. Pure read-only structured data — never interpret level as a buy/sell signal.
- Health and audit: `get_market_data_status`, `list_workflow_runs`, advice statistics and calibration tools.

Prefer one filtered list or batch tool over repeated per-item calls. `batch_quote` is classified as external because it contacts a market source.

## Advice

Use advice tools only for an explicit analysis request:

- `analyze_stock` for a stock-level recommendation.
- `analyze_position` for a recommendation grounded in an existing holding.
- `market_outlook` for a market or sector view.

## Write

Write tools create or change local records, including accounts, holdings, trades, Strategies,
Watchlists, AlertPlans, research notes, stock events and feedback. Before calling one:

1. Read the target state and resolve stable IDs.
2. Restate exact values, especially stock, side, quantity, price, time and account.
3. Obtain explicit authorization for that mutation.
4. Call using the discovered input schema.
5. Verify the returned result and re-read state when correctness matters.

Internal persistence tools such as watch-run or trigger recording are intended for workflows; do not invoke them for normal user requests unless their MCP description explicitly supports the requested operation.

## External

External tools fetch market/event data, validate or run Strategies, synchronize data or send
notifications. Full-market or persisted Strategy runs require confirmation; bounded
`run_strategy` dry-runs must use `persist=false`.

## Never exposed

Real order placement and cancellation are outside the luoome MCP surface. Do not search for a workaround, call a broker directly, reinterpret a write tool as an order, or claim an Advice was executed.

For permission and response requirements, read [safety and errors](./safety.md).
