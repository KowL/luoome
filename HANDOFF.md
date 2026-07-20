# Handoff — luoome v0.4.0

> 这份文档给**接手的工程师 / agent**：把项目当前状态、关键决策、不变量、已知坑讲清楚，让你能**在一两天内上手改东西**。
>
> 它不是 ARCHITECTURE.md 的替代——架构看 [ARCHITECTURE.md](./ARCHITECTURE.md)；这不是 README——怎么接入看 [AGENTS.md](./AGENTS.md)；这不是路线图——下一步计划看 [ROADMAP.md](./ROADMAP.md)。

---

## 1. 现状快照（v0.4.0）

| 维度 | 状态 |
|---|---|
| 已发布版本 | v0.4.0（https://github.com/KowL/luoome/releases/tag/v0.4.0） |
| 最新 commit | `c03f1a6`（chore(repo): LICENSE + CI + version 0.4.0） |
| 测试 | 484 pass（vitest 377 + bun test db 107）/ 53 文件 |
| Tool 数 | 22（read 14 / advice 3 / external 4 / write 1） |
| Workflow 数 | 5（sync-quotes / daily-advice / tactic-scan / risk-report / daily-review） |
| 战法数 | 5 builtin（放量突破 / 均线多头 / 涨停回踩 / 量价背离 / 板块共振） |
| 数据源 | 行情经 `LUOOME_MARKET_PROVIDER` 路由——mock（默认，确定性）/ real（Eastmoney 主 → Tencent 备 → Mock 兜底，A 股）；OpenAI-Compatible / Anthropic / Mock LLM；飞书 Webhook |
| Surfaces | CLI / TUI / Web（7 路由） / MCP stdio |
| CI | GitHub Actions · ubuntu + bun 1.3.11 · typecheck + test:all + lint 三关 |
| License | MIT |

**v0.1 → v0.4 都已完成**，v0.5（多市场 + 体验打磨）待启动。

## 2. 5 分钟读懂项目

### 它是什么

**本地优先的个人投资管理 advisor agent**。把多源行情、财报、战法信号罗进来，织成结构化、可追溯、带理由的投资建议。**不替你下单**——advice 永远需要人确认。

### 设计主线

```txt
罗（采集） ──► 织（分析） ──► 建议 ──► 复盘
  行情         指标          decision    outcome
  财报         战法          信心度      命中率
  战法         LLM 推理      周期        hit rate
```

### 三条铁律（绝对不能破）

1. **Tool 永不抛异常** —— 永远返回 `ToolResult<T> = { ok: true, data } | { ok: false, error }`。
2. **advice ≠ trade** —— advice 类 tool 永不直接触发 trade。LLM 推完 buy/sell 后，agent 拿到建议后必须**重新询问用户**，不能自动 follow。
3. **`LUOOME_EXPOSE_TRADE=true` 启动硬卡** —— MCP server 在 env 检测到时直接 throw 退出，不可绕过。

### 包依赖（硬约束）

```txt
cli / tui / mcp / web ──► tools ──► core
                          │
                          └─► { db, adapters } ──► core
workflows ──► tools ──► core
```

`core` 零 IO；任何反向 import 都会被 review 打回。

### 核心实体（`packages/core/src/entity/`）

| 实体 | 关键字段 | 备注 |
|---|---|---|
| `Account` | id, name, currency, initialCapital | 多账户支持（v0.5 UI） |
| `Holding` | accountId, stockId, quantity, availableQuantity, avgCost, openedAt, closedAt? | 同 (accountId, stockId) 不可重复 |
| `Trade` | accountId, stockId, side, quantity, price, fee, executedAt | side: buy / sell |
| `Stock` | id (e.g. '002594.SZ'), code, name, market | market: cn-a / cn-hk（v0.5 加 us） |
| `Advice` | subjectKind, subjectId, decision, confidence, horizon, reasoning, risks, disclaimers, basedOn, validUntil, outcome? | **核心**——每次分析 / 扫描 / 战法的产物 |
| `Tactic` | id, name, tag, triggerWhen (DSL), scoreExpression (DSL), evidenceTemplate | DSL 是 `${...}` 表达式 |
| `TacticSignal` | tacticId, stockId, score, direction, evidence, triggerSnapshot | 战法命中产出 |
| `Notification` | channel, kind, target, payload, result | 飞书 / 日志 等 |

