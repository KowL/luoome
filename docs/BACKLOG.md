# Backlog — 一致性 & 工程债

> 来源：2026-07-22 全仓代码走查（packages/\* + apps/web + 文档）。
> 功能演进见 [ROADMAP.md](./ROADMAP.md)；本清单只收「文档与实现不一致 / 测试盲区 / 代码债」。
> 每条附定位，按优先级排序；修完一条删一条。

## P1 — 文档与实现不符（会误导使用者）

1. ~~**AGENTS.md 静态工具清单超前于实现**~~ ✅ 已修（根 AGENTS 改为编码 Agent 开发规范；外部 luoome Skill 通过 MCP discovery 与 `luoome tools list --json` 获取运行时工具库存，不再维护完整静态表）

2. ~~**apps/web 零测试 + 依赖声明缺失**~~ ✅ 已修（v0.8：`package.json` 补声明 `@luoome/adapters` / `@luoome/db`；新增 `server.test.ts` 闸口矩阵 9 例，`bun run test:web` 执行并纳入 `test:all`）

3. ~~**MCP 与 CLI 时钟口径分叉**~~ ✅ 已修：`packages/mcp/src/context.ts` 与 CLI / Web 一样使用真实系统时钟；测试与运行时不再固定 2026-07-17 锚点。

4. ~~**tools 包桶导出漏 4 个 write tool**~~ ✅ 已修：`packages/tools/src/index.ts` 已导出
   `add-holding` / `add-trade` / `close-holding` / `update-holding`，包描述也改为运行时 registry/discovery 口径。

## P2 — 测试盲区 / 硬编码

5. ~~**风险工作流测试与固定 VaR**~~ ✅ 已修：`run-strategies` / `daily-review` / `risk-report` 均有测试，
   `sync-quotes` 使用 `ctx.clock()`；`risk-report` 改用 `get_account_performance` 的真实历史 TWR
   收益计算 95% 历史 VaR，历史事实不足时明确返回 unavailable，不再固定 2%。
6. ~~**版本号三处口径互相对不上**~~ ✅ 已修：CLI 与 MCP serverInfo 当前统一为 `0.9.0`，Homebrew formula 与 smoke 断言同步为 `0.9.0`；各 workspace package version 仍作为内部包版本，不冒充产品 release。
7. ~~**MCP smoke 硬编码 17 tool**~~ ✅ 已修：`packages/mcp/src/smoke.ts` 按运行时 registry 与
   exposure policy 计算默认暴露集合，不再固定数量；新增 `bun run mcp:smoke` 与
   `bun --cwd packages/mcp run smoke` 入口，仍保留真实 stdio/SQLite 握手验收。
8. **db DDL 与 Drizzle schema 双份手写**（部分收口）：`ensureSchema` 编程式 DDL 与
   `schema/index.ts` 仍需手工同步，完整迁移生成仍待后续；已补 39 张表的启动契约测试，逐表
   校验实际 SQLite 列和显式索引名称，schema drift 现在会在测试中直接失败。2026-11-12 又新增了
   存储形态重建（signal_observations / signal 主键 / results_json），这些迁移只有手写实现。
9. **Web 暴露面仍需收敛**（部分收口）：浏览器账户选择已通过
   `X-Luoome-Account-Id` + request-scoped context 隔离不同 tab，不再依赖共享账户 mutate；无 header 的
   本地调用仍兼容默认账户。Web 仍不做账户级鉴权，监听非 localhost 时必须由部署侧提供网络隔离或
   后续产品决策的认证层。

## P3 — 代码气味（不阻塞）

10. `intraday-watch`：~~trigger id 用 `Math.random()`（不可复现）~~ ✅ 已改用 `crypto.randomUUID()`；~~昨收加载失败静默吞错~~ ✅ 保留可定位 warning；~~evidence 缺 prevClose 来源标注~~ ✅ `price-change` evidence 明确记录 `prevCloseSource=bar`。
11. core：~~`V0_2_SUPPORTED_MARKETS` 命名陈旧~~ ✅ 已统一为当前语义的 `SUPPORTED_MARKETS`；~~`assertExpressionSafety` 抛普通 Error~~ ✅ 已修为可识别的 `DslEvalError`，并补回归测试。
12. adapters：~~`package.json` 声明 `drizzle-orm` 依赖但 src 未使用~~ ✅ 已移除直接依赖；`eastmoney.ts` / `openai-compatible.ts` 尾部重复 re-export 与桶导出冗余；~~`workflows/package.json` description 仍写「v0.1 仅骨架」~~ ✅ 已更新为当前 workflow 范围。
13. ~~`intraday-watch.ts` 两处用条件类型体操推断 ctx 类型~~ ✅ 已统一直接使用 `WorkflowContext`。
14. ~~**workflow 26→12 合并未完成**~~ ✅ 已收敛到 12 个注册入口（2026-11-13）：
   `report`、`strategy`、`sync-market` 三个多模式入口 + 9 个专用入口；其余管线改为
   `defineOperation`，由 `architecture.test.ts` 守住数量与审计名。
16. ~~**`signal_observations` 归属未拍板**~~ ✅ 已拍板（2026-11-13）：保留独立表 + 自然键
   `(source_kind, source_id, horizon)`。`watch-trigger` 观察没有对应 `strategy_signals` 行，
   合并会让观察无处存放；存储主因（长 id 与 source_id 复制）已由 64 位信号 id 和自然键主键消除。
   决策记录见收敛设计 §6。
17. **文档状态仍靠人工同步**：已裁撤能力的 DDD/PRD 目前用文首横幅标注，尚未移入 `archive/`；
   下次整理文档时应连同 `docs/README.md` 导航一起归档，避免“已删除能力仍像现行设计”。

---

修 P1 时优先 1 / 4（纯文档 + 导出，零风险）；2 / 3 涉及行为语义，先开 issue 讨论口径。
