# Tool selection

MCP discovery is the authoritative tool inventory. Tool names, descriptions and input schemas may evolve; inspect the connected tool schema before calling it. For local diagnosis, `luoome tools list --json` lists registry metadata and `luoome tools inspect <name>` shows a tool schema.

## Read

Use read tools to identify subjects and inspect current state before deeper analysis or mutation:

- Accounts and positions: `list_accounts`, `get_account`, `list_holdings`, `get_holding`, `list_trades`.
- Stock discovery and calculations: `search_stocks`, `compute_indicators`. Indicators include
  RSI14, MA20/MA60 distance and cross recency, plus Bollinger 20-day bands, bandwidth and position.
- Strategies and signals: `list_strategies`, `get_strategy`, `list_strategy_runs`,
  `get_strategy_run`, `strategy_signals_by_stock`, `list_strategy_autonomy_actions` (audit trail
  of AI-managed lifecycle actions such as automatic pauses). `run_local_selector_research` performs a
  deterministic PIT cross-sectional research ranking from batch qfq DailyBar revisions; its score
  is a same-batch rank, not a probability. `assess_adaptive_personality` only checks whether an
  immutable parameter version has separate training/validation evidence; `unavailable` means no
  adaptive conclusion may be shown.
- Watchlists and monitoring: `list_watchlists`, `get_watchlist`, `list_watchlist_changes`,
  `list_strategy_watchlist_subscriptions`.
  `list_alert_plans`, `list_watch_triggers`, `get_watch_status`.
- Research and events: `list_research_topics`, `list_research_documents`, `get_stock_research_view`, `get_research_embedding_status`, `list_stock_events`.
  The `profile` returned by `get_stock_research_view` is a ResearchTopic/ResearchDocument read
  model with evidence, counter-evidence and unknowns. It is not a Strategy, Advice or expected-return estimate.
- Limit-up ladder snapshot (Phase 1): `limit_up_ladder` for a single-day ladder, `limit_up_ladder_compare` for cross-day diff. Pure read-only structured data — never interpret level as a buy/sell signal.
- Dragon-tiger list: `dragon_tiger_list` returns one trading day's billboard entries (close, change, turnover, reason, net/buy/sell amounts). Pure read-only structured data — never interpret billboard presence as a buy/sell signal.
- Northbound flow: `northbound_flow` returns the daily northbound (Shanghai + Shenzhen Connect) series — turnover always present; daily net buy/sell amounts are only available before 2024-08-16 (exchange disclosure change) and are `null` afterwards. Pure read-only structured data.
- Financial news: `fetch_news` returns paged eastmoney or 10jqka headline streams (title, summary, inferred category, media source, publish time, url). Use `source` to select a stream and `page` for pagination. Category is a title-keyword heuristic, not an upstream fact. Pure read-only.
- Sector quotes: `fetch_sector_quotes` returns eastmoney industry-sector realtime snapshots (code, name, price, changePct, amount, up/down counts, leading stock), sortable by changePct (default) or amount. Pure read-only structured data — never interpret sector strength as a buy/sell signal.
- Health and audit: `get_market_data_status`, `list_workflow_runs`, advice statistics and calibration tools.

Market View Phase 4: `get_stock_minute_bars` returns independent OHLCV MinuteBar facts for the
current session when a configured provider has `minute-bars` capability. It reports partial gaps,
stale local fallback, or unavailable explicitly; historical dates are limited to retained local
data and are never synthesized from `PriceSnapshot` or cumulative `IntradayMinute` rows.

Prefer one filtered list or batch tool over repeated per-item calls. `batch_quote` is classified as external because it contacts a market source.
Use `add_watchlist_members` for one or more manual Watchlist additions so the whole request is validated and confirmed once.

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

Internal persistence tools such as watch-run or trigger recording are intended for workflows; do not invoke them for normal user requests unless their MCP description explicitly supports the requested operation.

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