### 数据流（典型场景："给比亚迪出个建议"）

```txt
User  ─►  MCP / CLI / TUI / Web
            │
            ▼
       analyze_stock tool          ← read + advice
            │
            ├─► ctx.tools.compute_indicators  (拉日线 → 算 13 项技术指标)
            ├─► ctx.adapters.market.fetchQuote (Eastmoney / Tencent)
            ├─► ctx.adapters.llm.analyze      (OpenAI-Compatible / Anthropic / Mock)
            └─► ctx.repos.advice.save         (写 SQLite)
            │
            ▼
       Advice { decision, confidence, reasoning, ... }
            │
            ▼
       渲染（disclaimers + counter-evidence + risks 一并显示）
```

## 3. 关键文件 / 在哪里找

| 我想看 / 改 | 路径 |
|---|---|
| 实体类型 + 不变量 | `packages/core/src/entity/` |
| branded types | `packages/core/src/types/branded.ts` |
| Tool 注册表 | `packages/tools/src/registry.ts` |
| 加新 tool 的样板 | `packages/tools/src/tools/search-stocks.ts` |
| Tool schema → TS / MCP / OpenAI 推导 | `packages/tools/src/define-tool.ts` |
| 战法 DSL 引擎 | `packages/core/src/tactic/` |
| 内置战法 | `packages/adapters/src/mocks/tactics.ts` |
| 行情适配 | `packages/adapters/src/market/` |
| LLM 适配 + fallback | `packages/adapters/src/llm/` |
| 飞书 webhook | `packages/adapters/src/notification/` |
| Workflow 引擎 | `packages/workflows/src/define-workflow.ts` |
| 内置 workflow | `packages/workflows/src/{sync-quotes,daily-advice,tactic-scan,risk-report,daily-review}.ts` |
| MCP server 暴露面 | `packages/mcp/src/server.ts` |
| CLI argv 解析 | `packages/cli/src/index.ts` |
| TUI 布局 | `packages/tui/src/app.ts` |
| Web 路由 + API | `apps/web/src/server.ts` |
| Web 前端模块 | `apps/web/public/js/{api,ui,pages,app}.js` |
| Web 设计 tokens + 组件 | `apps/web/public/style.css` |
| DB schema (Drizzle) | `packages/db/src/schema/` |
| Repo 合约测试 | `packages/db/src/repository/contract-tests.ts` |

## 4. 日常开发流

```bash
# 拉代码
git clone git@github.com:KowL/luoome.git
cd luoome
bun install --frozen-lockfile

# 跑测试（CI 三关）
bun run typecheck
bun run test:all
bun run lint

# TUI smoke
bun packages/tui/src/smoke.ts

# 起一个 surface
bash bin/luoome tui                          # 终端
bash bin/luoome web serve --port 5173        # Web
LUOOME_EXPOSE_WRITE=true bash bin/luoome web serve  # Web + outcome 回填

# 接 MCP（Claude Desktop 配置 ~/.config/claude_desktop_config.json）
{
  "mcpServers": {
    "luoome": {
      "command": "luoome",
      "args": ["mcp", "serve"],
      "env": { "LUOOME_HOME": "/Users/you/.luoome" }
    }
  }
}
```

## 5. 关键决策与原因（避免重新讨论）

