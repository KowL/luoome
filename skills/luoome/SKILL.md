---
name: luoome
description: Use when the user asks about their luoome portfolio, holdings, trades, PnL, stock quotes, Strategies, Watchlists, AlertPlans, research notes, company events or structured investment advice. Operates through a connected luoome MCP server; provides advice and analysis but never places trades.
---

# luoome

Use the connected luoome MCP server to query and maintain the user's local investment workspace. The Skill defines when and how to use luoome; MCP provides the typed tools and permission boundary.

This Skill targets the local single-user workspace with multiple accounts. Account creation and profile editing are available through the local Web/CLI. Use MCP discovery for callable capabilities.

## Before calling tools

1. Confirm that luoome MCP tools are available. If not, stop and direct the user to [MCP setup](./references/mcp-setup.md); do not silently fall back to shell or another data source.
2. Identify the user's account, stock, holding, Strategy, Watchlist, AlertPlan, event or advice subject before requesting details.
3. Use the MCP tool description and input schema as the parameter source of truth. Do not guess IDs or fields.
4. Read current state before proposing a mutation.

## Operating procedure

- Use **read** tools freely for scoped queries; prefer filters, limits and batch operations over full-table reads or loops.
- Use **advice** tools only when the user asks for analysis or recommendations. Preserve uncertainty and all safety fields in the response.
- Before a **write** or **external** call, restate the exact action and obtain explicit user confirmation unless the current message already unambiguously authorizes that exact action.
- Treat an MCP call as successful only when it returns a normal result without `isError: true`; parse its text content as the returned data. MCP failures carry `isError: true` and serialized error details. Re-read important state after a successful write.
- Never place, cancel or simulate a real order. luoome's MCP surface intentionally excludes trade execution.

See [tool selection](./references/tools.md), [example workflows](./references/examples.md) and [safety and errors](./references/safety.md).

## Response rules

- Resolve an account with the user when it is ambiguous, then use `get_account_overview` with its account ID. Direct account editing belongs to the local Web/CLI.
- Separate observed data, system-calculated values and generated advice.
- For Advice, report `decision`, `confidence`, `horizon`, premise, supporting evidence, counter-evidence, risks, disclaimers and `validUntil` when present.
- Do not convert confidence into certainty or present luoome as a licensed investment adviser.
- Keep tool errors visible and actionable; do not fabricate fallback values.

For user-facing luoome operation details, see the [user guide](../../docs/USER_GUIDE.md). For domain terminology, see [CONTEXT.md](../../CONTEXT.md).

### 本地数据与提供者开关

`compute_indicators` 只读本地日线；没有日线时返回空指标和 `barsCount: 0`，先由用户授权采集后再计算。
提供者和采集任务由用户在 Web「设置 → 插件」或宿主 CLI 的 `plugins status/init/migrate/set` 管理；source 与 task 分别显式启用，且实际调用仍需 write/external 授权。
普通 Agent 不修改配置或偷偷启源。所有提供者关闭后仍可查询本地账户、历史与指标；混合工具返回明确的缺失或本地回退。
MCP 发现按当前就绪来源变化；收到 tools/list_changed 后重新发现工具，旧工具名不能绕过运行校验。
Web 的影响预览不会自动开启依赖；配置提交、当前宿主就绪与排空是不同状态。Agent 不通过工具修改插件配置。

### 策略执行控制

新策略运行/试跑/回测由宿主的 `business.strategy-execution` 显式启用，自动调度另需 `task.strategy-schedules`；新增项默认关闭。
`run_strategy` 按模式和规则引用选择资料：仅本地资料的 scheduled/replay 不依赖 live quote/bars；缺失 ladder/归档保留原 unavailable 与 acceptance 语义。
停用后重新发现工具；旧草案或旧工具名不能恢复执行。历史读取、取消和已有回执查询继续可用，失败/未知结果不自动重放。
插件启用不改变 write/external 授权、场景白名单或人工确认。其它通知等业务独立开关仍在后续切片。


### 个股分析控制

用户须在 Web「设置 → 插件」或 CLI 显式启用 `business.analysis`；旧配置先补齐新增项，新项默认关闭。
开关覆盖 analyze_stock 的全部 scope、analyze_position 及内部市场/候选分析入口。停用后重新发现工具，
旧 callable 或旧草案确认不能生成新 Advice；关后重开也不恢复旧执行。历史 get_advice 和复盘查询继续可用。
分析开关独立于策略执行、策略 AI 洞察和聊天；开启不会自动启源、扩充场景或跳过确认。模型已发送时可能仍在排空，不自动重放失败调用。


### 盯盘监控控制

Web「设置 → 插件 → 盯盘监控」或宿主 CLI 显式管理 business.watch-monitoring，新项默认关闭。
它控制 AlertPlan/TradingPlan 的新求值、触发和盯盘通知及 Web 定时器；列表/计划编辑、历史触发与反馈仍可用。
停用后旧 Workflow、内部工具和旧 timer 不可绕过，关后重开不恢复旧许可。不要把历史触发当作当前行动授权。
已发出的通知可能仍在收尾，页面排空不代表未送达；核对原始触发和通知回执，避免自行重放。
其它报告与通用通知独立授权，启用不会启源或扩充场景。Agent 不修改插件配置。
