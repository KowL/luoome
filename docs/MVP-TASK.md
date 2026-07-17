# MVP Task Spec — luoome v0.1

> 给执行 agent 的任务说明书。**完整读完 ARCHITECTURE.md 后**再按本文交付。
>
> 本文档两份用途：
> 1. **TL;DR 段**（§1）可以直接复制粘贴作为 agent 的 prompt
> 2. **详细规格**（§2-§7）作为 agent 执行时的参考手册

---

## 1. TL;DR — 可直接复制的 Agent Prompt

把下面整段复制下来，发给任何具备 shell + 文件读写 + 编码能力的 agent：

```text
# 任务：从零实现 luoome v0.1（个人投资管理 advisor agent 的骨架 + mock MVP）

## 你必须先读（按顺序）

1. ~/project/luoome/ARCHITECTURE.md        — 架构核心
2. ~/project/luoome/AGENTS.md              — MCP 接入规范
3. ~/project/luoome/SECURITY.md            — 安全约束（副作用 5 级 / advice ≠ trade）
4. ~/project/luoome/ROADMAP.md            — v0.1 验收标准
5. ~/project/luoome/docs/MVP-TASK.md       — 本文件（详细规格）

## 项目位置

- 根目录：~/project/luoome/
- 当前状态：5 份设计文档 + .gitignore 已就位，零代码
- 不许触碰：~/project/ruo-cli/（独立废弃项目，不 import 任何代码）

## 目标

实现 v0.1：monorepo 骨架 + 领域层 + Drizzle + 8 个 tool（6 read + 2 advice）+ MCP stdio server + CLI + opentui TUI。
所有数据 mock，LLM mock，不接任何真实外部服务。

## 技术栈（硬约束）

- Bun + TypeScript strict（noUncheckedIndexedAccess / exactOptionalPropertyTypes）
- SQLite + Drizzle ORM（不许用 Prisma / TypeORM）
- opentui（不许用 Ink / Bubble Tea）
- Zod 4.x（不许用 yup / valibot）
- vitest（测试）
- Biome（lint + format）

## 工作目录布局（强制）

luoome/
  package.json              workspace root
  tsconfig.base.json
  biome.json
  bunfig.toml
  packages/
    core/                   纯类型 + 不变量 + branded types
    db/                     Drizzle + SQLite + in-memory repo
    tools/                  Tool registry + 8 tools + schema 推导
    adapters/               v0.1 只有 mock LLM + mock market
    workflows/              v0.1 只放 1 个 demo workflow（daily-advice 骨架）
    mcp/                    stdio server
    cli/                    luoome 命令入口
    tui/                    opentui app

## 交付（按 phase 顺序，不要跳）

### Phase 1 — Foundation（1-2h）
package.json（workspace root）+ tsconfig.base.json + biome.json + bunfig.toml + 每 package 的 package.json。`bun install` 通过。

### Phase 2 — Core（1-2h）
branded types (Money/Quantity/Percentage) + Result<T,E> + 5 个 entity (Account/Stock/Holding/Trade/Advice) + 6 个 repository interface + 不变量断言。
vitest 单测覆盖所有不变量。

### Phase 3 — DB（2-3h）
Drizzle schema + 初始 migration + 6 个 repository 的 Drizzle 实现 + 6 个 in-memory 实现（用于测试）。
`bun run db:push` 通过。

### Phase 4 — Tools（3-4h）
defineTool + registry + Zod→TS/MCP/OpenAI 推导。
8 个 tool：
  read: list_accounts, get_account, list_holdings, get_holding, get_advice, get_advice_stats
  advice: analyze_stock, analyze_position
每个 tool 一个 vitest 单测。LLM 用 mock fixture 返回固定 Advice。

### Phase 5 — MCP（1-2h）
stdio server，暴露 read + advice。`LUOOME_EXPOSE_TRADE=true` 启动失败。
smoke test：client list tools + call list_holdings + analyze_stock。

### Phase 6 — CLI（1h）
luoome 命令入口，子命令：tools list/inspect/call、advice list/stats、mcp serve、tui。
`./bin/luoome --help` 输出正确。

### Phase 7 — TUI（2-3h）
opentui app，左持仓右建议，r 刷新 q 退出，顶部固定免责声明。

## 硬约束（不可违反）

1. 目录结构严格按 ARCHITECTURE §3，依赖方向按 §3 图
2. 副作用 5 级 read/write/external/advice/trade，每个 tool 显式声明
3. trade 永不暴露（MCP 启动校验硬卡）
4. advice 必含 STANDARD_DISCLAIMERS 三条（不变量）
5. advice tool handler 不许调 trade tool（代码层 assert）
6. TypeScript strict 全开
7. Money/Quantity/Percentage branded types，禁止裸 number
8. Tool 永远返回 Result<T, ToolError>，不抛异常
9. 每个 tool 有 vitest 单测（mock ctx）
10. commit message 用 conventional commits

## 验收（v0.1 完成判定）

- cd ~/project/luoome && bun install 通过
- bun test 全绿
- bun run typecheck 零错
- bun run lint 零错
- ./bin/luoome tui 在终端显示 mock 持仓 + 今日建议 + 顶部免责声明
- ./bin/luoome mcp serve 启动后外部 client 能 list + call
- ./bin/luoome tools list 输出所有 8 个 tool
- ./bin/luoome advice list 显示 mock 建议
- README/ARCHITECTURE/AGENTS 描述的 v0.1 验收项全部通过

## 工作流

- 每 phase 1+ commit，commit 用 conventional commits
- 每个 commit 前跑 bun test
- 不确定就回查 ARCHITECTURE 对应章节
- 遇到下面 Escalation 规则里的情况就停下来问 user，不要硬猜

## Escalation（这些情况停下来问 user，不要硬猜）

1. 文档之间有冲突（ARCHITECTURE 说 A，AGENTS 说 B）→ 问 user
2. 某个 tool 的副作用分级不确定（read 还是 advice？）→ 问 user
3. 发现某个设计决策文档没说 → 问 user，不要自己发明
4. Phase 6/7 的 UI 细节 TUI 命令行格式没定 → 问 user
5. 任何超过 v0.1 scope 的需求 → 明确告诉 user，不擅自扩 scope

## 完成后

- 在 luoome 根目录 git init + 初始 commit
- 把所有交付路径列给 user
- 跑一遍验收清单贴结果
```

