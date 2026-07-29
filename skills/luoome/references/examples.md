# Example workflows

These are sequencing patterns, not fixed schemas. Always use the connected MCP descriptions for current parameters.

## Portfolio PnL

User asks for current portfolio profit and loss:

1. Resolve the intended account with `list_accounts` if it is ambiguous.
2. Call `list_holdings` with the account scope; use its current valuation and PnL fields.
3. If the user explicitly requests refreshed quotes, explain the external call and confirm before using quote-refresh/batch capabilities.
4. Report valuation time, per-position results when useful, and the account total without inventing missing prices.

## Record a trade

User gives a stock, side, quantity, price and execution time:

1. Use `search_stocks` to resolve the exact stock; ask the user to choose if multiple candidates remain.
2. Resolve the account and inspect current holding state.
3. Restate account, stock, side, quantity, price, fee and time; obtain explicit confirmation.
4. Invoke `add_trade` using its discovered schema.
5. Re-read the holding/trade record and report the persisted result.

## Run a Strategy sample

1. Use `list_strategies` or `get_strategy` to identify a published Strategy and exact version.
2. For an automatic sample, invoke `run_strategy` with explicit `stockIds` and `persist=false`.
3. A persisted or full-market run requires an explicit confirmation.
4. Explain that StrategyResult and StrategySignal are evidence, not an order or guaranteed outcome.

## Analyze a stock

1. Resolve the stock with `search_stocks`.
2. Invoke `analyze_stock` once with the evidence options supported by its schema.
3. Present premise, evidence and counter-evidence together.
4. Include confidence, horizon, risks, disclaimers and expiry; do not turn `buy` into an execution instruction.

## Analyze current holdings

1. Call `list_holdings` for the selected account.
2. Narrow the target set with the user instead of blindly analyzing every position.
3. Call `analyze_position` for each explicitly selected holding, using bounded concurrency if multiple calls are necessary.
4. Sort or summarize only after preserving each Advice's risks and uncertainty.

## Review advice quality

1. Use advice history/statistics and confidence-calibration tools for the requested period.
2. Distinguish generated Advice, user follow-through and observed outcome.
3. State sample size and missing outcomes; do not claim accuracy from incomplete records.
4. If the user explicitly supplies an outcome to record, confirm the exact mutation before using the corresponding write tool.

## Research notes and company events

1. Resolve the stock first.
2. Read existing research notes or scheduled events with bounded date/status filters.
3. When adding or revising a thesis/event, show the exact content and date before a write call.
4. Preserve source/provenance and do not silently rewrite externally sourced event dates.

## Workflows

Built-in workflows are not general MCP tools. Use `list_workflow_runs` to inspect available audit data, but do not claim to have started a workflow through MCP unless a discovered tool explicitly provides that operation.
