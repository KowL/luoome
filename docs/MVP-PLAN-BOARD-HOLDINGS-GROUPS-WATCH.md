# luoome 完整可用 MVP 开发计划

> 目标版本：MVP-1（建议发布为 `v0.8.0`）
>
> 实施状态（2026-07-23）：核心范围已完成并通过自动化与浏览器验收，记录见
> [MVP-ACCEPTANCE.md](./MVP-ACCEPTANCE.md)。
>
> 核心范围：**看板、持仓、分组、盯盘**
>
> 产品形态：本地单用户 Web 为主入口，CLI/MCP 保留为高级入口；不做真实下单。

## 1. 结论

项目已经具备可复用的领域内核，不需要推倒重来：

- 持仓：账户、持仓、交易写入、行情、PnL 和 Web 持仓操作已存在。
- 分组：`StockGroup`、成员快照、manual/holdings/formula/llm resolver、CRUD 和刷新已存在。
- 盯盘：`StockPool`、三类规则、cooldown、触发落库、通知和 `luoome watch` 已存在。
- 看板：已有持仓汇总和建议卡片，但没有分组、盯盘状态和触发摘要。

当前主要问题不是“能力缺失”，而是“产品闭环缺失”：

1. 分组和盯盘没有一等 Web 页面。
2. 触发记录没有只读 tool/API，用户看不到盯盘历史。
3. 长驻 watch 没有可查询的运行状态或最后心跳。
4. Web 需要同时启动服务和 watch，缺少一个日常使用的一键入口。
5. 持仓写入已有，但交易历史不可见，审计链不完整。
6. Web token 目前只在前端保存，服务端没有真实鉴权；默认写操作暴露面需要收紧。
7. 版本号、文档和测试数字存在漂移，不符合可发布状态。

因此 MVP 的策略是：**复用现有 tool/workflow，补读模型、Web 产品面、运行状态、安全和端到端验收。**

## 2. MVP 产品边界

### 2.1 用户每天能完成的四条链路

#### 看板

- 看到账户总市值、总成本、总盈亏和持仓数量。
- 看数据更新时间和行情来源，知道数据是否新鲜。
- 看启用的分组数、过期分组数、启用的盯盘池数。
- 看 watch 是否运行、最后成功轮次、评估股票数、最近触发数。
- 看最近高优先级触发，并能跳转到对应持仓、分组或盯盘池。

#### 持仓

- 新建持仓、加仓、减仓、纠错、平仓。
- 股票搜索并自动带入当前价。
- 查看现价、市值、成本、盈亏和可卖数量。
- 查看该持仓的交易历史，确认每次操作已落库。
- 所有危险操作都有二次确认和清晰错误反馈。

#### 分组

- 查看全部分组、resolver 类型、成员数、最后刷新时间、stale 状态。
- 创建/编辑/删除 manual、holdings、formula、llm 分组。
- 查看成员、进入理由和刷新时间。
- 手动刷新 formula/llm 分组，并展示 entered/exited/失败原因。
- 删除被盯盘池引用的分组时给出明确阻塞和跳转入口。

#### 盯盘

- 查看、创建、编辑、启停、删除盯盘池。
- 为池配置 tactic、cost-threshold、price-change 规则和 cooldown。
- 查看 watch 运行状态、最近轮次、最近触发和通知/冷却状态。
- 手动“跑一轮”用于验证配置。
- 用一个命令同时启动 Web 和长驻 watch。

### 2.2 明确不进入本 MVP

- 真实券商下单、自动跟单。
- 云同步、多用户、团队协作。
- strategy resolver、回测平台、因子研究平台。
- 原生移动 App。
- Web 直接管理系统守护进程/launchd。
- 新增复杂行情图表、新闻和财报模块。

## 3. 当前基线