---

## 2. 详细规格 — 模块设计要点

### 2.1 Package 依赖图（重申 ARCHITECTURE §3）

```txt
cli ──┐
tui ──┤
mcp ──┼──► tools ──► core
web ──┤        │
      │        ├──► db ──► core
      │        │
      │        └──► adapters ──► core
      │
      └──► workflows ──► tools ──► core
```

每个 package 的 `package.json` 必须正确声明依赖：

| package | 依赖 |
|---|---|
| `core` | 仅 `zod` |
| `db` | `core`, `drizzle-orm`, `better-sqlite3` |
| `adapters` | `core`, `drizzle-orm` (可选) |
| `tools` | `core`, `db`, `adapters`, `zod` |
| `workflows` | `core`, `tools` |
| `mcp` | `core`, `tools`, MCP SDK |
| `cli` | `core`, `tools`, `mcp` (用于 `mcp serve` 子命令) |
| `tui` | `core`, `tools`, `@opentui/core` |

### 2.2 Branded Types 详细规格

```ts
// packages/core/src/types/branded.ts
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type Money = Brand<number, 'Money'>;        // 元，4 位小数
export type Quantity = Brand<number, 'Quantity'>;  // 股，整数
export type Percentage = Brand<number, 'Percentage'>; // 0.0523 = 5.23%
export type StockCode = Brand<string, 'StockCode'>; // '002594', 'AAPL'

// 构造函数（带 invariant）
export const money = (n: number): Money => {
  if (!Number.isFinite(n)) throw new InvariantError('Money must be finite');
  return Math.round(n * 10000) / 10000 as Money;
};

export const quantity = (n: number): Quantity => {
  if (!Number.isInteger(n) || n < 0) throw new InvariantError('Quantity must be non-negative integer');
  return n as Quantity;
};

export const percentage = (n: number): Percentage => {
  if (n < -1 || n > 10) throw new InvariantError('Percentage out of range');
  return n as Percentage;
};

// 加减乘除（Money 必须用这些，禁止直接 + -）
export const addMoney = (a: Money, b: Money): Money => money((a + b) as number);
export const subMoney = (a: Money, b: Money): Money => money((a - b) as number);
export const mulMoneyRate = (a: Money, rate: number): Money => money((a * rate) as number);
```

