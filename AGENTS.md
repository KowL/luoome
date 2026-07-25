# AGENTS.md — luoome 编码 Agent 开发规范

> 本文件面向在仓库内修改代码的 Claude Code、Codex、Cursor 等编码 Agent。
> 如果要让外部 Agent 调用 luoome，请安装 [luoome Skill](./skills/luoome/SKILL.md)，不要把本文件当作 MCP 接入手册。

## 权威资料

| 主题 | 事实来源 |
|---|---|
| 项目入口与环境变量 | [README.md](./README.md) |
| 文档导航 | [docs/README.md](./docs/README.md) |
| 领域语言 | [CONTEXT.md](./CONTEXT.md) |
| 模块边界、数据流、Tool/Workflow 契约 | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) |
| 开发环境、代码规范、扩展与 PR 流程 | [docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md) |
| 副作用、鉴权与投资建议边界 | [docs/SECURITY.md](./docs/SECURITY.md) |
| 命令和测试入口 | [package.json](./package.json) |

不要在本文件复制完整 tool 清单、测试数量或版本快照。运行时 tool 库存以 `packages/tools/src/registry.ts`、MCP discovery 和 `luoome tools list --json` 为准。

## 开始修改前

1. 查看当前分支和工作树，区分用户已有改动与本任务改动。
2. 读取目标文件及相邻测试，确认现有模式后再写代码。
3. 涉及领域概念时先读 `CONTEXT.md`；涉及跨包契约时读 `docs/ARCHITECTURE.md` 对应章节。
4. 只实现明确需求，不顺手加功能、兼容层、抽象或无关重构。
5. 优先编辑已有文件；除需求确实需要外，不新建文档、配置或 helper。

## 架构硬约束

```text
cli / tui / mcp / web ──► tools ──► core
                          │
                          └─► { db, adapters } ──► core
workflows ──► tools ──► core
```

- `packages/core` 是纯领域层，零 IO，不反向依赖其它包。
- `db` 与 `adapters` 可依赖 `core`，不可依赖 `tools`、`workflows` 或 surface。
- CLI、TUI、MCP、Web 统一通过 tools 使用业务能力，不复制领域逻辑。
- Tool 的 input/output 由 Zod schema 定义，并派生 TypeScript、MCP 与 OpenAI schema。
- Tool 对调用方永远返回 `ToolResult`；失败使用既有 `ToolError.kind`，不把异常泄漏为调用协议。
- Workflow 只通过 `ctx.tools.*` 编排能力，不直接绕过 tool 调 repository 或 adapter。
- 新 repository 必须同时提供 drizzle 与 in-memory 实现，并复用 contract tests 验证一致性。
- Drizzle schema 与 `ensureSchema` 的 SQLite DDL 必须同步；存量库变更要保持启动迁移幂等。

## 实现约定

- 使用 Bun workspace、TypeScript strict、ESM 与 `.js` import 后缀；格式和 lint 以 Biome 为准。
- 信任内部类型和框架保证，只在用户输入、HTTP、MCP、外部 API 等系统边界校验。
- 不变量放在 core 的 schema/assertion 中，不在各 surface 重复实现。
- 不新增自动交易路径；`StockGroup`、`WatchPlan`、`WatchTrigger` 等产品语义以 `CONTEXT.md` 为准。
- Web 保持 Hono + 原生 HTML/CSS/JS 的现有技术栈；UI 改动除自动测试外必须实际启动并用浏览器验证。
- 默认不写解释代码“做什么”的注释；仅在隐藏约束、非显然原因或必要 workaround 处说明“为什么”。
- 不为无法发生的内部状态增加 fallback；外部依赖失败按已有错误模型处理。

## 安全与副作用

- `advice` 永远不等于 `trade`，任何建议或盯盘触发都不能自动下单。
- `trade` tool 永不通过 MCP 暴露；不得绕过 `LUOOME_EXPOSE_TRADE=true` 的启动硬卡。
- `write` 与 `external` 能力必须保持显式 opt-in；新增 tool 时正确声明 `sideEffect`。
- 面向用户呈现 Advice 时保留反证、风险、免责声明和有效期，不把 confidence 表述成确定性。
- 不记录、提交或输出 `.env`、API key、token、数据库中的私人投资数据。

## 测试与验收

所有命令从仓库根目录运行，脚本定义以 `package.json` 为准：

| 命令 | 范围 |
|---|---|
| `bun run test` | Vitest 的 Node 兼容测试；排除项见 `vitest.config.ts` |
| `bun run test:db` | Bun 运行时的 db、drizzle 与 in-memory 合约测试 |
| `bun run test:web` | Bun 运行时的 Web server 与前端测试 |
| `bun run test:all` | 上述全部测试 |
| `bun run typecheck` | 所有 workspace 的 TypeScript 检查 |
| `bun run lint` | Biome lint 与格式检查 |
| `bun run build` | workspace Bun 构建 |

- 开发中先跑最小相关测试；交付前跑与改动范围匹配的 typecheck/test/lint。
- 不要用 Node 直接加载依赖 `bun:sqlite` 的 db 或 Web server 测试。
- 测试失败时修根因，不使用 `--no-verify`、删除测试或放宽断言绕过。
- 纯文档改动至少检查 Markdown 相对链接和 `git diff --check`。

## 变更同步清单

- **Core entity**：schema、类型、不变量、导出和测试同步。
- **Repository**：接口、drizzle、memory、registry 接线和 contract tests 同步。
- **Tool**：schema、实现、桶导出、registry、sideEffect、测试以及 Skill 的能力分类同步。
- **Workflow**：`WorkflowToolMap`、实现、导出、CLI 发现和测试同步。
- **API/Web**：服务端契约、前端调用、鉴权/Origin 行为、测试和浏览器验收同步。
- **文档**：按 `docs/README.md` 分类；当前行为写入维护文档，阶段快照归入 `docs/archive/`。

## Git 操作

- 不覆盖或删除用户未提交的改动，不用破坏性命令解决冲突或锁文件。
- 未经用户明确要求，不 commit、push、创建 PR、修改远端状态或改写历史。
- 用户要求提交时只暂存本任务文件，提交前检查 staged diff；禁止跳过 hooks 或签名。
