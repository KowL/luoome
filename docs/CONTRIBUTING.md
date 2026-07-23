# Contributing to luoome

> 欢迎加入 luoome。这份文档面向**想动手改代码的贡献者**：如何拉仓库、本地开发、跑测试、提 PR、加新 tool / 战法 / 适配器。
>
> 如果你只是想**调用** luoome 的 tool，请看 [AGENTS.md](../AGENTS.md)；想了解架构看 [ARCHITECTURE.md](./ARCHITECTURE.md)；想看路线图看 [ROADMAP.md](./ROADMAP.md)。

## 目录

- [开发环境](#开发环境)
- [仓库结构](#仓库结构)
- [日常命令](#日常命令)
- [代码规范](#代码规范)
- [测试](#测试)
- [PR 流程](#pr-流程)
- [Commit 规范](#commit-规范)
- [扩展指南](#扩展指南)
  - [加一个新 tool](#加一个新-tool)
  - [加一个新战法](#加一个新战法)
  - [加一个新数据源](#加一个新数据源)
  - [加一个新 workflow](#加一个新-workflow)
- [依赖方向（硬约束）](#依赖方向硬约束)
- [Issue 标签](#issue-标签)
- [安全相关](#安全相关)

## 开发环境

**前置**

- [Bun](https://bun.sh) ≥ 1.3.0（用 `bun --version` 验证）
- Git
- SQLite（macOS / Ubuntu 自带；CI 上 Ubuntu-latest 自带）

**拉代码并装依赖**

```bash
git clone git@github.com:KowL/luoome.git
cd luoome
bun install --frozen-lockfile
```

第一次跑测试前，db 包需要初始化 SQLite schema（首次会通过 `createDrizzleRepos` 自动建表）。

**推荐的编辑器配置**

- VS Code / Cursor + Bun 扩展 + Biome 扩展（lint / format 实时提示）
- TypeScript strict 模式已开；不要把任何 `// @ts-ignore` 留在 PR 里

## 仓库结构

Bun workspace monorepo。`packages/*` 是库，`apps/*` 是可独立部署的应用。

```txt
luoome/
├── packages/
│   ├── core/          领域类型（Account/Holding/Trade/Stock/Advice/...）+ 不变量
│   │                  纯类型 + 函数，零 IO。branded types 都在这。
│   ├── db/            Drizzle schema + 双实现 repo（drizzle + in-memory）
│   │                  依赖 bun:sqlite；只能由 Bun 运行时 import。
│   ├── adapters/      外部依赖适配
│   │   ├── market/    Eastmoney / Tencent 行情
│   │   ├── llm/       OpenAI-Compatible / Anthropic LLM
│   │   ├── testing/   仅测试可导入的 deterministic fixtures / fakes
│   │   └── notification/  飞书 Webhook 等
│   ├── tools/         Tool 注册表 + Zod → TS/MCP/OpenAI 推导
│   │                  32 个内置 tool（read 16 / advice 3 / write 9 / external 4，v0.6 末）。
│   ├── workflows/     内置编排：syncQuotes / dailyAdvice / tacticScan / riskReport / dailyReview
│   ├── mcp/           MCP stdio server（env 控制暴露面）
│   ├── cli/           `luoome` 命令入口（手写 argv 解析，无第三方 CLI 框架）
│   └── tui/           opentui 应用
├── apps/
│   └── web/           Hono + 原生 HTML/JS 仪表盘（6 路由 + 设计系统）
├── docs/              全部文档
│   ├── ARCHITECTURE.md    架构核心
│   ├── ROADMAP.md         v0.1 → v0.7 演进
│   ├── SECURITY.md        副作用分级 + advice 安全 + audit
│   ├── CONTRIBUTING.md    本文件
│   ├── HANDOFF.md         交接 + 功能 backlog
│   ├── BACKLOG.md         一致性 / 工程债清单
│   └── USER_GUIDE.md      用户手册（另有设计文档与历史 plan）
├── bin/luoome         bash 转发到 bun run packages/cli/src/index.ts
├── .github/workflows/ CI（typecheck + test:all + lint）
├── AGENTS.md          给外部 agent harness 看的接入文档（仓库根，便于 harness 发现）
└── README.md          项目门面
```

**包之间的依赖方向（硬约束，禁止反向）**

```txt
cli / tui / mcp / web ──► tools ──► core
                          │
                          └─► { db, adapters } ──► core
workflows ──► tools ──► core
```

- `core` **绝对不能** import 任何其它包（保证纯领域类型）
- `db` / `adapters` 可以依赖 `core`，不能依赖 `tools` / `workflows` / `cli` 等上层
- `tools` 是所有 surface（CLI / TUI / MCP / Web）的唯一上游依赖
- 跨包合约变更先开 issue 讨论，不要悄悄改

## 日常命令

所有命令都在 repo 根目录跑。

| 命令 | 干什么 |
|---|---|
| `bun run typecheck` | 全 monorepo 跑 `tsc --noEmit` |
| `bun test` | vitest（478 个 case，0 fail） |
| `bun run test:db` | bun test（db 包 + drizzle + in-memory 合约测试，127 个 case） |
| `bun run test:web` | bun test（apps/web 闸口矩阵，9 个 case；v0.8 起） |
| `bun run test:all` | 上面三个一起跑（CI 用这个） |
| `bun run lint` | biome check（lint + format 检查，0 错） |
| `bun run format` | biome format --write（自动修格式） |
| `bun packages/tui/src/smoke.ts` | TUI headless smoke（6 项断言） |
| `bash bin/luoome --help` | CLI 帮助 |
| `bash bin/luoome tools list --json` | 列 32 个 tool |
| `bash bin/luoome mcp serve` | 起 MCP stdio server |
| `bash bin/luoome tui` | 跑终端仪表盘 |
| `bash bin/luoome web serve --port 5173` | 起 Web 仪表盘 |
| `bash bin/luoome workflow run tactic-scan --input '{}'` | 跑战法扫描 |

**CI 三关必须全绿**：`typecheck` + `test:all` + `lint`。本地跑通再 push。

## 代码规范

### TypeScript 风格

- `tsconfig.base.json` 已开 `strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes`。
- 不留 `any`；`unknown` 用 zod parse 收口。
- 不写 `// @ts-ignore`；写 `// biome-ignore` 注释临时忽略 lint。
- `interface` 用 readonly 字段（领域实体不可变）。
- 跨包 import 写 `.js` 后缀（`./foo.js`）— Bun 直接跑 TS 时仍按 ESM 解析。

### Branded Types

`core/src/types/branded.ts` 定义：

- `Money` — 永远 4 位小数
- `Quantity` — 非负整数
- `Percentage` — `[-1, 10]`
- `StockCode` — 1-12 位大写字母数字

裸 `number` / `string` 不能直接当 `Money` / `StockCode` 用；走 `money(n)` / `quantity(n)` / `percentage(n)` / `stockCode(s)` 构造。Tool 输入的 zod schema 用 `MoneySchema` / `StockCodeSchema` 等自动校验 + transform。

### 副作用五级

每个 tool / workflow 都要标 `sideEffect`（v0.1 已建，v0.4 没改）：

| level | 含义 | MCP 默认暴露 |
|---|---|---|
| `read` | 只读 | ✓ |
| `advice` | 调 LLM + 写库 | ✓ |
| `write` | 改本地状态 | opt-in |
| `external` | 触发外部副作用 | opt-in |
| `trade` | 真实下单 | **永不**（启动硬卡） |

新加 tool 时选错等级会被 MCP / Web 拒绝；不确定就选最严的，写 issue 讨论。

### 不变量

每个 entity 都有 invariant 函数（`packages/core/src/entity/invariants.ts`），repo 在 `save` 前 assert。改 entity 时同步改 invariant + 加测试。

`Advice` 6 条不变量是核心：

1. `confidence ∈ [0, 100]`
2. `disclaimers` 至少含 `STANDARD_DISCLAIMERS` 三条
3. `validUntil > validFrom`
4. `reasoning.premise` 非空
5. `disclaimers` 非空
6. 序列化往返一致（schema 自检）

### 错误处理

- Tool **永不抛异常**，永远返回 `ToolResult<T> = { ok: true, data } | { ok: false, error: ToolError }`
- `ToolError.kind` ∈ `invalid_input / not_found / invariant_violation / adapter_error / llm_error / permission_denied / internal`
- Workflow 步骤返回 `ToolResult` 时引擎自动解包（`ARCHITECTURE §4.6`），返回 `error` 时短路
- LLM 调用失败重试一次，再走明确标记的低信心规则兜底

### 格式化 / Lint

biome 单文件即可配置；CI 跑 `biome check .`，要求 0 error。`bun run format` 自动修格式。PR 里如果有 biome 报错会被打回。

## 测试

`bun test` 跑 vitest，主要覆盖：

- `packages/core` — entity 不变量 + 工具函数 + branded types
- `packages/tools` — 每个 tool 至少 1 个单测（input validation + happy path + 关键 error kind）
- `packages/cli` — argv 解析 + help 输出 + 子命令分发
- `packages/mcp` — stdio server smoke（list tools + 只读调用）
- `packages/workflows` — 引擎 + 内置 workflow（v0.4 加 5 个）

`bun run test:db` 跑 bun test，专覆盖：

- `packages/db` 的 **合约测试**（contract-tests.ts）—— 同一套测试对 drizzle + in-memory 两个 repo 各跑一遍，确保行为一致

TUI headless smoke（`bun packages/tui/src/smoke.ts`）断言：

1. 首屏布局（免责声明 / 持仓 / 建议 / 快捷键栏）
2. `[d]` 详情弹层
3. `[esc]` 关闭
4. `[s]` 统计弹层
5. `[t]` 战法扫描
6. `[o]` outcome 复盘
7. `[q]` 退出

跑 smoke 需要 `bun`（依赖 `@opentui/core/testing`）。

**写测试**

- 命名 `<name>.test.ts`，放源文件旁
- 单测聚焦一个断言；多个 case 用 `it.each` 拆
- 工具函数 / 不可变数据用 `expect(x).toBe(y)`；对象 / 数组用 `toEqual`
- Drizzle 测试用 in-memory repo 加速；合约测试必须 drizzle + memory 都跑

## PR 流程

1. **开 issue 讨论**（特别是跨包合约变更、新 tool 类型、新战法语法）。
2. 从 `main` 拉分支：`git checkout -b codex/short-name`（用 `codex/` 前缀；CI 不强制但保持一致）。
3. 改代码 + 加测试 + 跑 `bun run typecheck && bun run test:all && bun run lint`，三关全绿。
4. commit 信息按 [Conventional Commits](#commit-规范)。
5. push + 开 PR。CI 自动跑三关。
6. 至少 1 个 reviewer 通过后 squash merge。

**PR 模板**（手写即可）：

```md
## 改了什么

- 一句话总结

## 怎么测的

- 跑了什么命令 / 看到了什么输出
- 新增 / 修改的测试

## Checklist

- [ ] `bun run typecheck` 通过
- [ ] `bun run test:all` 通过
- [ ] `bun run lint` 通过
- [ ] 如果改了 core entity，同步改了 invariants + 测试
- [ ] 如果加了新 tool，在 AGENTS.md 工具清单登记
- [ ] 如果改了 API/CLI/Web，更新对应 README / AGENTS.md
```

## Commit 规范

Conventional Commits：

```txt
feat(area): 新增功能
fix(area): 修复 bug
chore(area): 杂项（依赖 / 配置 / CI）
docs(area): 文档
refactor(area): 重构（无行为变更）
test(area): 测试
perf(area): 性能
```

`area` 通常是包名（`core / db / tools / adapters / workflows / mcp / cli / tui / web`）或主题（`v0.3 / repo / ci`）。

例子：

- `feat(tools): 加 search_stocks tool`
- `fix(workflows): risk-report stepCompute 把 unwrap data 当 ToolResult`
- `chore(ci): 加 .github/workflows/ci.yml`

## 扩展指南

### 加一个新 tool

最小骨架（参考 `packages/tools/src/tools/search-stocks.ts`）：

```ts
// packages/tools/src/tools/my-tool.ts
import { z } from 'zod';
import { defineTool } from '../define-tool.js';

export const MyToolInput = z.object({
  /** ... 字段 ... */
  stockId: z.string().min(1),
});

export const MyToolOutput = z.object({
  /** ... 字段 ... */
});

export const myTool = defineTool({
  name: 'my_tool',
  description: '一句话描述（agent 会看到这行）',
  sideEffect: 'read', // 或 advice / write / external / trade
  input: MyToolInput,
  output: MyToolOutput,
  handler: async (input, ctx) => {
    // 实现：读 ctx.repos / ctx.adapters / ctx.user / ctx.clock / ctx.logger
    // 永不 throw；error 时返回 { ok: false, error: { kind, ... } }
    return { ok: true, data: { ... } };
  },
});
```

然后在 `packages/tools/src/tools/index.ts` 桶导出 + 在 `packages/tools/src/registry.ts` 注册：

```ts
import { myTool } from './tools/my-tool.js';
toolRegistry.register(myTool);
```

**必做**：

1. 在 `packages/tools/src/tools/my-tool.test.ts` 写至少 3 个测试：happy / invalid_input / not_found 或 adapter_error
2. 在 `packages/core/src/entity/invariants.ts` 加 entity 不变量（如果是新 entity）
3. 在 `packages/core/src/repository/index.ts` 加 repo 接口 + 在 drizzle + memory 各实现
4. 如果改 core：在 `packages/workflows/src/define-workflow.ts` 的 `WorkflowToolMap` 同步加 accessor
5. 在 `AGENTS.md` 工具清单登记（按 sideEffect 分类）
6. CLI `tools list` 应能见到（不需要额外改动，registry 自动）

### 加一个新战法

最小骨架（参考 `packages/adapters/src/mocks/tactics.ts` 的 5 个 builtin）：

```ts
// packages/adapters/src/mocks/tactics.ts (或 ~/.luoome/tactics/*.ts 用户自定义)
{
  id: 'my-tactic',
  name: '我的战法',
  tag: 'momentum', // 或 mean-reversion / volume / risk / pattern
  description: '一句话描述',
  risk: 'mid', // low / mid / high
  direction: 'bullish', // bullish / bearish / neutral
  source: 'builtin', // builtin / user
  triggerWhen: '${indicators.ma5} > ${indicators.ma10} && ${indicators.ma10} > ${indicators.ma20}',
  scoreExpression: 'Math.min(100, ${indicators.ma5} - ${indicators.ma20})',
  evidenceTemplate: [
    'MA5=${indicators.ma5}',
    'MA20=${indicators.ma20}',
  ],
  definedAt: new Date('2026-07-20'),
}
```

**DSL 语法**（`packages/core/src/tactic/`）：

- `${indicators.<key>}` 取指标（MA5 / MA10 / MA20 / MA60 / RSI14 / MACD / volMa5 / volMa20 / volRatio5_20 / high20 / low20 等 13 个）
- `${meta.<key>}` 取元数据（如 `daysSinceLimitUp`）
- 支持 `&&` / `||` / `!` / `>=` / `<=` / `>` / `<` / `===`
- 数字字面量直接写
- 表达式结果：true / false / number
- score 表达式支持 `Math.min / max / abs / round`

新加战法后跑 `bash bin/luoome workflow run tactic-scan --tactic-id my-tactic` 验证。

### 加一个新数据源

行情 / LLM / 通知 / 券商：

1. 在 `packages/adapters/src/<kind>/` 加新文件，实现对应 `*Adapter` 接口
2. 在 `packages/adapters/src/manager*.ts` 注册到 manager（带 rate limit / cache / fallback）
3. 加 `Manager.choose(source)` 的 fallback 链条目
4. 写测试：
   - happy path（返回 fixture）
   - adapter_error（5xx / timeout）
   - fallback（主源失败切备用）
5. 如果涉及 env 变量，在 `ARCHITECTURE §12` 和 README 同步登记

**不要绕过 manager 直接调 adapter**——所有外部依赖都必须走 cache + rate-limit + fallback。

### 加一个新 workflow

参考 `packages/workflows/src/tactic-scan.ts`（最有代表性的聚合 workflow）：

```ts
// packages/workflows/src/my-workflow.ts
import { z } from 'zod';
import { defineWorkflow, type WorkflowStep } from './define-workflow.js';

export const MyWorkflowInput = z.object({
  /** ... */
});

export const MyWorkflowOutput = z.object({
  /** ... */
});

const stepA: WorkflowStep = async (prev, ctx) => { /* ... */ };
const stepB: WorkflowStep = async (prev, ctx) => { /* ... */ };

export const myWorkflow = defineWorkflow<MyWorkflowInput, MyWorkflowOutput>({
  name: 'my-workflow',
  description: '一句话描述',
  input: MyWorkflowInput,
  steps: [stepA, stepB],
});
```

在 `packages/workflows/src/index.ts` 桶导出，CLI `luoome workflow run my-workflow --input '{}'` 自动可用。

## 依赖方向（硬约束）

**禁止反向依赖**：

- `core` 不能 import 任何其它包
- `db` / `adapters` 不能 import `tools` / `workflows` / `cli` / `tui` / `mcp` / `web`
- `tools` 是上层（cli / tui / mcp / web / workflows）的唯一上游
- workflow 不能直接调 adapter / repo，必须通过 tool

破例需在 PR 描述里显式说明 + reviewer 通过。CI 用 ESLint 风格 import 检查（v0.5 计划加）。

## Issue 标签

| 标签 | 用途 |
|---|---|
| `bug` | 缺陷 |
| `feature` | 新功能 |
| `agent` | 涉及 agent harness 接入 / AGENTS.md 同步 |
| `security` | 安全相关（详见 [SECURITY.md](./SECURITY.md)） |
| `tool` | 加新 tool |
| `tactic` | 加新战法 / 战法引擎改动 |
| `adapter` | 加新数据源 |
| `workflow` | 加新 workflow |
| `tui` / `web` / `cli` / `mcp` | 表面层改动 |
| `docs` | 文档 |
| `good first issue` | 适合新手 |
| `help wanted` | 求协助 |

## 安全相关

发现安全漏洞请**不要**公开开 issue；按 [SECURITY.md](./SECURITY.md) 走私下渠道。

关键约束（PR review 时要重点确认）：

- 不引入 `place_order` / `cancel_order` 这类 trade 类 tool（MCP / Web 永不应暴露）
- advice 类 tool 不允许直接触发 trade
- 加新写副作用的 tool 时同步写：[SECURITY.md](./SECURITY.md) 的副作用分级
- LLM 调用必须 fallback（不可让一次失败导致整个 workflow 死）

---

## 致谢

感谢每一个想动手改这个项目的人。luoome 不是想做平台，是想做"个人真能用的 advisor agent"。如果你的改动让它更贴近这个目标，那就是好的贡献。
