# Example workflows

These patterns use MCP tools/call payloads. Replace illustrative IDs with IDs from the user's workspace. Before calling, inspect current discovery: permissions and configured dependencies may hide a tool. Never substitute a shell call for a hidden tool.

## Portfolio PnL

Resolve the account with the user if ambiguous. Use `get_account_overview` for account, holdings and facts together:

```json
{"name":"get_account_overview","arguments":{"accountId":"account-id"}}
```

Report valuation time, missing prices and the account total. For an explicitly authorized refresh, use discovered `fetch_quote` with the selected stock IDs, then read the overview again.

## Record a completed trade

Direct the user to the local Web/CLI to record a completed trade. MCP does not expose this mutation. Once recorded, inspect its local history:

```json
{"name":"list_trades","arguments":{"accountId":"account-id","limit":20}}
```

A history record does not mean luoome placed an order.

## Run a Strategy sample

Use `list_strategies` or `get_strategy` to resolve a published Strategy and version. A trial still requires the appropriate write/external permissions and authorization; run an explicit stock subset without persisting:

```json
{"name":"run_strategy","arguments":{"strategyId":"strategy-id","stockIds":["600000.SH"],"persist":false}}
```

For an explicitly authorized formal run:

```json
{"name":"run_strategy","arguments":{"strategyId":"strategy-id","persist":true}}
```

Report publication and data health from the returned run. StrategySignals are evidence, not Advice or orders.

## Analyze a stock or holding

Resolve stocks with `search_stocks`, then invoke `analyze_stock` for the requested analysis:

```json
{"name":"analyze_stock","arguments":{"stockId":"600000.SH"}}
```

For holdings, first use `get_account_overview`, narrow the target with the user, and use the returned holding ID:

```json
{"name":"analyze_position","arguments":{"holdingId":"holding-id"}}
```

Preserve premise, evidence, counter-evidence, confidence, horizon, risks, disclaimers and expiry. Missing model or market dependencies can hide these tools.

## Review advice quality

Use `get_advice` to read persisted advice and optional decision reviews for the selected account:

```json
{"name":"get_advice","arguments":{"accountId":"account-id","includeDecisionReviews":true,"includeExpired":true,"limit":20}}
```

Distinguish generated Advice, user feedback and observed outcomes. State sample size and missing feedback. Dedicated calibration/statistics are available through local Web/CLI; do not invent an MCP statistics tool.

## Research notes

Resolve the stock first and search existing notes with `search_research_documents`. For an authorized write, show the exact title, body and stock codes before calling `save_research_document`:

```json
{"name":"save_research_document","arguments":{"target":"note","note":{"title":"Research notes","kind":"note","body":"User-approved research text","stockCodes":["600000.SH"]}}}
```

The Vault must be configured and research access enabled. Preserve source URLs and publication dates when present.

## Workflows

Built-in workflows and their audit views are available through the local CLI/Web. Only a discovered MCP tool can provide a callable operation; do not claim that an undiscovered workflow was started.
