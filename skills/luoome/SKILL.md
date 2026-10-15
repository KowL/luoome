---
name: luoome
description: Use when the user asks about their luoome portfolio, holdings, trades, PnL, stock quotes, Strategies, Watchlists, AlertPlans, research notes, company events or structured investment advice. Operates through a connected luoome MCP server; provides advice and analysis but never places trades.
---

# luoome

Use the connected luoome MCP server to query and maintain the user's local investment workspace. The Skill defines when and how to use luoome; MCP provides the typed tools and permission boundary.

This Skill targets local mode. Hosted platform identity, subscriptions, jobs, payments, notifications, privacy
and recovery tools use a private server/worker registry and are not exposed through MCP or model discovery.
Email verification, password login and password changes are private Web identity operations; never request
the user's login password or email verification code through MCP, or invoke these via generic tools.
Do not attempt to reach them through generic calls or shell fallback. Hosted personal facts and feedback use
the authenticated Web product; its production providers and release gates are separate from local MCP setup.

## Before calling tools

1. Confirm that luoome MCP tools are available. If not, stop and direct the user to [MCP setup](./references/mcp-setup.md); do not silently fall back to shell or another data source.
2. Identify the user's account, stock, holding, Strategy, Watchlist, AlertPlan, event or advice subject before requesting details.
3. Use the MCP tool description and input schema as the parameter source of truth. Do not guess IDs or fields.
4. Read current state before proposing a mutation.

## Operating procedure

- Use **read** tools freely for scoped queries; prefer filters, limits and batch operations over full-table reads or loops.
- Use **advice** tools only when the user asks for analysis or recommendations. Preserve uncertainty and all safety fields in the response.
- Before a **write** or **external** call, restate the exact action and obtain explicit user confirmation unless the current message already unambiguously authorizes that exact action.
- Never claim that a mutation succeeded until the tool returns `ok: true`; re-read important state after a successful write.
- Never place, cancel or simulate a real order. luoome's MCP surface intentionally excludes trade execution.

See [tool selection](./references/tools.md), [example workflows](./references/examples.md) and [safety and errors](./references/safety.md).

## Response rules

- Account profile editing uses the write tool `update_account` for the name only; it does not change opening capital, currency or cash. Hosted mode supplies one default account and disallows creating additional accounts.
- Separate observed data, system-calculated values and generated advice.
- For Advice, report `decision`, `confidence`, `horizon`, premise, supporting evidence, counter-evidence, risks, disclaimers and `validUntil` when present.
- Do not convert confidence into certainty or present luoome as a licensed investment adviser.
- Keep tool errors visible and actionable; do not fabricate fallback values.

For user-facing luoome operation details, see the [user guide](../../docs/USER_GUIDE.md). For domain terminology, see [CONTEXT.md](../../CONTEXT.md).