| 领域 | 当前能力 | MVP 缺口 |
|---|---|---|
| 看板 | 持仓汇总、建议卡片、5 秒刷新 | 无分组/盯盘摘要、无行情新鲜度、无 watch 状态 |
| 持仓 | Web 新建/加/减/纠错/平仓，行情搜索 | 无交易历史；错误/确认流程仍需 E2E 验证 |
| 分组 | 7 个 tool、成员快照、stale、动态刷新 | 无独立 Web UI；成员展示缺股票名/行情；外部刷新未做 UI 门控 |
| 盯盘 | pool CRUD、三类规则、workflow、cooldown、通知、CLI | 无 Web UI；无 trigger 查询 tool；无 run heartbeat；需手动开第二个进程 |
| 安全 | trade 永不暴露；Web 有前端 token 字段 | 服务端不校验 token；默认监听与写权限策略需收紧 |
| 工程 | typecheck/lint/build/test 通过 | 版本号与文档漂移；缺核心用户旅程浏览器 E2E |

### 3.1 2026-07-23 验证结果

- `bun run typecheck`：通过。
- `bun run lint`：通过，281 个文件无错误。
- `bun run build`：通过，全部 package/app 成功构建。
- `bun run test:all`：
  - Vitest：84 个文件、648 条测试通过。
  - DB Bun runner：149 条通过。
  - Web Bun runner：20 条通过。
- 隔离 `LUOOME_HOME` 下 `luoome watch --once --no-notify`：
  - 评估 1 个池、6 只股票。
  - 产生 5 条触发。
- 隔离 Web 冒烟：
  - 首屏 HTML 正常。
  - `/api/holdings` 正常返回 6 条持仓及汇总。
  - `list_stock_groups` 正常返回默认持仓分组和 6 个成员。
  - `list_stock_pools` 正常返回默认持仓监控池。

## 4. MVP 信息架构

建议主导航收敛为：

1. **看板**
2. **持仓**
3. **分组**
4. **盯盘**
5. 建议
6. 复盘
7. 设置

“战法”和“对话”保留，但降为辅助入口；MVP 的首次使用路径必须围绕前四项。

### 4.1 看板布局

- 第一行：总市值、总盈亏、持仓数、当日触发数。
- 第二行：watch 状态、最后成功时间、启用池数、stale 分组数。
- 主区左：持仓盈亏 Top/Bottom。
- 主区右：最近触发，按时间倒序。
- 次区：高信心建议（复用现有组件）。
- 所有卡片显示 `asOf`；过期/停滞状态使用明显警告色。

### 4.2 分组页面

- 左侧列表/卡片：名称、类型、成员数、enabled、stale、最近刷新。
- 右侧详情：成员表（代码、名称、进入理由、刷新时间）。
- 操作：新增、编辑、启停、刷新、删除。
- resolver 表单按 kind 动态切换：
  - manual：股票搜索多选。
  - holdings：账户选择。
  - formula：战法、lookbackDays、minScore。
  - llm：prompt、maxMembers、model。

### 4.3 盯盘页面

- 顶部状态：运行中/停滞/从未运行、最后心跳、下一轮预计时间。
- 池列表：绑定分组、规则摘要、cooldown、enabled。
- 池编辑器：支持多规则增删和字段级校验。
- 最近触发表：时间、池、股票、规则、方向、现价、理由、是否通知。
- “立即跑一轮”按钮：调用 Web workflow endpoint；执行中禁用，返回本轮摘要。

## 5. 技术设计

### 5.1 继续遵守的边界

- `core` 只放实体、不变量和 repository interface，不做 IO。
- 数据写入继续走 tool；workflow 不绕过 tool 写业务数据。
- Web 聚合端点只组合 tool/workflow，不复制领域逻辑。
- advice 永不触发 trade；MVP 不增加任何 trade tool。
- 动态分组 resolver 仍只在盘外/手动刷新，watch hot path 只读快照。

### 5.2 新增领域能力

#### A. 交易历史读取

新增 `list_trades` read tool：

- 入参：`accountId?`、`stockId?`、`since?`、`until?`、`limit`。
- 出参：交易列表、总数。
- 用于持仓详情和审计，不改变现有交易写入语义。