| 决策 | 原因 |
|---|---|
| Bun workspace monorepo（非 pnpm / turborepo） | bun 原生支持 workspace，无 node_modules 嵌套；bun run 直接跑 TS 无构建 |
| Drizzle ORM + 双实现（drizzle + in-memory） | 双实现让合约测试一遍跑两套，行为一致；in-memory 让单测 10x 快 |
| Schema-driven tool（Zod） | TS 类型 + MCP tool 定义 + OpenAI function calling schema 一份 zod 同时出 |
| Vanilla JS + Hono（Web） | 引入 Solid/Tailwind 会显著增加构建复杂度，与现有"零构建"风格不符 |
| OpenAI-Compatible 一个适配器覆盖 5 家 | DeepSeek / Kimi / Moonshot / Zhipu / OpenAI 都是 OpenAI 协议，分开写冗余 |
| 飞书 Webhook（v0.3）+ 企微 / Slack（v0.4+） | 飞书最常见；其他渠道等用户反馈再加 |
| `place_order` 永不暴露 | 合规 + 资金风险；agent 永远只能 advice，永远不能 trade |
| 5s 仪表盘自动刷新 + 手动按 r | 用户盯盘体验；setInterval 由 renderer.destroy 清掉 |
| advice 有 6 条不变量 | 强制 disclaimers + validUntil 让 AI 建议始终是"建议"而非"指令" |
| 战法 DSL 自实现 mini-eval | 引第三方表达式库（jsep / expr-eval）增加包大小；只支持 13 个变量 + 简单 bool / 比较 / Math.* 完全够用 |
| outcome 回填走 write tool | 复盘是用户主动行为；写权限 opt-in 防止 agent 误调 |
| AGENTS.md / ARCHITECTURE.md 分两份 | ARCHITECTURE 给工程师；AGENTS 给外部 agent harness。两份不能合并（受众不同） |

## 6. 已知坑 / 看起来怪但故意的

### 6.1 数据库路径

```bash
LUOOME_HOME    # 数据目录，默认 ~/.luoome
                #   ~/.luoome/luoome.db  ← SQLite 主库
                #   ~/.luoome/tactics/   ← 用户自定义战法（v0.3 留口，尚未实现 loader）
```

**坑**：mock 适配器在 web 端首次启动会重灌 fixtures（`seedMockData` upsert 幂等）；真实 LLM/行情接入后才会写真实数据。

### 6.2 Advice 的 `basedOn.dataAsOf`

mock 适配器把 `dataAsOf` 钉在 `DEFAULT_MOCK_NOW`（2026-07-19）；真实数据源是 `ctx.clock()`。两者混用时 `validUntil` 可能已过期而 advice 看着"新鲜"。

**建议**：mock 数据用 `Math.max(DEFAULT_MOCK_NOW.getTime(), Date.now())` 当 clock，保证 mock 在真实时间窗口内有效（web 端 seed 时就这么做的）。

**已落地（v0.5 接线时）**：`buildMockContext` 现在拆两个时钟——业务 `ctx.clock` = max(锚点, 真实时间)，行情 adapter 时钟钉住锚点（报价 / 日线 / 指标保持确定性）。这修掉了一类时间炸弹：repo 层按 `Date.now()` 过滤过期 advice，锚点钉在过去会让 analyze_* 的新鲜产出在真实时间越过 validUntil 后立刻不可见（`analyze-position` 测试在 2026-07-20 越界当天变红）。`opts.clock` 显式传入时两个时钟一并钉住（指标数值断言类测试用）。

### 6.3 Workflow 引擎的 unwrap 语义

```ts
// 引擎伪代码：
let current = parsedInput;
for (const step of steps) {
  const value = await step(current, ctx);
  // 如果返回 ToolResult，自动解包 data
  current = isToolOkResult(value) ? value.data : value;
}
```

**坑**：第一个 step 返回 ToolResult 后，下一个 step 拿到的 prev 是 `data`，**不是** `ToolResult`。`risk-report` workflow v0.3 早期就栽在这——`stepCompute` 把 data 当 ToolResult 处理。**记住**：除了引擎入口 / 错误短路，step 之间传的是 unwrap 后的数据。

### 6.4 CLI `--pnl` 等带值 flag

CLI argv 解析器（`packages/cli/src/index.ts`）有 `VALUE_FLAGS` 白名单；不在白名单里的 `--foo bar` 会把 `bar` 当位置参数。**新加带值 flag 必须加进白名单**：

```ts
const VALUE_FLAGS = new Set([
  'input', 'since', 'until', 'port', 'limit',
  'pnl', 'holding-hours', 'notes',
  'tactic', 'by', 'tactic-id', 'scope',
  // 新加的在这里
]);
```

### 6.5 LLM fallback

LLM 调用失败的处理（plan-v0.2-v0.3 §2.3）：

1. schema parse 失败 → 自动重试一次
2. 仍失败 → `fallbackAdvice()` 规则兜底（MA5 > MA20 → watch / confidence 30，其他 → hold / confidence 20）
3. 永远不让 tool 抛异常

