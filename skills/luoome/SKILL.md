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

`compute_indicators` 只读本地日线；没有日线时返回空指标和 `barsCount: 0`，先由用户授权采集后再计算。样本不足的指标不出现在 `indicators` 中，`indicatorAvailability` 会给出各指标的 `requiredCount` / `actualCount` 与原因，不要把缺失指标当成信号。
提供者和采集任务由用户手写 `$LUOOME_HOME/plugins.json` 启停（重启宿主生效，缺省关闭）；source 与 task 分别启用，实际调用仍需 write/external 授权。
普通 Agent 不修改配置或偷偷启源。所有提供者关闭后仍可查询本地账户、历史与指标；混合工具返回明确的缺失或本地回退。
MCP 发现按当前就绪来源变化；收到 tools/list_changed 后重新发现工具，旧工具名不能绕过运行校验。
Agent 不通过工具修改插件配置，也没有可用的配置写入接口。

### 策略执行控制

策略建议先读 `get_strategy_dsl_catalog`，并在给出 DSL 片段前用 `validate_strategy_definition` 校验；未通过校验的片段不能声称可直接写入。

新策略运行/试跑/回测由宿主的 `business.strategy-execution` 显式启用；每日判断按需运行少量 active 策略取当日信号，不再有独立调度 timer。
`run_strategy` 按模式和规则引用选择资料：仅本地资料的 scheduled/replay 不依赖 live quote/bars；缺失 ladder/归档保留原 unavailable 与 acceptance 语义。
停用后重新发现工具；旧草案或旧工具名不能恢复执行。历史读取、取消和已有回执查询继续可用，失败/未知结果不自动重放。
插件启用不改变 write/external 授权、场景白名单或人工确认。通知投递也由独立插件控制，其它任务资源按后续切片迁移。


### 个股分析控制

用户须在 `$LUOOME_HOME/plugins.json` 中把 `business.analysis` 设为启用（缺省关闭，重启生效）。
开关覆盖 analyze_stock 的全部 scope、analyze_position 及内部市场/候选分析入口。停用后重新发现工具，
旧 callable 或旧草案确认不能生成新 Advice；关后重开也不恢复旧执行。历史 get_advice 和复盘查询继续可用。
分析开关独立于策略执行、策略 AI 洞察和聊天；开启不会自动启源、扩充场景或跳过确认。模型已发送时可能仍在排空，不自动重放失败调用。


### 账户绩效估值任务

宿主显式启用 `task.snapshot-account-performance` 后才能运行批量 `snapshot-account-performance` Workflow；新增项默认关闭，仍需 write + external。
停用后旧任务、旧 tick 与任务工具不得继续执行；Agent 不替用户启用插件或重试旧 scope。
历史快照与审计仍可读；共享 `get_account_performance` 的按需计算/缓存保持可用，不受自动任务开关影响。

### 通知控制

宿主显式管理 `business.notification`，新增项默认关闭；Agent 不修改配置或替用户启用。
停用后不得发送或通过 log 降级绕过，飞书连接测试也受控；旧调用在重新启用后仍失效。
报告生成、策略事实、盯盘触发和历史回执独立保留。启用不扩大 external 或场景权限，也不重放成功通知。
已发出的通知只能记录真实回执，不能声称已经撤回。

### 报告控制

宿主通过 Web 插件页或 CLI 显式管理 `business.report`，新增项默认关闭。
停用后不得生成、保存或重投报告；历史 get/list/render 仍可用，策略日循环和盯盘独立。
已有工具和关→开前的调用不能绕过门禁。已发出的通知仅记录原尝试的实际回执。
启用不扩大 write/external 或场景白名单；Agent 不修改配置，也不替用户启用插件。

### 盯盘监控控制

`business.watch-monitoring` 由用户手写 `$LUOOME_HOME/plugins.json` 启停，缺省关闭。
它控制 AlertPlan/TradingPlan 的新求值、触发和盯盘通知及 Web 定时器；列表/计划编辑、历史触发与反馈仍可用。
停用后旧 Workflow、内部工具和旧 timer 不可绕过，关后重开不恢复旧许可。不要把历史触发当作当前行动授权。
已发出的通知可能仍在收尾，页面排空不代表未送达；核对原始触发和通知回执，避免自行重放。
其它报告与通用通知独立授权，启用不会启源或扩充场景。Agent 不修改插件配置。
