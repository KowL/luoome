# LUOOME 领域收敛、去冗余与架构减负详细设计

> **状态**：已执行（2026-11-10）。S1.1–S1.3、S2.1–S2.3、S3.1–S3.3、S4 全部落地并通过门禁（typecheck / lint / test / test:db / test:web 绿；仅既有 flaky DSH 集成用例在全量并发下超时、隔离通过）。结果：表 73→38、注册 Tool 152→34、`apps/web/src/server.ts` 3,040→399 行、手写 memory Repository 31→0。未完成项：`signal_observations` 并入 `strategy_signals`（§6 剩余）、workflow 26→12 的进一步合并、`daily_bar_revisions` 保留（strict backtest v2/replay 的 PIT 依赖，与 §6 结论不同）。
> **日期**：2026-11-10
> **前置文档**：[AI Investment OS + DSH 转型详细设计](./luoome-dsh-transformation-detailed-design.md)
> **目标**：在完成 M1（移除多租户 `hosted` 体系，净删 45,285 行代码）的基础上，对单机版代码库进行深度的**领域去重、超前功能裁剪、基础设施减负与 Agent Tool 收敛**，将系统从“堆叠了 7 个历史阶段概念的膨胀单体”收敛为“围绕 DeepSeek Harness 的精悍投研内核”。

---

## 1. 背景与现状量化诊断

### 1.1 当前代码库规模快照（M1 多租户清理后）

| 维度 | 当前数量 | 诊断结论 |
|---|---|---|
| **SQLite 数据表**（[`packages/db/src/schema/index.ts`](../../packages/db/src/schema/index.ts)） | **73 张表** | 约 **35 张表**属于重复建模、超前无源模块或单机无需的分布式锁/审计快照表 |
| **持久化 Repository**（[`packages/core/src/repository/index.ts`](../../packages/core/src/repository/index.ts)） | **31 个** | 每个 Repository 需同步维护接口、Drizzle schema、`ensureSchema` 原生 DDL、Drizzle 实现、Memory 实现与 Contract Tests（**五重维护税**） |
| **注册 Tool 总数**（[`packages/tools/src/registry.ts`](../../packages/tools/src/registry.ts)） | **152 个** | 超过 **110 个 Tool** 是细粒度 UI 表单 CRUD、内部租约续期或低频审计查询，严重稀释 LLM 工具选择准确率并浪费上下文 Token |
| **内置 Workflow**（[`packages/workflows/src/index.ts`](../../packages/workflows/src/index.ts)） | **26 个** | 盘中盯盘、策略日切、报告生成存在多套同构流水线 |
| **单文件巨石** | `pages.js` (4,124 行)<br>`server.ts` (3,569 行)<br>`strategy-workspace-experiment.js` (2,671 行)<br>`client.ts` (2,165 行) | 单文件承载过多历史实验特性，认知与修改成本极高 |

### 1.2 核心病灶归类

```mermaid
flowchart TD
    subgraph 病灶一：同义领域多重建模
        D1["研究结论四重建模<br/>Advice / Report / InvestmentWorkspace / ResearchVault"]
        D2["盘中盯盘双引擎<br/>AlertPlan (intraday-watch) vs TradingPlan (intraday-trading-plan-watch)"]
        D3["复盘校准三重子域<br/>AdviceOutcome / DecisionReview(4表版本链) / SignalObservation"]
        D4["Agent 运行时双轨制<br/>DeepSeek Harness vs 旧版自研 agent-runtime.ts"]
    end

    subgraph 病灶二：超前开发与无源空转
        P1["基本面评分管线 (4张表 + 1,294行因子)<br/>仅存在 Mock 适配器，生产常年 unavailable"]
        P2["公司事件体系 (stock_events + 5 Tools)<br/>无任何外部事件数据源实现"]
        P3["策略子域 7 层概念堆叠 (16张表 + 48 Tools)<br/>周度自治审批、逐日断点会话、可移植签名包、自适应性格评估"]
        P4["本地重型 RAG + Git 同步器 (9张表 + 19 Tools)<br/>手写分块向量表、召回率评测与 Git 冲突管理"]
    end

    subgraph 病灶三：架构偶然复杂性
        A1["五重存储税<br/>手写 31 个纯内存 Map Repository (~6,500行)"]
        A2["ToolContext 顶层属性失控<br/>15 个外部数据源散落在 Context 根属性"]
        A3["152 个公共 Tool 淹没 Agent<br/>内部 CRUD 与 Agent 推理能力混装"]
    end
```

### 1.3 收敛量化目标