### 2.3 Advice 不变量（5 条）

```ts
// packages/core/src/entity/invariants.ts
export const assertAdviceInvariants = (a: Advice): void => {
  if (a.confidence < 0 || a.confidence > 100) throw new InvariantError('confidence out of [0,100]');
  if (a.disclaimers.length === 0) throw new InvariantError('disclaimers must not be empty');
  for (const required of STANDARD_DISCLAIMERS) {
    if (!a.disclaimers.includes(required)) throw new InvariantError(`missing disclaimer: ${required}`);
  }
  if (a.validUntil.getTime() <= a.validFrom.getTime()) throw new InvariantError('validUntil must be after validFrom');
  if (a.reasoning.premise.length === 0) throw new InvariantError('reasoning.premise must not be empty');
};

export const STANDARD_DISCLAIMERS = [
  '本建议由 AI 生成，基于历史数据与技术指标，不构成投资建议。',
  '投资有风险，决策需自行承担。',
  '市场有不可预测性，过往表现不代表未来收益。',
] as const;
```

### 2.4 Tool 定义模板

```ts
// packages/tools/src/list-holdings.ts
import { z } from 'zod';
import { defineTool } from './define-tool';

export const ListHoldingsInput = z.object({
  accountId: z.string().uuid().optional(),
  status: z.enum(['active', 'closed', 'all']).default('active'),
});

export const ListHoldingsOutput = z.object({
  holdings: z.array(/* HoldingSchema from core */),
  totalValue: MoneySchema,
  totalCost: MoneySchema,
  totalPnL: MoneySchema,
  totalPnLPct: PercentageSchema,
});

export const listHoldingsTool = defineTool({
  name: 'list_holdings',
  description: '列出指定账户下的当前持仓（含 PnL 汇总）',
  sideEffect: 'read',
  input: ListHoldingsInput,
  output: ListHoldingsOutput,
  handler: async (input, ctx) => {
    const accountId = input.accountId ?? ctx.user.defaultAccountId;
    const holdings = await ctx.repos.holding.listByAccount(accountId);
    const quotes = await ctx.adapters.market.batchQuote(holdings.map(h => h.stockId));
    return aggregate(holdings, quotes);
  },
});
```

### 2.5 Mock 数据 fixtures

`packages/adapters/src/mocks/`：

- `mock-stocks.ts`：10 个 A 股 + 5 个港股 + 5 个美股 fixture（含代码、名称、行业）
- `mock-account.ts`：1 个默认账户 fixture
- `mock-holdings.ts`：5-8 个持仓 fixture（含 mock 成本、数量）
- `mock-llm.ts`：调 `analyze_stock` 时返回固定 Advice fixture（带 disclaimers + validUntil）

mock LLM 不调外部 API，纯返回 fixture。v0.2 才换真实 LLM。

### 2.6 MCP Server 关键代码

```ts
// packages/mcp/src/server.ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const FORBIDDEN_TRADE_EXPOSURE = process.env.LUOOME_EXPOSE_TRADE === 'true';
if (FORBIDDEN_TRADE_EXPOSURE) {
  throw new Error('LUOOME_EXPOSE_TRADE=true is not allowed. Trade tools are never exposed.');
}

const allowedSideEffects = new Set<SideEffect>(['read', 'advice']);
if (process.env.LUOOME_EXPOSE_WRITE === 'true') allowedSideEffects.add('write');
if (process.env.LUOOME_EXPOSE_EXTERNAL === 'true') allowedSideEffects.add('external');

const mcp = new McpServer({ name: 'luoome', version: '0.1.0' });
for (const tool of toolRegistry.all()) {
  if (!allowedSideEffects.has(tool.sideEffect)) continue;
  mcp.tool(tool.name, tool.description, tool.inputSchema, async (args) => {
    const result = await tool.handler(args, buildCtx());
    if (!result.ok) return { isError: true, content: [{ type: 'text', text: JSON.stringify(result.error) }] };
    return { content: [{ type: 'text', text: JSON.stringify(result.data) }] };
  });
}

await mcp.connect(new StdioServerTransport());
```

