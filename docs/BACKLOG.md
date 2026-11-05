# Backlog — 一致性 & 工程债

> 2026-11-04 文档清理后重写：只保留**当前仍存在**的条目。已修复项直接删除，不再留「✅ 已修」历史。
> 来源：本次全仓文档 ↔ 代码核对（实体关系图、工具库存、PRD/DDD 清理）。
> 功能演进见 [ROADMAP.md](./ROADMAP.md)；本清单只收「文档与实现不一致 / 测试盲区 / 代码债」。
> 每条附定位，按优先级排序；修完一条删一条。

## P1 — 文档与实现不符（会误导使用者）

1. **`output/dsh-brainstorm/...` 引用不存在的路径**
   [ARCHITECTURE.md](./ARCHITECTURE.md) §11.1 让读者去看
   `output/dsh-brainstorm/review/t25-same-semantics-two-impls.md`，但仓库里没有 `output/` 目录。
   要么把该清单合并进本节，要么删掉指针。

2. **`quote_snapshot` 与物理表 `price_snapshots` 命名不一致**
   物理表是 `price_snapshots`（`packages/db/src/migrations.ts:649`，唯一键
   `(stock_id, observed_at, source)`），但 tool description 与注释仍写 `quote_snapshot`：
   `packages/tools/src/tools/sync-quotes.ts:25`、`packages/tools/src/tools/batch-quote.test.ts:26`。
   tool description 会原样进入模型上下文，属于对外表述错误。**改 description 时同步
   [TOOL-INVENTORY.md](./TOOL-INVENTORY.md) 的对应行。**

3. **源码注释指向已删除的设计文档**
   - `packages/tools/src/agent/scenarios.ts:2` → `docs/ddd/agent-collaboration-phase0-1-detailed-design.md`（已删）
   - `packages/core/src/types/side-effect.ts:6` → `docs/ddd/luoome-dsh-transformation-detailed-design.md`（已删）
   - `packages/dsh-luoome/src/host/discipline.ts:1` → 同上（已删，且 `:131` 行号失效）
   注释不是运行时代码，但会把后来者引到空文件。

4. **`registry.ts` 的头部注释与库存规模脱节**
   `packages/tools/src/registry.ts:367` 仍写「v0.1 全量工具表：6 read + 2 advice」，
   实际是 234 项。注释里的数字不会再有人对账，建议改成「以 registry 自身为准」的表述。

5. **ROADMAP 早期章节仍把已下线能力写成已交付**
   [ROADMAP.md](./ROADMAP.md) v0.8 以前章节自称历史快照，但正文有「✅ 真实 LLM 接线」、
   `apps/web` 路径、`luoome tui` 等当前已不存在的内容。要么整段移入 `archive/`，要么在章首
   统一加「本段描述已下线形态」的说明。

6. **SECURITY.md 的 MCP 实例段落仍有正文口径**
   [SECURITY.md](./SECURITY.md) 已标注「已删除（REQ-M2-03）」，但分析面/profile 段落
   （`LUOOME_MCP_SERVER_NAME` 等）仍按旧四实例描述。保留历史可以，但需要与「当前只有插件面」
   的结论放在同一段里，避免读者只读到前半。

## P2 — 文档守卫与结构

7. **新文档的统计无人守**
   `bun run check:docs` 只校验 PRD 附录 A 的 registry 工具数与 `asOf`。
   [TOOL-INVENTORY.md](./TOOL-INVENTORY.md)（234 项、sideEffect 分布）与
   [ENTITY-MAP.md](./ENTITY-MAP.md)（实体/表数量）都是会腐烂的数字，目前只靠人工同步。
   建议把这两份也纳入 `infra/check-docs.ts`，或改成构建期生成。

8. **ARCHITECTURE §16 仍保留整段旧单机 Web 认证设计**
   [ARCHITECTURE.md](./ARCHITECTURE.md) §16 后半段（认证传输、Origin、CSRF、登录页、
   租户隔离）描述的是已删除的 `apps/web`。已有「不要按下文改代码」的护栏，但放在当前架构
   文档里容易被误读；建议移入 `docs/archive/`。

9. **ARCHITECTURE 其余章节的“Web”口径待逐段核对**
   适配器与上下文章节仍有「多 Web 实例」「Web 有独立 tick」「Web 额外提供 `/api/settings/market`」
   等表述（旧 Web 已删除）。这些句子不致命，但会让读者以为还有 Web 进程。

10. **工作树残留空壳目录**
    `packages/{cli,mcp,tui,dsh-bridge}`、`apps/{web,worker,agent-runtime}`、`packages/adshare-sdk`
    只剩 gitignore 的 `dist/`、`node_modules/`，`git ls-files` 为空。可安全删除，避免
    `ls packages` 与 typecheck 循环产生误导。

## P3 — 代码债（与文档无关，核对时发现）

11. **`RiskVeto` 已接线但没有写入方**
    schema、drizzle + memory 实现、contract/guard 测试俱全，但没有任何 tool/workflow 调用
    `repos.riskVeto`。要么补写入点，要么在设计上明确「只读审计」的定位。

12. **`triangle-roles.ts` 是孤儿实体**
    `packages/core/src/entity/triangle-roles.ts` 有 schema 与 guard test，但从 core index 导出后
    **全仓无 tools/workflows/repository 消费方**（`triangle-gate.ts` 是另一个概念）。

13. **`advice_outcomes` 表的定位需要一次写清**
    `record_advice_outcome` 只写 DecisionReview，不再双写旧 `advice_outcomes` 表；该表仅存量与审计。
    代码注释已说明，但缺一个「旧表不再增长」的显式测试或迁移说明。