| 指标 | 当前值 | 目标值 | 精简幅度 |
|---|---|---|---|
| **SQLite 数据表** | 73 张 | **38 张** | **-48%**（裁撤/合并 35 张表） |
| **手写 Memory Repository** | 31 个（~6,500 行） | **0 个**（统一用 `bun:sqlite` `:memory:`） | **-100%** |
| **公共注册 Agent Tool** | 152 个 | **34 个** | **-78%**（砍除/内聚下沉 118 个 Tool） |
| **Workflow 数量** | 26 个 | **12 个** | **-54%** |
| **全库净代码量** | ~160,000 行 | **~125,000 行** | **净删 ~35,000 行** |

---

## 2. 架构基础设施减负详细设计（Phase S1：零业务功能损失）

### 2.1 用 SQLite `:memory:` 替代手写 `packages/db/src/repository/memory/*`

#### 2.1.1 现状问题
在 [`packages/db/src/repository/memory/`](../../packages/db/src/repository/memory/index.ts) 下手写了 31 个纯内存 Repository（共约 6,500 行代码），在 JS `Map` 和数组上用命令式代码模拟 SQLite 的事务回滚、唯一索引冲突、级联删除、游标分页、甚至余弦相似度检索。
这不仅导致每次修改 Repository 接口都要双写两遍逻辑，而且 JS 模拟逻辑与真实 SQLite 行为常有微妙偏差。

#### 2.1.2 目标方案
`bun:sqlite` 原生支持内存数据库 `new Database(':memory:')`，单次建库 + `ensureSchema()` 耗时仅 **1.5 ~ 3ms**。
将 [`packages/db/src/memory.ts`](../../packages/db/src/memory.ts) 改造为直接基于 `:memory:` SQLite 实例装配 Drizzle Repository：

```ts
// packages/db/src/memory.ts
import { createDatabase, type LuoomeDatabase } from './client.js';
import { createDrizzleRepositories } from './repository/drizzle/index.js';
import type { RepositoryRegistry } from '@luoome/core';

export const createMemoryRepositories = (): RepositoryRegistry => {
  const handle: LuoomeDatabase = createDatabase(':memory:');
  return createDrizzleRepositories(handle.db);
};
```

#### 2.1.3 变更文件清单
- **修改**：[`packages/db/src/memory.ts`](../../packages/db/src/memory.ts)、[`packages/db/src/index.ts`](../../packages/db/src/index.ts)
- **删除**：`packages/db/src/repository/memory/*.ts` 全部 31 个文件（保留 `createMemoryRepositories` 工厂函数签名兼容所有现有单元测试）
- **精简**：[`packages/db/src/repository/contract-tests.ts`](../../packages/db/src/repository/contract-tests.ts) 直接针对 `createDatabase(':memory:')` 运行一次，无需 `drizzle` / `memory` 双跑

---

### 2.2 退役旧版自研 Agent Loop，全面统一至 DeepSeek Harness

#### 2.2.1 现状问题
项目中同时存在两套多步工具调用运行时：
1. **新一代 DSH Runtime**：[`apps/agent-runtime`](../../apps/agent-runtime/src/host.ts) + [`packages/dsh-bridge`](../../packages/dsh-bridge/src/plugin.ts) + [`apps/web/src/dsh/chat-runtime.ts`](../../apps/web/src/dsh/chat-runtime.ts)。
2. **旧版自研 Agent Runtime**：[`packages/adapters/src/llm/agent-runtime.ts`](../../packages/adapters/src/llm/agent-runtime.ts)（391 行）+ [`packages/tools/src/tools/agent-run.ts`](../../packages/tools/src/tools/agent-run.ts) + [`apps/web/src/chat.ts`](../../apps/web/src/chat.ts) 中的 legacy 分支。

#### 2.2.2 目标方案
- **彻底删除旧版自研 Agent Loop**：
  - 删除 [`packages/adapters/src/llm/agent-runtime.ts`](../../packages/adapters/src/llm/agent-runtime.ts) 及其测试 `agent-runtime.test.ts`。
  - 删除 [`packages/tools/src/tools/agent-run.ts`](../../packages/tools/src/tools/agent-run.ts) 及其测试 `agent-run.test.ts`，从 [`registry.ts`](../../packages/tools/src/registry.ts) 移除 `agent_run`。
  - 从 [`packages/core/src/context.ts`](../../packages/core/src/context.ts) 移除 `AgentRuntimeLike`、`AgentStep`、`AgentRunInput`、`AgentRunResult` 及 `ToolContext.agent` 字段。
  - 精简 [`apps/web/src/chat.ts`](../../apps/web/src/chat.ts)：移除旧版非 DSH Agent Loop 执行分支，Web 对话 100% 走 DSH Runtime。

---

### 2.3 收敛 `ToolContext` 顶层膨胀属性