要测试 fallback：mock LLM adapter 返回 invalid JSON；验证 advice 仍有合理输出，且 evidence 包含"LLM 推理失败，使用规则 fallback"。

### 6.6 战法 DSL 的 `${meta.*}`

DSL 引擎支持 `${indicators.X}` 和 `${meta.X}`。`meta` 是动态注入的元数据（如 `daysSinceLimitUp`、`recentLimitUp`），**不是所有战法都能用所有 meta key**。改战法前先看 `packages/tools/src/tools/run-tactic.ts` 注入哪些 meta。

### 6.7 CI 不跑 TUI smoke

TUI smoke 需要 `@opentui/core/testing` + Bun 完整环境，CI 上跑会有兼容问题。**本地 `bun packages/tui/src/smoke.ts` 必须 6 项全过再 push**。

## 7. 紧急操作手册

### 7.1 重新灌 mock fixtures

```bash
rm -rf ~/.luoome/luoome.db
bash bin/luoome tui          # 启动时会自动 seed
```

### 7.2 加新 env 变量

1. 在 `packages/core/src/context.ts`（或对应配置模块）的 env 解析里加
2. 在 `README.md` 环境变量表里登记
3. 在 `ARCHITECTURE §12` 配置章节登记
4. 测试时记得加 fallback（env 缺失时降级）

### 7.3 advice 输出错了

```bash
# 1) 看具体 advice
bash bin/luoome advice list --since 7d

# 2) 看 stats
bash bin/luoome advice stats --since 30d

# 3) 看底层 raw output
bash bin/luoome tools call analyze_stock --input '{"stockId":"002594.SZ"}'

# 4) 回填 outcome
bash bin/luoome advice outcome <adviceId> --followed true --pnl 500
```

### 7.4 战法跑不出信号

```bash
# 1) 列战法
bash bin/luoome tools call list_tactics --input '{}'

# 2) 单跑一个战法
bash bin/luoome tools call run_tactic --input '{"tacticId":"breakout-volume","scope":"holdings"}'

# 3) 看 raw signals
bash bin/luoome tools call tactic_signals_by_tactic --input '{"tacticId":"breakout-volume","since":"-7d"}'
```

如果 `evaluatedStocks > 0` 但 `signals = []`，是 DSL 表达式太严；如果 `evaluatedStocks = 0`，是 scope / stockIds 配置问题。

### 7.5 MCP server 起不来

```bash
LUOOME_LOG=debug bash bin/luoome mcp serve 2>&1 | head -50
```

常见原因：

- `LUOOME_EXPOSE_TRADE=true`（启动硬卡）
- `LUOOME_HOME` 路径无权限
- port / pipe 被占（MCP stdio 用 stdin/stdout）

## 8. 下一步（v0.5 候选）

按优先级：

1. ~~多市场数据源~~ → **A 股真实行情接线（已完成）**：四个 surface 统一走 `createMarketAdapterFromEnv`，`LUOOME_MARKET_PROVIDER=real` 启用 Eastmoney 主 → Tencent 备 → Mock 兜底；默认 mock 零回归。港 / 美市场确认不做（lijun，2026-07-20）。同类遗留缺口：真实 LLM（LLMManager + `LUOOME_LLM_PROVIDER`）也未接线，建议作为下一刀。
2. **多账户切换 UI**（侧栏加账户选择器）
3. **confidence 自校准**（基于 outcome hit rate 反向回归 + 大盘 beta 调整）
4. **Web push 通知**（高信心建议推送到浏览器）
5. **CI 加 TUI smoke**（GitHub Actions 上跑）
6. **ESLint-style import 检查**（防反向依赖）
7. **用户自定义战法 loader**（`~/.luoome/tactics/*.yml`）
8. **企微 / Slack 通知**

具体计划开 issue 讨论，不要直接开 PR（涉及大块架构调整）。

## 9. 致接手的人

luoome 不是一个"平台"，是**个人真能用的 advisor agent**。

如果你的改动让它**更贴近这个目标**——更可信的建议、更清楚的复盘、更友好的体验——那就是好的方向。

如果你的改动让它**更像一个跟单 / 交易 / 社交平台**——大概率是走偏了。先开 issue 讨论。

愿你在织网的过程中，享受把噪音织成信号的乐趣。

— lijun, 2026-07-20