### 2.7 TUI 布局草图

```
┌────────────────────────────────────────────────────────────┐
│ 本建议由 AI 生成，不构成投资建议。投资有风险，决策需自行承担。│
├──────────────────────────┬─────────────────────────────────┤
│ 持仓                      │ 今日建议                         │
├──────────────────────────┼─────────────────────────────────┤
│ 002594 比亚迪   96.18 -1.6│ 002594 比亚迪   HOLD  65% (short)│
│ 002643 万润科技 15.31 -13 │ 002643 万润科技 SELL  78% (short)│
│ ...                       │ ...                              │
├──────────────────────────┴─────────────────────────────────┤
│ [r] 刷新  [q] 退出  [d] 查看建议详情  [s] 复盘统计          │
└────────────────────────────────────────────────────────────┘
```

---

## 3. Workstreams — 如何分给多个并行 Agent

v0.1 适合拆为 5-6 个 workstream 并行推进。**Phase 1 必须先完成**。

### 3.1 拆分方案

| Workstream | Phase | 输入 | 输出 | 可并行 |
|---|---|---|---|---|
| **WS-A: Foundation** | Phase 1 | docs | monorepo 骨架 | ❌ 必须先 |
| **WS-B: Core** | Phase 2 | WS-A | core 包 + 测试 | ✅ 与 WS-C 并行 |
| **WS-C: DB Schema** | Phase 3a | WS-A, WS-B entity 类型 | Drizzle schema + migration | ✅ 与 WS-B 部分并行 |
| **WS-D: DB Repo** | Phase 3b | WS-C | repository 实现 + in-memory | ❌ 需 WS-C |
| **WS-E: Tools** | Phase 4 | WS-B, WS-D | 8 tools + tests | ❌ 需 WS-B + WS-D |
| **WS-F: MCP + CLI + TUI** | Phase 5/6/7 | WS-E | mcp server + CLI + TUI | ❌ 需 WS-E |

### 3.2 派单模板（每个 workstream 一份）

每个 agent 收到的 prompt 模板：

```text
# Workstream {ID}: {NAME}

## 前置依赖

{列已经完成的 workstream 和产出}

## 你的 scope

{详细列出本 workstream 的交付物}

## 不要做

{显式列出本 workstream 不应触碰的范围，避免越界}

## 读

- ~/project/luoome/ARCHITECTURE.md §{相关章节}
- ~/project/luoome/AGENTS.md §{相关章节}
- ~/project/luoome/docs/MVP-TASK.md §{相关章节}

## 验收

{本 workstream 的验收项}

## Escalation

遇到 {X} 时停下来问 user。
```

### 3.3 Worktree 隔离（推荐）

每个并行 workstream 用独立 git worktree：

```bash
cd ~/project/luoome
git worktree add ../luoome-ws-b  -b ws/core
git worktree add ../luoome-ws-c  -b ws/db-schema
git worktree add ../luoome-ws-d  -b ws/db-repo
git worktree add ../luoome-ws-e  -b ws/tools
git worktree add ../luoome-ws-f  -b ws/surfaces
```

每个 agent 在自己的 worktree 工作，merge 时按 WS-A → WS-B → WS-C → WS-D → WS-E → WS-F 顺序合入 main。

### 3.4 串行兜底

如果 agent 数量有限或并行协调成本高，按以下串行顺序单人 agent 推进：

```
WS-A → WS-B → WS-C → WS-D → WS-E → WS-F
```

每个 WS 完成时 commit，再启下一个 agent。

---

## 4. 派单关键 Tips

### 4.1 给 agent 的 prompt 必备元素

每个 prompt 必须包含：

