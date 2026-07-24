# 股票分组设计：StockGroup + 成员快照 + 动态 resolver

> 状态：**已实现**（2026-07-22 定稿并落地：StockGroup + 成员快照 + 7 个分组 tool + `refresh-groups` workflow + watch 每日刷新接线 + 存量数据迁移）。本文档是分组设计的唯一事实来源；实现与本文有出入处以代码为准，并在本文追记。
> 前置文档：[intraday-watch-design.md](./intraday-watch-design.md)（股票池 + watch，已实现）。本设计在其上做一次概念升级：**分组与盯盘解耦**。

## 目标

把"股票分组"从盯盘池里拆出来，成为独立的一等概念。分组只回答"成员是谁"，可复用到盯盘之外的场景（批量分析、报告、喂给其它 tool）。成员来源分四种形态：

| 形态 | resolver | 说明 | 状态 |
|---|---|---|---|
| A 手动分组 | `manual` | 手动维护股票列表（如"半导体"板块） | 本期 |
| B 公式动态分组 | `formula` | 复用战法 DSL，每日重算成员（类同花顺动态分组） | 本期 |
| C 量化策略分组 | `strategy` | 量化策略产出成员 | **预留 kind，不实现** |
| D LLM 提示词分组 | `llm` | LLM 按提示词每日产出成员（龙头战法、一进二等） | 本期 |

## 已确认决策（2026-07-22）

- **分组与盯盘解耦**：`StockGroup`（成员）与 `StockPool`（盯盘规则）拆成两个实体，pool 通过 `groupId` 引用 group
- **B 的公式引擎复用战法 DSL**：不另起基本面筛选 DSL；`run_tactic(scope='all-stocks')` 即全市场扫描能力
- **D 走"低频生产者 + 快照"**：LLM 每日（盘外）产出 stockIds 写快照，**盘中 watch 只读快照，resolver 永不进 hot path**。LLM 的成本、延迟、不确定性全部隔离在盘外
- **所有动态分组统一为"生产者 + 快照"模型**：B/D 只剩 resolver 不同，刷新、落库、消费机制完全一致
- **命名**：分组 = `StockGroup`；产品层称“盯盘方案（WatchPlan）”，代码与存储层暂时沿用
  `StockPool` 以兼容已有 API 和数据
- **LLM resolver 上下文先最小方案**：全市场股票列表 + 当日行情快照；战法信号等富化上下文后续按需扩
- **成员快照必须持久化**：成员变化历史可审计、可复盘（"龙头池上次选得准不准"）

## 设计

### 1. core：`StockGroup` 实体（`packages/core/src/entity/stock-group.ts`，新建）

```ts
// 成员解析器（discriminated union on `kind`）
type GroupResolver =
  | { kind: 'manual'; stockIds: readonly string[] }                     // A
  | { kind: 'holdings'; accountId: string }                             // 活视图，无快照
  | { kind: 'formula'; tacticId: string; lookbackDays: number; minScore?: number }  // B
  | { kind: 'llm'; prompt: string; maxMembers?: number; model?: string }            // D
  // | { kind: 'strategy'; ... }                                         // C，预留不实现

interface StockGroup {
  id: string;                  // slug，kebab-case（与 pool/战法一致）
  name: string;
  description?: string;
  resolver: GroupResolver;
  refreshPolicy: 'daily' | 'manual';   // 默认 daily；manual 分组无意义但保留统一
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// 成员快照（一次刷新 = 一批，同一 refreshId）
interface GroupMemberSnapshot {
  id: string;                  // uuid
  groupId: string;
  stockId: string;
  refreshId: string;           // 同一批刷新共享；当前成员 = 最新 refreshId 那一批
  reason: string;              // 进入理由：formula=信号分数说明，llm=模型 rationale
  createdAt: Date;
}
```

- Zod schema + `assertStockGroupInvariants`：
  - id slug / name 长度 / updatedAt ≥ createdAt（与 StockPool 对齐）
  - `formula.tacticId` 引用必须存在（tool 层校验，同 create_stock_pool 现状）
  - `llm.prompt` 1-2000 字符；`maxMembers` ∈ [1, 100]，缺省 20
