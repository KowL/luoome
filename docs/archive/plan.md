# luoome v0.1 实施计划（TUI + WEB）

> 依据 ARCHITECTURE.md / AGENTS.md（仓库根）/ SECURITY.md / ROADMAP.md / MVP-TASK.md。
> 用户要求：v0.1 范围 + 额外包含最小 Web 端（原 ROADMAP v0.4 的内容以 MVP 形态提前：Hono HTTP API + 同源静态仪表盘，不做完整 SPA 框架）。

## 环境

- Bun 1.3.11 已安装在 `~/.bun/bin/bun`（所有 agent 需 `export PATH="$HOME/.bun/bin:$PATH"`）。
- 所有 agent 在 `/Users/lijun/project/luoome` 下工作，禁止 import ruo-cli。

## 跨包契约（所有 agent 必须遵守，避免并行漂移）

- `@luoome/core`：branded types（`Money/Quantity/Percentage/StockCode` + `money()/quantity()/percentage()/stockCode()` + `addMoney/subMoney/mulMoneyRate`）、`Result<T,E>`/`Ok/Err`、`InvariantError`、`ToolError`（kind: invalid_input/not_found/invariant_violation/adapter_error/permission_denied/llm_error/internal）、`SideEffect = 'read'|'write'|'external'|'advice'|'trade'`、实体（`Account/Stock/Holding/Trade/Quote/DailyBar/Advice/AdviceReasoning/AdviceDataSnapshot/AdviceOutcome/AdviceStats`）、枚举类型（`AdviceDecision/AdviceSubjectKind/AdviceHorizon`）、`STANDARD_DISCLAIMERS`（3 条，见 MVP-TASK §2.3）、不变量断言（`assertHoldingInvariants/assertTradeInvariants/assertAdviceInvariants` 等）、repository 接口（`AccountRepository/StockRepository/HoldingRepository/TradeRepository/AdviceRepository` + `RepositoryRegistry`）、`ToolContext`（repos/adapters/user{ id, defaultAccountId }/clock/logger）。
- `@luoome/adapters`：`MarketDataAdapter`（fetchQuote/batchQuote/fetchDailyBars）、`LLMAdapter`（generate）、`MockMarketAdapter`、`MockLLMAdapter`、fixtures（`MOCK_STOCKS/MOCK_ACCOUNT/MOCK_HOLDINGS/mockAdviceFor(stockId)`）。`Quote/DailyBar` 类型来自 core。
- `@luoome/db`：Drizzle schema + `createDrizzleRepos(dbPath)` + `createInMemoryRepos(seed?)` + `seedMockData(repos)`。
- `@luoome/tools`：`defineTool`、`toolRegistry`（`all()/get(name)/toMCP()/toOpenAI()/toTypeScript()`）、`Tool` 类型（`execute(input) → Promise<ToolResult>`）、`buildMockContext()`、8 个 tool：`list_accounts, get_account, list_holdings, get_holding, get_advice, get_advice_stats`（read）+ `analyze_stock, analyze_position`（advice）。
- `@luoome/mcp`：`startMcpServer()`，stdio，env 控制暴露面，`LUOOME_EXPOSE_TRADE=true` 必须启动失败。
- `@luoome/cli`：`bin/luoome`，子命令 `tools list/inspect/call`、`advice list/stats`、`mcp serve`、`tui`、`web serve`、`--version/--help`。
- `@luoome/tui`：opentui app，布局按 MVP-TASK §2.7。
- `@luoome/workflows`：`dailyAdviceWorkflow` 骨架（mock）。
- `apps/web`：Hono server，端口 5173，`GET /` 仪表盘（持仓表 + 建议卡 + 顶部免责声明 + 刷新按钮）、`GET /api/holdings`、`GET /api/advice`、`GET /api/advice/stats`、`POST /api/tools/:name/call`（仅暴露 read+advice）。无构建步骤的原生 HTML/JS。

## 波次划分

| 波次 | Agent | 负责目录（唯一写权限） | 依赖 |
|---|---|---|---|
| W1a | Foundation | 根配置 + 所有 package.json/tsconfig/bin | 无 |
| W1b | Core | `packages/core/src/**` | 无（只依赖 zod） |
| W2a | DB | `packages/db/src/**` | core |
| W2b | Adapters | `packages/adapters/src/**` | core |
| W3 | Tools | `packages/tools/src/**` | core+db+adapters |
| W4a | MCP | `packages/mcp/src/**` | tools |
| W4b | CLI | `packages/cli/src/**` | tools（mcp/tui 懒加载） |
| W4c | TUI | `packages/tui/src/**` | tools |
| W4d | Web | `apps/web/**`（除 package.json/tsconfig） | tools |
| W4e | Workflows | `packages/workflows/src/**` | tools |
| W5 | Integration | 全部（修复 + 验收 + git 提交） | 全部 |

## 规则

- 并行 agent 不写同一文件；除 W5 外禁止 git commit（W1a 负责 git init + 骨架首次 commit）。
- 每个 tool ≥1 个 vitest 单测；core 不变量测试全覆盖；MCP smoke test。
- Tool 永不抛异常，永远返回 `ToolResult`；advice 必含 3 条 STANDARD_DISCLAIMERS。
- TypeScript strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`。
- Biome lint/format；commit 用 conventional commits（W5 统一补）。

## 验收（W5 执行）

`bun install` / `bun test` / `bun run typecheck` / `bun run lint` 全绿；`./bin/luoome tools list` 8 个 tool；`mcp serve` 外部 client 可 list+call；`LUOOME_EXPOSE_TRADE=true` 启动失败；`tui` 显示 mock 持仓+建议+免责声明；`web serve` 后 `localhost:5173` 仪表盘可见。