#### B. 盯盘触发读取

新增 `list_watch_triggers` read tool：

- 入参：`poolId?`、`stockId?`、`ruleKind?`、`notified?`、`since?`、`limit`。
- 出参：触发列表、总数。
- 复用现有 `WatchTriggerRepository.listRecent/listByPool`，必要时扩展过滤参数。

#### C. Watch 运行审计

新增 `WatchRun`：

- `id`
- `startedAt` / `finishedAt`
- `status: running | succeeded | failed`
- `evaluatedPools` / `evaluatedStocks`
- `triggered` / `notified` / `suppressedByCooldown`
- `error?`
- `mode: daemon | once`

新增 repository + Drizzle/memory 双实现 + contract test，以及：

- `record_watch_run`：workflow/runner 内部 write tool。
- `get_watch_status`：read tool，返回最后一轮和基于 interval 计算的健康状态。
- watch 每轮开始记 `running`，结束更新为 `succeeded/failed`；无触发时也有心跳。

不要用“最近一条 trigger”代替 heartbeat，因为无触发是正常状态。

### 5.3 Web 聚合端点

- `GET /api/dashboard`
  - 并发组合 holdings、groups、pools、watch status、recent triggers、advice。
  - 返回专用于首页的轻量 view model。
- `GET /api/trades`
- `GET /api/groups`、`GET /api/groups/:id`
- `GET /api/watch`
- `GET /api/watch/triggers`
- `POST /api/watch/run-once`
  - 调 `intradayWatchWorkflow.run`，不是新增 workflow tool。
  - 属 external 行为，必须经过 token 与确认。

通用 `/api/tools/:name/call` 可保留给高级功能，但前四个 MVP 页面优先使用稳定、显式的 Web endpoint。

### 5.4 一键启动

新增：

```bash
luoome start [--port 5173] [--interval 60] [--no-watch] [--no-notify]
```

实现方式：

- 从现有 `cmdWatch` 抽出可复用 `runWatchLoop`。
- `luoome start` 同进程启动 Web server 和 watch loop。
- SIGINT/SIGTERM 时同时停止 loop、关闭 server 和 DB handle。
- 不在 Web 请求里 spawn daemon，不增加隐蔽后台进程。

保留：

- `luoome web serve`：只起 Web。
- `luoome watch`：只起 watch。
- `luoome watch --once`：调试/cron。

### 5.5 Web 安全基线

MVP 发布前必须完成：

- Web 默认绑定 `127.0.0.1`，而不是所有网卡。
- 增加 `--host` / `LUOOME_HOST`。
- 非 loopback host 且没有 `LUOOME_WEB_TOKEN` 时启动失败。
- 服务端验证 `Authorization: Bearer`：
  - read 可在 loopback 无 token使用。
  - write/external 必须 token。
  - 非 loopback 建议所有 API 都要求 token。
- 校验 `Origin`，拒绝跨站 mutation。
- 删除“前端生成随机 token 即已鉴权”的误导文案；前端 token 必须与服务端配置一致。
- 保持 `trade` 永远 403/不注册。

## 6. 实施阶段

### Phase 0 — 冻结 MVP 契约与发布基线（0.5 天）

- 确认 MVP-1 只覆盖本文四条核心链路。
- 统一版本号到 `0.8.0`：
  - 根 package
  - CLI `--version`
  - MCP serverInfo
  - Homebrew test
  - README/ROADMAP/HANDOFF
- 修正文档中的 tool 数、测试数和 Web token 口径。

验收：

- 所有 surface 输出同一版本。
- 文档不再把未实现 tool 列为已存在。

### Phase 1 — 安全和运行骨架（1 天）

- 默认绑定 loopback。
- 实现服务端 token middleware 和 mutation Origin 检查。
- 抽取 `runWatchLoop`。
- 实现 `luoome start` 和优雅退出。

验收：

- `luoome start` 一条命令启动 Web + watch。
- 无 token 的 write/external 返回 401/403。
- 非 loopback 无 token 时拒绝启动。
- Ctrl+C 后无残留监听端口或 watch loop。