- **当前成员语义**：`holdings` resolver 无快照，查询时现算（它本来就是活视图）；其余取最新 refreshId 批次
- 快照**只增不改**：历史批次保留，支撑复盘与成员变化检测

### 2. core：Repository 接口扩展

- `StockGroupRepository { save, findById, list(enabledOnly?), remove }`
- `GroupMemberRepository { saveBatch(snapshots), currentMembers(groupId), listHistory(groupId, since?), latestRefreshId(groupId) }`
- `RepositoryRegistry` 加 `stockGroup` + `groupMember`
- `StockPool.source` 字段替换为 `groupId: string`（见 §5 迁移）

### 3. db：新表 + StockPool 改列

- `stockGroups` 表：id / name / description / resolver（text JSON）/ refreshPolicy / enabled / createdAt / updatedAt；索引 `stock_groups_enabled_idx on (enabled)`
- `groupMemberSnapshots` 表：id / groupId / stockId / refreshId / reason / createdAt；索引：
  - `group_members_group_refresh_idx on (groupId, refreshId)`（查当前成员）
  - `group_members_group_ts_idx on (groupId, createdAt)`（历史/复盘）
- `stockPools` 表：增 `groupId` 列；旧 `source` 列迁移后废弃（启动时迁移逻辑见 §5）
- 双实现（drizzle + memory）+ contract tests + `ensureSchema` DDL 同步（沿用 v1 迁移形态）

### 4. workflows：`refresh-groups`（新建，盘外执行）

单轮刷新所有 enabled 动态分组（也可按 groupIds 指定子集）：

- input：`{ groupIds?: readonly string[] }`
- steps：
  1. 加载 enabled 且 resolver ∈ {formula, llm} 的分组
  2. 逐组刷新：
     - `formula` → `run_tactic(scope='all-stocks', persistSignals=true, lookbackDays)`；命中且 score ≥ minScore（缺省 60）→ 写新批次，reason = `战法 <id> 命中，score=<n>`
     - `llm` → 新 tool `resolve_llm_group`（见 §6）：prompt + 最小上下文（全市场股票列表 + 当日行情快照）→ LLM 输出 stockIds + rationale → 逐条 `search_stocks` 校验存在 → 截断到 maxMembers → 写新批次
     - **llm 失败（llm_error / 输出校验失败）→ 保留旧快照 + 记录 stale，绝不清空**
  3. 成员变化检测：对比新旧批次，输出 `entered / exited` 列表（供通知与未来的 membership-change 规则）
- output：`{ refreshed, failed, staleGroups, entered, exited }`
- 触发时机：`luoome watch` 启动时 + 每日首个交易轮次前；也可手动 `luoome tools call refresh_stock_group`

### 5. StockPool 演化 + 迁移

- `StockPool`：`source: PoolSource` 替换为 `groupId: string`；rules / cooldown / enabled 不动
- 成员解析改为：`repos.groupMember.currentMembers(groupId)`（holdings 组现算）
- 启动时一次性迁移存量 `stock_pools` 行：
  - `source.kind='manual'` → 建 manual 分组（id=`<poolId>-group`）+ 改写 pool.groupId
  - `source.kind='holdings'` → 建 holdings 分组
  - `source.kind='tactic'` → 建 formula 分组（tacticId/lookbackDays/minScore 平移），并立即跑一次刷新落首批快照
  - 迁移幂等：已含 groupId 的行跳过
- 不变量修订：解除旧的 tactic ID 强耦合。formula resolver 的战法负责“筛出成员”，方案中的
  tactic 规则负责“盘中何时触发”，两者可引用不同战法

### 6. tools 变化

| tool | sideEffect | 说明 |
|---|---|---|
| `list_stock_groups` | read | 列分组（可带当前成员数） |
| `get_stock_group` | read | 分组详情 + 当前成员 + 最近 refresh 时间/stale 标记 |
| `list_watch_plans` | read | 盯盘方案 + 引用分组 + 成员数 + ready/stale/empty/disabled/missing 状态 |
| `create_stock_group` | write | 校验 resolver 引用（tactic/account 存在）→ 落库 |
| `update_stock_group` | write | 改 resolver / refreshPolicy / enabled / name |
| `delete_stock_group` | write | 删除；有 pool 引用时拒绝（invariant_violation，提示先解绑） |
| `refresh_stock_group` | external | 手动触发单组刷新（调 LLM，归 external） |
| `resolve_llm_group` | advice | workflow 内部通道：LLM 产出成员（不直接暴露给 agent 日常使用） |

