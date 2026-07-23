# Backlog — 一致性 & 工程债

> 来源：2026-07-22 全仓代码走查（packages/\* + apps/web + 文档）。
> 功能演进 backlog 见 [HANDOFF.md](./HANDOFF.md) §9；本清单只收「文档与实现不一致 / 测试盲区 / 代码债」。
> 每条附定位，按优先级排序；修完一条删一条。

## P1 — 文档与实现不符（会误导使用者）

1. **AGENTS.md 工具清单超前于实现**
   - 清单列了 `compute_pnl` / `compute_risk_metrics` / `list_notes` / `list_alerts` / `set_alert` / `delete_alert` / `get_quote` / `generate_report` / `update_config` 等**不存在**的 tool；`batch_quote` 归为查询类（read）实为 `external`。
   - 实际 32 个 tool（read 16 / advice 3 / write 9 / external 4），以 `luoome tools list --json` 为准——清单自己也这么声明，但静态表格依然误导。
   - 建议：按运行时输出重写工具清单，或删掉静态表格只留 `luoome tools list` 指引。

2. ~~**apps/web 零测试 + 依赖声明缺失**~~ ✅ 已修（v0.8：`package.json` 补声明 `@luoome/adapters` / `@luoome/db`；新增 `server.test.ts` 闸口矩阵 9 例，`bun run test:web` 执行并纳入 `test:all`）

3. **MCP 与 CLI 时钟口径分叉**
   - `packages/mcp/src/context.ts` 业务时钟固定 mock 锚点（2026-07-17，注释自称 v0.1），CLI / TUI / Web 用真实时钟；同一 `get_advice`（默认过滤过期）在 MCP 与 CLI 下结果可能不同。

4. **tools 包桶导出漏 4 个 write tool**
   - `packages/tools/src/index.ts` 未导出 `add-holding` / `add-trade` / `close-holding` / `update-holding`，头注释仍写「13 个 tool」；`packages/tools/package.json` description 仍写「8 个 v0.1 tool」。

## P2 — 测试盲区 / 硬编码

5. **workflows 三个无测试**：`tactic-scan` / `risk-report` / `daily-review`；且 `risk-report` 的 VaR 是 mock 固定值（2% × 总市值），`sync-quotes` 用 `new Date()` 而非 `ctx.clock()`。
6. **版本号三处口径互相对不上**：CLI `VERSION = '0.1.0'`（`packages/cli/src/index.ts`）、MCP serverInfo 同、homebrew formula test 断言 `0.5.x`——而实际已 v0.6.2。
7. **MCP smoke 硬编码 17 tool**：`packages/mcp/src/smoke.ts` 新增 read/advice tool 会脆断；smoke 无 CI / script 挂载，只能手跑。
8. **db DDL 与 Drizzle schema 双份手写**：`ensureSchema` 编程式 DDL 与 `schema/index.ts` 靠纪律同步（唯一索引 / 复合主键两处都有），漂移风险，代码注释自认应被 migrate 取代；`createDrizzleRepos` docstring 残留「5 个 repository」（实际 11）。
9. **Web 鉴权是装饰**：前端 `api.js` 附 `Bearer token`，服务端无鉴权中间件；多账户切换是 `ctxRef.current` 内存 mutate（单进程单 tab 假设；监听非 localhost 时需注意暴露面）。

## P3 — 代码气味（不阻塞）

10. `intraday-watch`：trigger id 用 `Math.random()`（不可复现）；`stepLoadPrevCloses` 里 `catch {}` 静默吞错；evidence 缺 prevClose 来源标注（与 HANDOFF §9.5 重叠）。
11. TUI `app.ts` 1007 行单文件；RESIZE handler 里 `overlay.height` 连续赋值两次（第一行死代码）；`CalibrationView` 类型定义在文件末尾却在中间使用。
12. core：`V0_2_SUPPORTED_MARKETS` 命名陈旧（v0.5 已支持 US）；`assertExpressionSafety` 抛普通 Error 而非 `InvariantError` / `DslEvalError`。
13. adapters：`package.json` 声明 `drizzle-orm` 依赖但 src 未使用；`eastmoney.ts` / `openai-compatible.ts` 尾部重复 re-export 与桶导出冗余；`workflows/package.json` description 仍写「v0.1 仅骨架」。
14. 代码注释 / package.json description 里约 15 处「plan.md 跨包契约」仍按根目录命名引用（文件已迁 `docs/plan.md`）；`docs/MVP-TASK.md` 内的 `~/project/luoome/*.md` 路径为历史快照，未改。
15. `run-tactic.ts` 有 `const c: ToolContext = ctx` 的 narrow-cast 痕迹；`intraday-watch.ts` 两处用条件类型体操推断 ctx 类型，应直接 import `WorkflowContext`。

---

修 P1 时优先 1 / 4（纯文档 + 导出，零风险）；2 / 3 涉及行为语义，先开 issue 讨论口径。