### Phase 2 — 读模型与 WatchRun（1.5 天）

- 实现 `list_trades`。
- 实现 `list_watch_triggers`。
- 实现 `WatchRun` 实体、表、双 repo、tools。
- watch workflow/runner 写每轮状态。
- 增加 dashboard/watch 聚合 API。

验收：

- 即使本轮 0 触发，也能看到最后成功心跳。
- 重启后仍能查看最近运行和触发历史。
- 新 repository 同时通过 memory/drizzle contract tests。

### Phase 3 — 分组页面（2 天）

- 新增 `#groups` 路由和导航。
- 实现列表、详情、成员、stale、刷新结果。
- 实现四类 resolver 表单。
- manual 成员使用现有股票搜索。
- 删除前先检查 pool 引用并给出可操作提示。
- 为 formula/llm 刷新增加 token 校验、进度态和失败保留旧快照提示。

验收：

- 可完成 manual/holdings/formula/llm 分组的创建、编辑、启停、刷新、删除。
- stale 动态分组一眼可见。
- LLM 刷新失败时旧成员仍显示，并明确标注失败。

### Phase 4 — 盯盘页面（2.5 天）

- 新增 `#watch` 路由和导航。
- 实现 watch health、池 CRUD、启停和规则编辑器。
- 实现最近触发表和筛选。
- 实现“立即跑一轮”。
- 规则表单显示百分比友好值（5%），提交时转换为 `0.05`。
- 明确 `cost-threshold` 只适用于 holdings 分组。

验收：

- 用户可从已有分组创建池并成功跑一轮。
- 触发记录含 reason/evidence/quote/notified。
- cooldown 抑制的触发仍可见并标记“未通知”。
- 错误 pool/group/tactic 引用在表单提交前后都有清晰反馈。

### Phase 5 — 看板与持仓收口（1.5 天）

- 重构 Dashboard 使用聚合 endpoint。
- 增加 watch 状态、stale 分组、最近触发、数据新鲜度。
- 持仓增加交易历史抽屉/详情。
- 统一 loading/empty/error/stale 四类状态。
- 统一危险操作二次确认。
- 检查多账户切换后四个页面都按当前账户刷新。

验收：

- 首页 5 秒刷新不重复并发请求、不闪烁、不泄漏 timer。
- 切账户后持仓、holdings 分组、池摘要和 dashboard 一致。
- 每次加减仓后可立即在交易历史看到对应记录。

### Phase 6 — E2E、文档与发布（1.5 天）

- 增加 Playwright 浏览器 E2E（testing fake provider + 临时 `LUOOME_HOME`）。
- 覆盖四条黄金路径：
  1. 首启 → 看板有数据。
  2. 新建/加减仓 → PnL/交易历史更新。
  3. 建 manual 分组 → 建池 → 跑一轮。
  4. 查看 trigger → 重启 → 历史仍在。
- 加 API 权限矩阵测试和非 loopback 启动测试。
- 更新 USER_GUIDE、README、ROADMAP、AGENTS。
- 形成 `docs/MVP-ACCEPTANCE.md`，记录真实验收日志。

验收：

- `typecheck`、`lint`、`build`、`test:all`、E2E 全绿。
- 新建空数据目录，从零按用户手册可在 10 分钟内跑通四条链路。
- 重启后数据、分组、池、watch run 和 triggers 保留。

## 7. 任务依赖与建议顺序

```text
安全/一键启动
      │
      ├── list_trades ──────────────► 持仓收口
      │
      ├── list_watch_triggers ──────► 盯盘页 ───► 看板
      │
      └── WatchRun/get_watch_status ─► 盯盘页 ───► 看板
                                           │
现有 StockGroup tools ───────────────────► 分组页 ─► 盯盘池配置
                                           │
                                           └──────► E2E / 发布
```

不要先做视觉大改；先让数据、权限、运行状态和用户闭环稳定，再统一样式。