1. **项目根路径**（绝对路径）
2. **必读文档列表**（按顺序）
3. **scope 边界**（做什么 / 不做什么）
4. **技术栈硬约束**
5. **交付物清单**（可勾选）
6. **验收标准**（可验证）
7. **Escalation 规则**（何时问 user）

### 4.2 反模式（不要这样写 prompt）

- ❌ "帮我实现 luoome" → 太模糊
- ❌ "参考 ARCHITECTURE.md 实现 v0.1" → 没指明哪些章节
- ❌ "把 8 个 tool 都实现了" → 没指明副作用分级 / mock LLM 约定
- ❌ "接真实行情数据" → 越界，v0.1 不接
- ❌ "和 ruo-cli 类似地实现" → 禁止 import ruo-cli

### 4.3 验证 agent 工作的方法

每个 workstream 完成后，跑：

```bash
cd ~/project/luoome
bun test                                    # 单测全绿
bun run typecheck                           # TS 零错
bun run lint                                # Biome 零错
# 特定 workstream 的额外验证：
./bin/luoome tools list                     # WS-F 验证
./bin/luoome tui                            # WS-F 验证
```

---

## 5. Escalation 详细规则

agent 应当在以下情况**立即停下来问 user**，不要硬猜：

1. **文档冲突**：ARCHITECTURE / AGENTS / SECURITY 之间有矛盾
2. **副作用分级不明**：某个 tool 应该 read / write / external / advice 哪一级不定
3. **disclaimers 内容**：STANDARD_DISCLAIMERS 是否需要增减
4. **Tool 命名**：tool name 是否符合 snake_case 约定
5. **Mock 数据规模**：fixture 多少只股票 / 多少持仓合理
6. **TUI 交互细节**：按键绑定 / 布局 / 颜色 scheme
7. **任何超出 v0.1 scope 的需求**：包括但不限于真实数据源、真实 LLM、Web 入口
8. **任何需要 user 提供 secret / API key 的需求**

agent 应当**继续**的情况：

- 文档没明说但符合 §1 TL;DR 的硬约束
- 细节实现选择（命名风格 / 文件拆分 / 测试粒度）按 ARCHITECTURE 推导
- 错误处理策略（按 ToolError 模型）
- 数据库 schema 字段细节（按 entity 接口推导）

---

## 6. 完成定义（Definition of Done）

v0.1 完成的判定：

```bash
cd ~/project/luoome && bun install          # 0 exit
cd ~/project/luoome && bun test             # 0 exit, all green
cd ~/project/luoome && bun run typecheck    # 0 exit
cd ~/project/luoome && bun run lint         # 0 exit
cd ~/project/luoome && bun run build        # 0 exit, dist generated
./bin/luoome --version                      # outputs "0.1.0"
./bin/luoome --help                         # lists all subcommands
./bin/luoome tools list                     # outputs 8 tools
./bin/luoome tools inspect list_holdings    # outputs Zod schema
./bin/luoome advice list                    # outputs mock advice (with disclaimers!)
./bin/luoome advice stats                   # outputs mock stats
./bin/luoome mcp serve &                    # background
  # mcp client: list tools → 8 items, call analyze_stock → returns Advice with disclaimers
./bin/luoome tui                            # shows mock holdings + advice + top disclaimer
```

所有项通过 = v0.1 DONE。

---

## 7. 给 user 的检查清单

agent 交付后，user 应当验证：

- [ ] 没有 import 任何 ruo-cli 代码（`grep -r "ruo-cli" packages/` 应为空）
- [ ] 没有 Prisma / TypeORM / Sequelize 引用（`grep -r "prisma\|typeorm\|sequelize" packages/` 应为空）
- [ ] 副作用 5 级都有示例 tool（每个 sideEffect 至少 1 个）
- [ ] advice tool 输出 100% 含 STANDARD_DISCLAIMERS 三条
- [ ] `LUOOME_EXPOSE_TRADE=true luoome mcp serve` 启动失败
- [ ] TUI 顶部固定免责声明可见
- [ ] 每个 tool 有 ≥ 1 个 vitest 测试
- [ ] commit history 用 conventional commits

不通过 → 让 agent 修，不直接合入。