- 现有 pool 5 tool 保留；`create_stock_pool` / `update_stock_pool` 输入 `source` 改 `groupId`
- `WorkflowToolMap` 同步补类型映射

### 7. watch 主链路改动（小）

- `intraday-watch` step 1 前插入「daily 刷新检查」：今日尚未跑过 `refresh-groups` 且有 daily 动态分组 → 先跑一轮
- step 3 成员解析改为读快照（holdings 组除外）
- tactic 规则的盘中评估逻辑不变（`persistSignals=false`）

### 8. 文档同步

- `AGENTS.md`：工具清单加 7 个 group tool；已知边界加分组条目
- `ARCHITECTURE.md`：§5.1 加 StockGroup / GroupMemberSnapshot；§8.1 加 `refresh-groups`

## 可选二期（写入但不实施）

- **Web 对话创建分组**：见 [web-chat-design.md](./web-chat-design.md)（2026-07-22 定稿，待实现）；draft schema = `create_stock_group` 的 input schema，两份设计可并行开发
- **`membership-change` 规则**：分组成员进出本身作为 watch trigger（「龙头池新进了 X」direction=watch/buy）。快照机制落地后几乎零成本
- **LLM resolver 富化上下文**：当日战法命中信号、分组历史成员表现（接 watch_triggers / adviceOutcomes 复盘）
- **strategy resolver（C）**：等真实回测/因子需求出现再立项，接口预留
- **板块一键导入**：manual 分组从行业成分股批量填充

## 明确不做（本期）

- 不做 strategy resolver 实现（仅占位）
- 不做盘中 resolver 触发（任何动态刷新都在盘外；hot path 只读快照）
- 不做 LLM 输出未校验直接入库（必须逐条 `search_stocks` 验证）
- 不做快照清理策略（历史批次全保留；数据量出问题再加 retention）
- 不做基本面筛选 DSL（复用战法 DSL，基本面筛选等真实需求驱动）

## 已知边界

- LLM 分组天然非确定：同一 prompt 两次刷新成员可能不同。靠快照 + reason 落库保证可审计，不保证可复现
- `holdings` resolver 无快照 → 成员变化检测对它不适用（持仓变化本身有 trades 表记录）
- 全市场股票列表 + 行情快照的 prompt 体积受限于 stocks 表规模；实现取 `MAX_CANDIDATES=200` 截断（`packages/tools/src/tools/resolve-llm-group.ts`），后续可按市场/流动性细化
- 动态分组刷新失败标 stale 后，watch 继续用旧快照盯盘；Web 通过 `list_watch_plans` 直接展示
  stale 状态。分组被显式停用后不再读取旧成员

## 实现追记（2026-07-22）

- **stale 为纯计算而非存储**：`stale = refreshPolicy='daily' 且 resolver∈{formula,llm} 且 (无刷新记录 或 最近刷新日期(Asia/Shanghai) < 今日)`，由 `get_stock_group` 现算，未引入新存储
- **刷新空结果一律不写空批**：formula 零命中 / llm 产出全被校验丢弃时，与失败同等处理（计入 failed、保留旧快照）——比 §4 最低要求更保守，防止"一次上游抖动清空分组"
- **前置 bug 修正**：`StockRepository.search('')` 从返回空改为返回全部（id 升序）。run_tactic `scope='all-stocks'` 与 formula 全市场刷新依赖此语义；契约测试双实现同步覆盖
- **watch 每日刷新**：`intraday-watch` step 0 按 Shanghai 日期做进程内 flag，每日首轮前自动跑 `refresh-groups`；失败也记 flag（防 60s 轮次重复 LLM 成本）
- **迁移**：`migrateLegacyPoolSourcesToGroups` 在 `ensureSchema` 末尾幂等执行；tactic 源迁移后 console.warn 提示手动跑一次 `refresh_stock_group`（db 层拿不到 LLM/tool）