## 8. 测试策略

### 单元/合约

- `WatchRun` entity invariants。
- memory/drizzle repository contract。
- `list_trades`、`list_watch_triggers`、`get_watch_status` tool。
- watch 成功、0 触发、部分失败、完全失败、cooldown。
- group/pool 跨实体约束。

### Web API

- dashboard 聚合正常/部分失败降级。
- groups/pools/triggers 分页和过滤。
- run-once 成功/失败/并发点击。
- read/write/external/trade 权限矩阵。
- token、Origin、loopback/non-loopback。

### 浏览器 E2E

- 表单字段转换和错误提示。
- modal/confirm/取消。
- 账户切换。
- stale/failed/empty/loading 状态。
- 页面刷新后状态保持。

### 手工冒烟

- testing fake：确定性完成全部黄金路径。
- real：仅验证 A 股 1–2 只股票行情和 watch 单轮，不作为 CI 强依赖。
- LLM：真实 provider 手工验证 1 个 llm 分组；失败路径也必须验证。

## 9. 发布门槛

只有全部满足才算“完整可用 MVP”：

- 一条命令启动日常使用环境。
- 四个核心页面都能独立完成对应任务。
- 任何写操作可追溯；持仓有 trade，watch 有 run/trigger。
- 没有真实下单能力。
- 默认只监听本机；服务端真实校验写操作 token。
- 动态分组失败不清空旧成员。
- watch 无触发时仍能证明它在正常运行。
- 空库首次启动、正常重启、异常失败都有可理解的 UI。
- 自动化质量闸口与四条浏览器黄金路径全绿。
- 文档、版本号和运行时输出一致。

## 10. 工期与交付建议

单人全职估算：**10–11 个工程日**。

| 阶段 | 估算 |
|---|---:|
| Phase 0 契约/版本 | 0.5 天 |
| Phase 1 安全/一键启动 | 1 天 |
| Phase 2 读模型/WatchRun | 1.5 天 |
| Phase 3 分组页 | 2 天 |
| Phase 4 盯盘页 | 2.5 天 |
| Phase 5 看板/持仓收口 | 1.5 天 |
| Phase 6 E2E/发布 | 1.5 天 |

建议按 3 个可演示里程碑交付：

1. **M1（第 3 天）**：一键启动、安全、watch 可观测。
2. **M2（第 7 天）**：分组与盯盘页面完整可用。
3. **M3（第 10–11 天）**：看板/持仓收口、E2E、文档和 `v0.8.0` 发布候选。

## 11. 首批实现文件清单

预计新增/修改的主要位置：

- `packages/core/src/entity/`：`watch-run.ts`
- `packages/core/src/repository/index.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/client.ts`
- `packages/db/src/repository/{memory,drizzle}/`
- `packages/tools/src/tools/`：
  - `list-trades.ts`
  - `list-watch-triggers.ts`
  - `record-watch-run.ts`
  - `get-watch-status.ts`
- `packages/tools/src/registry.ts`
- `packages/workflows/src/intraday-watch.ts`
- `packages/cli/src/watch.ts` / 新的 watch runner
- `packages/cli/src/index.ts`
- `apps/web/src/server.ts`
- `apps/web/public/index.html`
- `apps/web/public/js/app.js`
- `apps/web/public/js/pages.js`
- 新增 `groups-actions.js`、`watch-actions.js`
- `apps/web/public/style.css`
- Web/API/tool/repository/E2E 测试
- README、USER_GUIDE、ROADMAP、AGENTS、版本元数据

## 12. 开工顺序

第一批开发建议只开下面 5 个任务：

1. Web 安全基线 + `luoome start`。
2. `WatchRun` + `get_watch_status`。
3. `list_watch_triggers` + watch 聚合 API。
4. `list_trades` + 持仓交易历史。
5. 分组页面只读版。

这五项完成后先做一次演示，再进入分组写操作和完整盯盘配置，能最早暴露数据契约与交互上的问题。
