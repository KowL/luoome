# Tool selection

MCP discovery is the authoritative tool inventory. Tool names, descriptions and input schemas may evolve; inspect the connected tool schema before calling it. For local diagnosis, `luoome tools list --json` lists registry metadata and `luoome tools inspect <name>` shows a tool schema.

The public Agent inventory is derived from the typed tool catalog; discovery further filters permissions and ready dependencies. Pure UI CRUD
(account rename, cash reconciliation, member drag-sort, chat sessions, report rendering,
strategy lifecycle, observation stats …) is an Application Service behind Web/CLI and is not
an MCP tool. Do not infer a new MCP permission from an exported TypeScript function or a
Web HTTP route.

## Read

Market and盘面资讯:

- `search_stocks` — code / name / pinyin search of the local stock directory.
- `get_stock_market_view` — one call for quote + candles + MA/MACD/RSI summary and chart
  `markers` pinned to trading days. Under weekly/monthly `granularity` anchor markers on
  `barDate ?? date`; `direction`/`ruleId` exist only on strategy-signal markers.
- `fetch_quote` — single or batch (`stockId` or `stockIds`) realtime quote; writes
  quote_snapshot and falls back to the latest local snapshot.
- `fetch_index_quotes` — core index (上证/深证/创业板/科创50) realtime quotes.
- `fetch_sector_quotes` — industry/concept sector ranking with leading stock.
- `compute_indicators` — daily/intraday MA/EMA/MACD/RSI/KDJ/BOLL/ATR.
- `limit_up_ladder` — one trading day's limit-up ladder and promotion rate.
- `limit_up_market` — one call for the limit-up dashboard: that day's limit-up pool (per-stock
  seal amount, open times, raw limit-up reason), limit-up statistics (seal rate, opened count,
  board tiers with promotion rates) and the fixed ~30-trading-day consecutive-board matrix.
  The matrix window does not follow `date`; a missing dimension is `null` plus a warning token.
- `dragon_tiger_list` — one trading day's billboard entries (net/buy/sell, reason).
- `dragon_tiger_flow` — cross-day billboard concept flow: cumulative concept net trajectory,
  org/hot decomposition and top contributors. Requires `FUYAO_API_KEY` (同花顺 truth source).
- `northbound_flow` — daily northbound series; net buy/sell is `null` after 2024-08-16.
- `fetch_news` — market news stream; `includeSentiment=true` also returns the A-share
  sentiment snapshot (`sentiment`) in the same call.

Stock pools, strategies and portfolio:

- `list_watchlists` / `get_watchlist` — pools, members and recent changes.
- `list_strategies` / `get_strategy` — Strategy and its immutable version history.
- `get_strategy_signals` — StrategySignals for a stock plus T+1/T+3/T+5 observation stats
  (descriptive; signal ≠ Advice and ≠ trade).
- `get_account_overview` — account + holdings + account facts in one call; use it instead
  of stitching separate account, holding and cash queries.
- `get_account_performance` — NAV curve, TWR, drawdown and attribution.
- `list_trades` — account trade history.
- `get_advice` — advice history with outcomes; `includeDecisionReviews=true` also returns
  decision reviews for the same account/subject.
- `search_research_documents` — FTS5 search over local research notes; reports
  `capability: 'fts' | 'metadata'` so metadata-only degradation is explicit.
- `list_watch_plans` — active TradingPlans + AlertPlans + recent triggers.

## Advice

Use advice tools only for an explicit analysis request:

- `analyze_stock` — stock analysis (`scope: 'stock'`), market/sector outlook
  (`scope: 'market'`) or Strategy-candidate analysis (`scope: 'strategy-candidate'`).
  All modes persist a structured Advice with evidence, counter-evidence, risks and validity.
- `analyze_position` — position-grounded advice using current cost/size.

Advice is never a trade and never auto-executes.

## Write

- `create_watchlist` / `update_watchlist_members` — create a pool; add/update/remove members
  (stage, priority) in one validated batch.
- `save_strategy_version` — `create-strategy` | `save-version` | `validate` | `publish`.
- `run_strategy` — run a published version over a stock scope; `persist=true` for a formal
  run, `persist=false` with explicit `stockIds` for a trial.
- `run_strategy_backtest` — `run` (create + execute) | `execute` | `get` | `list`; returns
  return/win-rate/drawdown metrics.
- `update_holding` — `mode=update` correct quantity/cost, `mode=open` open a holding,
  `mode=close` close it.
- `save_research_document` — `target=note` writes a managed Markdown note into the local
  Vault and reindexes it (excerpt ~1000 chars + stockCodes); `target=report` saves a deep
  report. Vault sync only reads local Markdown; remote Git sync and semantic search are not part of the current surface.
- `save_decision_review` — record a post-hoc review on an advice/plan/trade.
- `save_trading_plan` — immutable per-stock TradingPlan version with budget checks.
- `save_alert_plan` — create (no `alertPlanId`) or update an AlertPlan.
- `prune_strategy_history` — storage retention: clears per-stock run details outside the
  keep window and expired settled signal observations. Defaults to `dryRun=true`; it never
  deletes run metadata or StrategySignals.

`add_trade` is intentionally **not** an MCP tool: real trade records are entered by the
user in the local CLI/Web. It is declared `write` for the Web gate and additionally listed
in the MCP denylist, and the `LUOOME_EXPOSE_TRADE=true` startup guard remains in force.

## Never exposed

Real order placement and cancellation are outside the luoome MCP surface. Do not search for a workaround, call a broker directly, reinterpret a write tool as an order, or claim an Advice was executed.

For permission and response requirements, read [safety and errors](./safety.md).