#### 2.3.1 现状问题
[`packages/core/src/context.ts`](../../packages/core/src/context.ts#L260-L329) 的 `ToolContext` 在演进中平铺了 15 个零散的可选外部适配器属性（`limitUpLadder`、`dragonTiger`、`northboundFlow`、`news`、`sectorQuote`、`ashareSentiment`、`eventProviders`、`researchVault`、`researchRemote`、`researchEmbedding`、`researchVaultGitSync`、`fundamentalData` 等）。

#### 2.3.2 目标结构
将所有外部 IO 适配器收归 `ctx.adapters` 统一命名空间，顶层 `ToolContext` 只保留 **5 个核心属性**：

```ts
export interface ToolContext {
  readonly repos: RepositoryRegistry;
  readonly adapters: {
    readonly market: MarketDataAdapterLike;
    readonly llm: LLMAdapterLike;
    readonly stockUniverse?: StockUniverseManagerLike;
    readonly notification?: NotificationManagerLike;
    readonly marketIntel?: {
      readonly limitUpLadder?: LimitUpLadderManagerLike;
      readonly dragonTiger?: DragonTigerManagerLike;
      readonly northboundFlow?: NorthboundFlowManagerLike;
      readonly news?: NewsManagerLike;
      readonly sectorQuote?: SectorQuoteManagerLike;
      readonly ashareSentiment?: AShareSentimentManagerLike;
    };
  };
  readonly user: {
    readonly id: string;
    readonly defaultAccountId: string;
  };
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly auditLog?: AuditLoggerLike;
  readonly auditCaller?: string;
  readonly abortSignal?: AbortSignal;
}
```

---

## 3. 超前与空转模块裁剪详细设计（Phase S2）

### 3.1 移除无外部数据源的 `StockEvent`（公司事件）子域

- **原因**：`ToolContext.eventProviders` 在生产环境中始终为空数组，无任何外部数据源实现，整套表、Repository、5 个 Tool 和事件评估 Workflow 处于空转状态。
- **删除清单**：
  - **Core**：`packages/core/src/entity/stock-event.ts`、`StockEventRepository` 接口、`ExternalStockEvent` / `StockEventProviderLike`。
  - **DB**：`stock_events` 表（[`schema/index.ts`](../../packages/db/src/schema/index.ts#L1709-L1751)、`client.ts` DDL）、[`packages/db/src/repository/drizzle/stock-event.ts`](../../packages/db/src/repository/drizzle/stock-event.ts)。
  - **Tools（5 个）**：`list_stock_events`、`add_stock_event`、`update_stock_event`、`delete_stock_event`、`sync_stock_events`。
  - **Workflows（2 个）**：[`packages/workflows/src/evaluate-event-rules.ts`](../../packages/workflows/src/evaluate-event-rules.ts)、[`packages/workflows/src/sync-stock-events.ts`](../../packages/workflows/src/sync-stock-events.ts)。

---

### 3.2 移除无真实财报源的 `FundamentalScore` 与 `FinancialFact` 重型管线

- **原因**：
  - [`packages/core/src/strategy/fundamental-factor.ts`](../../packages/core/src/strategy/fundamental-factor.ts)（1,294 行）与 [`packages/core/src/entity/fundamental.ts`](../../packages/core/src/entity/fundamental.ts)（425 行）构建了极其复杂的 PIT 财务修正版本链与横截面评分门禁，但 [`packages/adapters/src/fundamental/mock.ts`](../../packages/adapters/src/fundamental/mock.ts) 仅有 Mock 数据，生产环境永远返回 `unavailable`。
  - 在没有接入真实财报 API（如 Tushare 利润表/资产负债表/现金流量表）前，这套 3,500+ 行的空转抽象只会阻碍后续按真实财报结构落地。
- **删除清单**：
  - **Core**：`packages/core/src/entity/fundamental.ts`、`packages/core/src/strategy/fundamental-factor.ts` 及相关测试。
  - **DB（4 张表）**：`financial_fact_revisions`、`fundamental_score_versions`、`fundamental_score_runs`、`fundamental_score_results`，以及 `drizzle/financial-fact.ts`、`drizzle/fundamental-score.ts`。
  - **Adapters**：`packages/adapters/src/fundamental/mock.ts`。
  - **Tools（4 个）**：`get_financial_facts`、`sync_financial_facts`、`get_fundamental_score`、`run_fundamental_score`。

---

### 3.3 策略子域（`Strategy`）去泡沫：从 16 张表 / 48 个 Tool 收敛至 6 张表 / 10 个 Tool

#### 3.3.1 策略子域裁剪矩阵

| 子模块 | 当前涉及表 / 代码 | 处置决策 | 理由 |
|---|---|---|---|
| **核心策略定义与运行** | `strategies`、`strategy_versions`、`strategy_runs`、`strategy_signals` | **保留并内聚** | 将 `strategy_results` 的逐股明细合并入 `strategy_runs.summary_json` 与 `strategy_signals`，少维护一张高频大表 |
| **策略股票池订阅** | `strategy_watchlist_subscriptions` | **保留** | 连接 Strategy 与 Watchlist 的核心纽带 |
| **策略回测** | `strategy_backtest_runs` | **保留单表** | 移除冗余的 `strategy_backtest_market_facts`（回测直接读 `daily_bars`） |
| **逐日评估会话状态机** | `strategy_evaluation_sessions`<br>`strategy_evaluation_days`<br>8 个 `*_strategy_evaluation_*` Tool | **彻底移除** | 为回测造了一套需要外部手动 step-by-step 驱动的 8-Tool 状态机，极其繁琐且与 `strategy_backtest_runs` 重复 |
| **策略周度自治审批** | `strategy_autonomy_actions`<br>[`promotion.ts`](../../packages/core/src/strategy/promotion.ts)<br>[`strategy-autonomy-weekly.ts`](../../packages/workflows/src/strategy-autonomy-weekly.ts) | **彻底移除** | 个人单机系统无需“AI 自动提交策略晋升/暂停审批单 → 人工审批队列”的机构级流程 |
| **可移植策略包 Manifest** | [`portable-manifest.ts`](../../packages/core/src/strategy/portable-manifest.ts)（564 行）<br>3 个 `*_strategy_manifest` Tool | **彻底移除** | 单机系统无需跨组织策略包签名导出/导入协议 |
| **数据库分布式租约锁** | `strategy_run_leases`<br>`strategy_schedules`<br>`renew_strategy_schedule_claim` Tool | **简化为策略表字段 + 内存互斥** | 在 `strategies` 表直接保留 `schedule_cron` / `last_scheduled_at` 字段；单进程直接用内存 `Set<string>` 防重入，砍掉 2 张表和 3 个 Tool |
| **PIT 检查点拷贝表** | `strategy_data_checkpoints`<br>`strategy_data_checkpoint_members`<br>`prepare_strategy_data` Tool | **彻底移除** | 每次跑策略前把股票池成员拷贝一份到 checkpoint 表属于过度设计；`strategy_runs` 本身已记录 `input_snapshot_json` |
| **推荐预检与自适应性格** | [`recommendation-preflight.ts`](../../packages/core/src/strategy/recommendation-preflight.ts)（601 行）<br>[`local-selector.ts`](../../packages/core/src/strategy/local-selector.ts)<br>`assess_adaptive_personality` / `run_local_selector_research` | **彻底移除** | 概念玄虚、产出价值低、代码体积大 |

---

## 4. 重叠领域合并详细设计（Phase S3：同义模型合一）

### 4.1 研究结论域四合一：统一为 `Report` + `Advice` + 轻量 `ResearchNote`

#### 4.1.1 合并路径

```mermaid
flowchart LR
    subgraph 现状：4套孤立研究模型 (16张表)
        A["Advice + AdviceOutcome (2表)"]
        B["Report (1表)"]
        C["InvestmentWorkspace (3表)<br/>investment_research / consensus / tracking"]
        D["ResearchVault (10表)<br/>topic / doc / hypothesis / chunks / fts / embeddings / git_sync"]
    end

    subgraph 目标：核心投研模型 (5张表)
        T1["advices + advice_outcomes (2表)<br/>结构化个股/持仓投资建议与事后验证"]
        T2["reports (1表)<br/>盘前/盘后/方向共识/周度复盘报告"]
        T3["research_notes + research_notes_fts (2表)<br/>统一本地投研笔记 + SQLite FTS5 全文检索"]
    end

    A --> T1
    B --> T2
    C -->|方向研究并入 Report<br/>候选股跟踪并入 Watchlist| T2
    D -->|砍除手写向量分块、假设版本链与Git同步<br/>保留 Markdown 笔记 + FTS5| T3
```

#### 4.1.2 具体裁剪清单
1. **退役 `InvestmentWorkspace` 三表与 5 个专属 Tool**：
   - 删除表：`investment_research`、`investment_consensus`、`investment_tracking`。
   - 删除文件：[`packages/core/src/entity/investment-workspace.ts`](../../packages/core/src/entity/investment-workspace.ts)、[`packages/db/src/repository/drizzle/investment-workspace.ts`](../../packages/db/src/repository/drizzle/investment-workspace.ts)、[`packages/tools/src/tools/investment-workspace.ts`](../../packages/tools/src/tools/investment-workspace.ts)、[`apps/web/src/workspace.ts`](../../apps/web/src/workspace.ts)。
   - 替代方式：市场方向研究直接生成 `Report`（`type: 'market_outlook'`），关注的候选标的直接加入 `Watchlist`，不再单独维护一套“共识卡片 + 跟踪表”。
2. **大幅瘦身 `ResearchVault`（从 10 张表 / 19 个 Tool 收敛为 2 张表 / 4 个 Tool）**：
   - **删除 8 张表**：`research_topic_index`、`research_hypothesis_versions`、`research_topic_documents`、`research_subject_links`、`research_document_chunks`、`research_chunk_embeddings`、`research_embedding_index_states`、`research_vault_sync_runs`。
   - **删除适配器**：[`packages/adapters/src/research-vault/git-sync.ts`](../../packages/adapters/src/research-vault/git-sync.ts)（469 行）、[`remote.ts`](../../packages/adapters/src/research-vault/remote.ts)（351 行）、[`packages/adapters/src/research-embedding/openai-compatible.ts`](../../packages/adapters/src/research-embedding/openai-compatible.ts)。
   - **保留 2 张表**：`research_document_index`（包含标题、正文摘要、关联 `stock_codes` JSON、标签与本地 Markdown 路径）+ `research_document_fts`（SQLite FTS5 全文检索）。
   - **保留 4 个 Tool**：`create_research_document`、`get_research_document`、`list_research_documents`、`search_research_documents`（FTS5 全文检索）。

---

### 4.2 盯盘域二合一：统一 `AlertPlan` 与 `TradingPlan` 盘中监控引擎

#### 4.2.1 现状问题
- [`packages/workflows/src/intraday-watch.ts`](../../packages/workflows/src/intraday-watch.ts) 负责评估 `AlertPlan`（绑定在 `Watchlist` 上的规则）。
- [`packages/workflows/src/intraday-trading-plan-watch.ts`](../../packages/workflows/src/intraday-trading-plan-watch.ts)（920 行）与 [`trading-plan-daily-cycle.ts`](../../packages/workflows/src/trading-plan-daily-cycle.ts)（748 行）负责评估 `TradingPlan`（个股级买卖计划）。
- 两者都在盘中拉取行情、评估条件、写入 `watch_triggers` 表、发送飞书通知，且额外维护了 `watch_execution_lease`、`watch_rule_states`、`watch_runs` 等多张状态表。

#### 4.2.2 目标方案
1. **保留 `alert_plans`（池级预警）与 `trading_plans`（个股交易计划）两张业务表**，但**合并盘中监控执行器为单一 [`intraday-watch.ts`](../../packages/workflows/src/intraday-watch.ts)**：
   - 一次行情批量拉取（`batchQuote`），同时评估活跃的 `AlertPlan` 与 `TradingPlan`。
   - 统一生成 `WatchTrigger` 记录并写入 `watch_triggers` 表。
2. **删除冗余表与工作流**：
   - 删除表：`watch_execution_lease`（单机用进程内锁）、`watch_runs`（统一记入通用 `workflow_runs`）。
   - 删除工作流：`intraday-trading-plan-watch.ts`、`trading-plan-daily-cycle.ts`、`account-plan-batch.ts`。
   - 删除冗余审计 Tool：`get_intraday_delivery_audit`、`get_closing_batch_audit`。

---

### 4.3 复盘域瘦身：简化 `DecisionReview` 四表版本链为单表

#### 4.3.1 现状问题
为一条交易/建议复盘笔记设计了 4 张表（`decision_reviews`、`decision_review_revisions`、`decision_review_trade_links`、`decision_write_receipts`）以及 `contextHash`、`contentHash`、`tradeFactHashes` 和幂等写回执协议，共 8 个 Tool。

#### 4.3.2 目标方案
- **删除 3 张附属表**：`decision_review_revisions`、`decision_review_trade_links`、`decision_write_receipts`。
- **收敛为单表 `decision_reviews`**：
  - 字段：`id`、`account_id`、`subject_kind`（`'advice' | 'trading-plan' | 'trade'`）、`subject_id`、`stock_id`、`content_json`（复盘结论、教训标签、关联 `tradeIds`）、`created_at`、`updated_at`。
- **8 个 Tool 收敛为 2 个**：`save_decision_review`、`list_decision_reviews`（移除 `get_decision_write_receipt`、`get_decision_review_snapshot`、`refresh_decision_review_report`、`record_decision_trade` 等专用包装器，录入交易统一走 `add_trade`）。

---

## 5. Agent Tool 注册表收敛详细设计（Phase S4：152 Tools → 34 Tools）

### 5.1 设计原则：区分「Agent Tool」与「Application Service」

1. **Agent Tool（进入 `toolRegistry`，暴露给 DeepSeek Harness 与 MCP，共 34 个）**：
   - 必须是**粗粒度、语义自包含、面向投研分析与辅助决策**的能力。
   - LLM 只需 1~2 次调用即可拿到完整上下文（例如调用 `get_stock_market_view` 一次性获得行情 + K 线 + 关键技术指标，而非分 4 次调底层碎片工具）。
2. **Application Service（不进 `toolRegistry`，仅供 Web REST 路由与 CLI 管理命令调用）**：
   - 账户创建/改名、现金流水对账、自选股拖拽排序、策略启停/归档、定时任务配置、历史快照分页等纯 UI CRUD 操作，由 `apps/web` 和 `packages/cli` 直接调用 Service 函数或 Repository，**不再伪装成 LLM Tool**。

### 5.2 最终保留的 34 个核心 Agent Tool 清单

| 领域分组 | 序号 | Tool 名称 | 副作用级别 | 核心职责（供 DSH Agent 与 MCP 调用） |
|---|---|---|---|---|
| **1. 行情与盘面资讯（10 个）** | 1 | `search_stocks` | `read` | 按代码/名称/拼音搜索股票基本信息 |
| | 2 | `get_stock_market_view` | `read` | 获取个股综合行情视图（实时报价 + 近期日K + 均线/MACD/RSI 摘要） |
| | 3 | `fetch_quote` | `external` | 拉取单只或多只股票最新实时行情（合并原 `batch_quote`） |
| | 4 | `fetch_index_quotes` | `external` | 获取上证/深证/创业板/科创50等核心指数实时行情 |
| | 5 | `fetch_sector_quotes` | `external` | 获取行业/概念板块涨跌榜与领涨股 |
| | 6 | `compute_indicators` | `read` | 计算指定股票的日线/分时技术指标（MA/EMA/MACD/RSI/KDJ/BOLL/ATR） |
| | 7 | `limit_up_ladder` | `read` | 获取指定交易日 A 股连板天梯快照与晋级率 |
| | 8 | `dragon_tiger_list` | `read` | 获取龙虎榜机构与游资席位净买卖明细 |
| | 9 | `northbound_flow` | `read` | 获取北向资金净流入历史序列 |
| | 10 | `fetch_news` | `read` | 获取市场财经要闻与个股相关资讯（含情绪快照 `get_ashare_sentiment` 聚合） |
| **2. 股票池 Watchlist（4 个）** | 11 | `list_watchlists` | `read` | 列出所有股票池（自选池、策略池、持仓池） |
| | 12 | `get_watchlist` | `read` | 获取股票池详情、成分股列表及近期变动 |
| | 13 | `create_watchlist` | `write` | 创建新股票池 |
| | 14 | `update_watchlist_members` | `write` | 批量增删改股票池成分股与观察备注（合并原 4 个 member CRUD tools） |
| **3. 策略与回测 Strategy（6 个）** | 15 | `list_strategies` | `read` | 列出所有选股/信号策略及其最新版本状态 |
| | 16 | `get_strategy` | `read` | 获取策略详情、DSL 规则定义与最近运行摘要 |
| | 17 | `save_strategy_version` | `write` | 创建策略或提交新版本 DSL 定义（内含语法与字段校验，合并原 5 个定义工具） |
| | 18 | `run_strategy` | `write` | 对目标股票范围执行策略筛选（支持正式运行或 `trial` 试算模式） |
| | 19 | `run_strategy_backtest` | `write` | 对策略版本执行历史区间回测并返回收益、胜率、最大回撤指标 |
| | 20 | `get_strategy_signals` | `read` | 查询策略产出的历史信号及 T+1/5/20 信号观察表现 |
| **4. 账户与持仓组合 Portfolio（5 个）** | 21 | `get_account_overview` | `read` | 获取账户总资产、现金、仓位占比与持仓明细（合并 `get_account` + `list_holdings` + `get_account_facts`） |
| | 22 | `get_account_performance` | `read` | 获取账户净值曲线、TWR 收益率、最大回撤与归因分析 |
| | 23 | `list_trades` | `read` | 查询账户历史成交记录 |
| | 24 | `add_trade` | `trade` | 登记一笔人工实际成交（仅本地 CLI/Web 可用，永不通过 MCP 暴露） |
| | 25 | `update_holding` | `write` | 手动录入/校准持仓成本与股数（含建仓/平仓，合并 `add_holding`/`close_holding`） |
| **5. 研究、建议与报告 Research（6 个）** | 26 | `analyze_stock` | `advice` | 深度分析个股并生成含正反论据、风险与有效期的结构化 `Advice` |
| | 27 | `analyze_position` | `advice` | 结合当前账户持仓成本与仓位，生成持仓诊断建议 |
| | 28 | `get_advice` | `read` | 查询历史投资建议及其后续表现统计 |
| | 29 | `search_research_documents` | `read` | 全文检索本地投研笔记与历史研究报告（合并笔记查询） |
| | 30 | `save_research_document` | `write` | 保存结构化研究笔记或深度报告（合并 `create_research_document` + `save_report`） |
| | 31 | `save_decision_review` | `write` | 记录对某次建议、计划或交易的事后复盘总结 |
| **6. 交易计划与盯盘预警 Plan & Alert（3 个）** | 32 | `list_watch_plans` | `read` | 查询当前生效的个股交易计划（`TradingPlan`）与股票池预警（`AlertPlan`）及最近触发记录 |
| | 33 | `save_trading_plan` | `write` | 创建或更新个股交易计划（含建仓/止盈/止损触发条件与仓位预算校验） |
| | 34 | `save_alert_plan` | `write` | 创建或更新股票池盘中预警规则 |

---

## 6. 数据库表全量盘点与裁撤对照总表（73 张表 → 38 张表）

| 领域 | 保留的核心表（38 张） | 拟裁撤/合并的冗余表（35 张） | 裁撤/合并说明 |
|---|---|---|---|
| **系统与账户（6 张 → 5 张）** | `schema_migrations`<br>`accounts`<br>`holdings`<br>`trades`<br>`portfolio_performance_snapshots` | `holding_cash_adjustments`<br>`portfolio_cash_flows`<br>`portfolio_corporate_actions` → 合并为单表 **`account_ledger_entries`** | 原 3 张现金调整/出入金/分红送股表结构高度同构，合并为 1 张统一的账户资金与权益流水表 `account_ledger_entries`（净减 2 张表） |
| **股票与行情底座（9 张 → 7 张）** | `stocks`<br>`stock_universe_memberships`<br>`stock_universe_sync_runs`<br>`price_snapshots`<br>`daily_bars`<br>`minute_bars`<br>`limit_up_ladder_snapshots` | `stock_universe_snapshot_members`<br>`daily_bar_revisions` | 移除每次同步全量复制 5,000 行的 `stock_universe_snapshot_members`（直接用 `first_seen_at`/`missing_since` 表达 PIT）；移除未实际使用的 `daily_bar_revisions`（净减 2 张表） |
| **基本面与事件（5 张 → 0 张）** | *（待接入真实财报源后按扁平表设计）* | `financial_fact_revisions`<br>`fundamental_score_versions`<br>`fundamental_score_runs`<br>`fundamental_score_results`<br>`stock_events` | 全部属于无生产数据源的空转超前模块（净减 5 张表） |
| **股票池 Watchlist（5 张 → 3 张）** | `watchlists`<br>`watchlist_members`<br>`watchlist_member_sources` | `watchlist_sync_runs`<br>`membership_snapshots` | 同步运行记录统一归入 `workflow_runs`；移除每次变更复制全表成员的 `membership_snapshots`（净减 2 张表） |
| **策略与回测 Strategy（16 张 → 6 张）** | `strategies`<br>`strategy_versions`<br>`strategy_runs`<br>`strategy_signals`<br>`strategy_backtest_runs`<br>`strategy_watchlist_subscriptions` | `strategy_schedules`（并入 `strategies` 字段）<br>`strategy_run_leases`（改为内存锁）<br>`strategy_results`（并入 `strategy_signals`）<br>`strategy_data_checkpoints`<br>`strategy_data_checkpoint_members`<br>`strategy_evaluation_sessions`<br>`strategy_evaluation_days`<br>`strategy_backtest_market_facts`<br>`strategy_autonomy_actions`<br>`signal_observations`（并入 `strategy_signals` 观察列） | 砍除逐日评估状态机、周度自治审批、分布式租约表、PIT 成员拷贝表；将 `signal_observations` 的 T+1/5/20 收益回填直接作为 `strategy_signals` 的扩展列或 JSON 字段（净减 10 张表） |
| **建议、报告与复盘（8 张 → 5 张）** | `advices`<br>`advice_outcomes`<br>`reports`<br>`decision_reviews`<br>` workflow_runs` | `decision_review_revisions`<br>`decision_review_trade_links`<br>`decision_write_receipts` | 简化 `DecisionReview` 为单表，移除 3 张重型版本链与幂等回执表（净减 3 张表） |
| **研究知识库与工作台（13 张 → 2 张）** | `research_document_index`<br>`research_document_fts` | `investment_research`<br>`investment_consensus`<br>`investment_tracking`<br>`research_topic_index`<br>`research_hypothesis_versions`<br>`research_topic_documents`<br>`research_subject_links`<br>`research_document_chunks`<br>`research_chunk_embeddings`<br>`research_embedding_index_states`<br>`research_vault_sync_runs` | 移除 `InvestmentWorkspace` 3 张表（并入 `reports` + `watchlists`）；移除 `ResearchVault` 的手写分块向量表、假设版本链与 Git 同步表，仅保留文档索引与 SQLite FTS5 全文检索（净减 11 张表） |
| **交易计划、盯盘与对话（10 张 → 8 张）** | `trading_plans`<br>`alert_plans`<br>`watch_triggers`<br>`watch_rule_states`<br>`notifications`<br>`chat_sessions`<br>`chat_messages` | `watch_execution_lease`<br>`watch_runs` | 单机盯盘无需数据库租约锁表；盯盘批次记录统一记入 `workflow_runs`（净减 2 张表） |

---

## 7. Web 服务端与前端巨石文件拆分设计

### 7.1 `apps/web/src/server.ts`（3,569 行）按领域模块化拆分
将单一 3,569 行的 `server.ts` 拆分为薄装配入口 + 6 个领域路由模块：
```text
apps/web/src/
├── index.ts                # 进程启动入口
├── server.ts               # Hono 实例创建、Origin/Auth 中间件、静态资源挂载 (~350 行)
├── routes/
│   ├── market.ts           # 行情、K线、天梯、龙虎榜、板块、新闻接口
│   ├── portfolio.ts        # 多账户切换、持仓、交易、净值与绩效接口
│   ├── watchlist-alert.ts  # 股票池、交易计划、预警规则与触发历史接口
│   ├── strategy.ts         # 策略 CRUD、运行、回测与信号接口
│   ├── research.ts         # 报告、Advice、研究笔记与复盘接口
│   └── settings.ts         # AI 模型配置、数据源状态与导入导出接口
└── dsh/                    # DeepSeek Harness 会话与 SSE 桥接
```

### 7.2 前端页面路由收敛（`apps/web/public/js/`）
- 移除与已裁剪后端对应的冗余前端脚本：
  - 移除 `strategy-workspace-experiment.js`（2,671 行）中针对逐日评估会话（`evaluation-session`）、周度自治审批（`autonomy-action`）、性格评估（`adaptive-personality`）的复杂面板，保留清晰的**「策略列表 / DSL 编辑器 / 选股结果 / 历史回测」**四合一视图。
  - 移除 `workspace.js` 中专属于 `investment_consensus` 的冗余接口调用，首页直接展示今日盘前/盘后 `Report`、核心自选池行情异动与 `TradingPlan` 触发提醒。

---

## 8. 分阶段执行计划与验收门禁

为确保每次改动可独立测试、随时可交付，分 **4 个阶段（Phase S1 ~ S4）** 推进：

| 阶段 | 核心任务 | 关键改动范围 | 验收标准 |
|---|---|---|---|
| **Phase S1：基础设施减负**（零业务变更） | 1. `createMemoryRepositories` 切换为 `bun:sqlite` `:memory:`，删除 `packages/db/src/repository/memory/*`（31 个文件）<br>2. 删除旧版 `agent-runtime.ts` 与 `agent_run` tool<br>3. 收敛 `ToolContext` 顶层属性至 `ctx.adapters` | `packages/db`<br>`packages/core`<br>`packages/adapters`<br>`packages/tools` | `bun run typecheck && bun run test && bun run test:db && bun run test:web` 全绿；净删 ~7,500 行代码 |
| **Phase S2：裁撤超前与空转模块** | 1. 移除 `StockEvent` 子域（1 表 + 5 Tools + 2 Workflows）<br>2. 移除 `FundamentalScore` / `FinancialFact` Mock 管线（4 表 + 4 Tools）<br>3. 裁剪 `Strategy` 超前泡沫（移除逐日评估会话、周度自治审批、可移植 Manifest、分布式租约、PIT 拷贝表，共减 10 表 + 28 Tools） | 全工作区 | 全量测试与构建通过；净删 ~14,000 行代码 |
| **Phase S3：合并重叠领域** | 1. 退役 `InvestmentWorkspace`（3 表 + 5 Tools），并入 `Report` + `Watchlist`<br>2. 瘦身 `ResearchVault`（移除向量分块与 Git 同步 8 张表 + 14 Tools，保留 FTS5）<br>3. 简化 `DecisionReview` 为单表<br>4. 合并 `AlertPlan` 与 `TradingPlan` 盘中监控引擎 | 全工作区 | 全量测试通过 + Headless Chrome 浏览器验证首页、研究页、策略页与持仓页渲染正常；净删 ~10,000 行代码 |
| **Phase S4：Agent Tool 暴露面收敛与 Web 路由拆分** | 1. 将 `toolRegistry` 从剩余 Tool 收敛至 34 个高内聚 Agent Tool<br>2. 拆分 `apps/web/src/server.ts` 为按领域划分的 `routes/*.ts` | `packages/tools`<br>`packages/dsh-bridge`<br>`apps/web` | `luoome tools list --json` 输出 34 个核心 Tool；DSH 真进程集成测试 `bun run test:dsh` 全绿 |
