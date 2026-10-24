# DSH 插件平台开发任务

> **已归档（2026-10-23）**：本文描述的是已下线的多租户托管形态，当前形态是单机版（见 docs/ddd/luoome-dsh-transformation-detailed-design.md 的 D9–D12）。仅作历史留存，不是当前行为说明。

> 创建：2026-10-20；统一验收更新：2026-10-21。
> 依据：[平台设计](../ddd/dsh-plugin-platform-design.md)、[研究与验证计划](./dsh-plugin-platform-research-plan.md)。
> 用户已授权拆分任务、创建开发线程并开始实现；线程使用 `gpt-6.1-sol`、`max`。
> 当前阶段：D01–D07 首批开发已统一集成并通过受控环境验收；D08–D10 尚未派发，生产与真实供应商验证未完成。

## 1. 本批交付与范围

首批完成可验证的基础切片：独立 Node Host 启动受限 DSH、现有 callable 经 Bun Gateway 执行、模型请求经过现有费用账本、原 Chat 消费真实事件。目标是行情业务插件与官方网页读取能力组成一个只读研究闭环。

优先用受控模型、行情和网页响应验证。安装和核验公开依赖属于本批工作；不使用生产投资数据，不读取真实 .env，不自动调用付费模型/搜索或改动线上服务。真实供应商验证缺条件时单独标记，继续完成模拟协议和代码交付。

现有 Runtime 保持默认，DSH 接入由显式测试/开发配置启用。草案语义必须保留并覆盖测试，但本批不默认完成持久恢复、多租户生产放行或多 Agent。缺少预算、隔离或凭据条件时明确拒绝启用对应托管路径，不静默绕过。

## 2. 任务拆分与依赖

| ID | 任务与可评审交付 | 依赖 | 线程 | 研究/验收映射 |
|---|---|---|---|---|
| D01 | 固定 SDK/runtime/插件实际产物，核对源码差异；最小 Profile 可重复启动与关闭 | 无 | A | R00、R01；AC09 |
| D02 | 发布 JSON 跨进程契约；Node Host、业务代理 Cordis 插件、受限通用插件组合及生命周期测试 | D01；契约先交付 | A | R01–R03；AC01、AC02 |
| D03 | Bun 可信 scope、callable manifest、工具执行与撤销/去重；保持草案和错误输出 | 先独立执行内核，再消费 D02 契约 | B | R02；AC03、AC04 |
| D04 | 提取/复用 hosted 请求准入、流式传输与 usage 结算能力，供 DSH 模型入口调用 | 无；复用现有 ledger | C | R05 最小切片；AC06 |
| D05 | Chat runtime 适配、事件转换与 SDK/实时事件去重；模拟端到端测试 | D02、D03；可先独立事件研究 | D | R04；AC05 |
| D06 | 接通显式开发开关和模型计量入口；行情 + 网页读取，实际浏览器验收 | D01–D05 | D 集成，A 提供组合 | R02–R05；AC01、AC02、AC05、AC06 |
| D07 | 第一批停止/失败收尾、有限资源回收、失败不自动切换运行时重跑 | 各模块自测，D 汇总 | A/B/C 各自实现，D 验收 | R08 基础切片；AC07 |
| D08 | 草案确认回执增量同步、持久 RuntimeBinding/delivery 与重启去重 | 首批交付后再排期 | 后续 | R06、R07；AC04、AC08 |
| D09 | 完整预算覆盖、Tenant 删除恢复、升级排空、质量/资源对照与灰度 | D08 及完整研究门槛 | 后续 | R05、R08–R11、R13；AC01–AC11 |
| D10 | 社区插件准入比较、更多业务域与多 Agent | 单 Agent 基础稳定；各自准入 | 后续 | R03 扩展、R12；AC12 |

D01–D07 为本批开发范围。D08–D10 已拆分但不提前派发，不为未验证的恢复设计先造领域实体或新增一套账本。
真实模型调用必须先有 D04 准入能力；首批模拟闭环通过不等于全部 AC 已通过。

## 3. 跨线程契约与交接顺序

A 先交付最小契约，状态标为 `contract-ready` 后 B/D 消费：

- 独立的纯 JSON/types/schema 子入口与 Node/Cordis 入口；导入协议不能加载 SDK、Node 插件或 Bun DB。
- Run/manifest 绑定、ToolCall/ToolReply、事件身份与终态、取消与故障的最小字段，沿用设计第 6–10 节，不猜测 DSH SDK 原生支持不存在的接口。
- tool 请求身份来自可信绑定；工具参数不携带可自行指定的租户权限。业务输出保留 callable 的 `ok/output`、草案标记和既有 error；通用工具单独标明执行位置。
- 导出名、调用示例、错误与生命周期行为、最小测试命令、真实受限 Profile 启动方式写进交接文件。

B 可以先开发接收已认证 scope 和 AgentCallableTool 的执行内核及负向测试；不并行定义第二份跨进程 wire schema。C 的计量接口以现有 adapter/ledger 契约为依据，不依赖尚未确定的 Chat UI 或 DSH 类型。

D 先研究已有 UI Message Stream、DSH 事件来源和测试 fixture；A/B/C 接口就绪后接入真实导出，不创建占位返回成功的实现。缺失依赖记录为未就绪，继续能独立完成的工作。

契约变更由 A 统一修改，并记录影响；B/C/D 提建议到各自交接文件。其他线程已开始消费后，不能无说明更名或删除接口。

## 4. 文件写入边界

所有线程在 `/Users/lijun/project/luoome` 当前本地工作树工作。保留现有未提交改动；不切分支、创建 worktree、commit、push、创建 PR 或全仓自动格式化。开始前读取 git diff，遇到边界外需求先交接建议。

| 线程 | 独占写入范围 | 不直接修改 |
|---|---|---|
| A：Runtime 与插件底座 | `packages/dsh-bridge/`、`apps/agent-runtime/`、`infra/dsh/`；本批共享 package manifests、`bun.lock`、根 TS/测试/构建配置 | Web 源码、现有 core/tools/db/workflows、C 的计量实现；不得 fork 上游 |
| B：业务 Tool Gateway | `apps/web/src/dsh/tool-gateway.ts`、`tool-manifest.ts`、`execution-scope.ts` 与各自测试；需要新增邻近文件先登记 | `chat.ts`/`server.ts`/`hosted-providers.ts`、A 的协议与包配置、C 的计量文件、core/db/tools 业务实现 |
| C：模型计量传输 | `packages/adapters/src/llm/hosted-meter.ts` 及相邻计量测试；必要的新 `hosted-model-transport` 模块；adapter 导出 | Web 文件、core/hosted 账本和 repositories、A 的 manifest/lock、其他行情和 LLM 业务模块 |
| D：Chat 与最终集成 | `apps/web/src/dsh/` 中 runtime client、事件适配和模型代理接线（不含 B 独占文件）；`chat.ts`、`server.ts`、`hosted-providers.ts` 与相邻测试；必要的 Chat 前端文件 | A/B/C 独占范围；默认不改 hosted-server/config/composition、DB schema 和 worker |
| 当前分派线程 | 本开发计划、设计/研究文档的状态、docs/README 导航 | 不与 A/B/C/D 同时改实现文件 |

A 单独处理依赖安装和锁文件；B/C/D 需要 dependency/export/config 改动时写交接需求，不能同时运行改锁的安装命令。A 首轮依赖固定后发布 `dependency-ready`，仍负责后续包配置请求。
C 的 hosted-meter、D 的 server/hosted-providers 已有其他开发的未提交改动，必须基于当前内容做最小增量，不恢复 HEAD 或重写整文件。D 保留现有行情/权益热更新机制。
新增 DB/core/tools 能力超出本批范围，记录必要设计和准确原因，后续 D08 切片实现；不得为避开边界直接私写数据库。

## 5. 线程协作与状态

各线程只维护自己的交接文件；这些是被 Git 忽略的工作记录，不替代正式实现与测试。开始时立即创建，关键接口就绪时及时更新。

| 线程 | 交接文件 | 必填信息 |
|---|---|---|
| A | `output/dsh-plugin-platform/A-handoff.md` | 产物/版本/许可证、契约导出、启动配置、运行证据、依赖请求处理、释放文件 |
| B | `output/dsh-plugin-platform/B-handoff.md` | Gateway 接线与生命周期、可信上下文、草案/错误/越权测试、A/D 待接接口 |
| C | `output/dsh-plugin-platform/C-handoff.md` | 准入/流式/结算 API、unknown 与取消语义、回归测试、D 的调用方式 |
| D | `output/dsh-plugin-platform/D-handoff.md` | 接口消费状态、端到端旅程、浏览器/自动测试、生产与真实供应商未验收项 |

状态使用 `implementing / contract-ready / ready-for-integration / complete / external-validation-pending`；A 另标记依赖是否 `dependency-ready`。`ready-for-integration` 必须有实际导出和通过的相关测试，不能只是设计或空壳。

D 负责读取 A/B/C 交接文件，在就绪后完成接线；必要时使用只读线程状态和有界等待。各线程不创建更多线程或子 Agent，不向其它线程发送消息；完成后在本线程报告并更新自己的交接文件。当前分派线程统一登记与核验启动情况。

## 6. 测试与停止条件

- A：真实 Node 启动/关闭和插件加载必须有可重复证据；模型调用使用 stub。若发布物与审查源码不匹配，重新冻结证据而非假定兼容。
- B：重点覆盖未知/过期/撤销身份、manifest mismatch、跨账户、同调用 ID 变更输入、重复调用、草案输出与 ToolError 映射。
- C：预算不足不发送、逐 attempt 结算、流式首块可达、缺失 usage/中断为 unknown、重复结算与现有 AI SDK 回归。不能把 token-meter 当账本。
- D：模拟模型 + 真实 Node/插件/Gateway 的集成测试，与纯 stub 单测分开报告；实际启动 Web 浏览器检查文本/工具/确认卡、停止与失败。
- 各线程先跑最小相关测试，再做所属范围 typecheck/lint。D 最终按仓库脚本统一相关检查；原有并行改动导致的失败单列，不删除测试或放宽断言。
- 无法移除高权限默认工具、主模型绕过预算、草案变真实写入、无法确认执行已停止时，相关路径停止启用并准确报告；其他独立实现继续。
- 首批不调用真实付费服务；真实模型/行情质量、生产隔离与容量明确列为未验收，不能用模拟结果替代。

## 7. 线程登记

以下线程完成首批交付；统一模型为 `gpt-6.1-sol`、推理强度 `max`。主线程已接管集成与验收，结果见下一节。

| 线程 | 标题 | Thread ID | 状态 |
|---|---|---|---|
| A | 开发 DSH Runtime 与 Cordis 插件底座 | `01a158c9-8f32-7752-9076-28f971854e84` | 已集成；复核线程额度耗尽后的收尾由主线程完成 |
| B | 开发 DSH 业务 Tool Gateway | `01a158c9-dd2e-7311-bd12-c84dfde732d9` | 已集成并复核 |
| C | 开发 DSH 模型计量与流式传输 | `01a158ca-29b8-7522-8158-a58c4ddcc272` | 已集成并复核 |
| D | 接入 DSH Chat 并完成首批集成验证 | `01a158ca-86b5-79d0-83c1-1b65c505cdc5` | 已集成；主线程完成最终浏览器与全仓检查 |

## 8. 首批统一验收

D01–D07 已实现并通过受控环境验收。实际链路为原 Luoome Chat → Bun 托管授权与计量 → Node SDK Host → DSH/Cordis → 业务 Gateway 与官方网页工具 → 原 Chat 流式协议、SQLite 消息及费用记录。安装基线为 DSH `0.2.1-rc.2`、Cordis `4.0.5`，验证运行时为 Node `22.22.3`、Bun `1.3.14`；产物完整性见 [artifacts.json](../../infra/dsh/artifacts.json)。

本轮集成修复了以下实际问题，并保留对应回归测试：

- Assistant 消息保存结束前提前释放会话串行锁，允许后续请求读取不完整历史。现持有锁直到保存完成；保存失败阻断继续。
- 模型重复使用 tool call ID 导致业务与原生工具回执混用、Gateway 去重或 UI 投影冲突。内部回执按 registry 执行 token 隔离，跨进程 ID 按执行分配。
- SSE 按行而非完整事件解析、工具终止原因不一致仍可能分发工具。现接受合法多行 data，拒绝未分帧 JSON 和矛盾终态。
- 已收到最终 usage 与 `[DONE]` 后取消，底层 reader.cancel 异常覆盖真实费用回执；以及早期 usage 被误当最终费用。现保留有效终态回执，后续内容使早期候选失效。
- Gateway 授权回调重入时排空登记滞后；manifest 投影提前求值动态默认值、遗漏稀疏数组空位，以及原生名称冒用业务工具。现分别修正并覆盖拒绝路径。
- 托管 Web 测试访问 ToolResult.data 前缺少成功分支收窄，已修正类型检查。

统一检查在同一工作树完成，没有提交、推送或替换原有并行改动：

| 检查 | 结果 |
|---|---|
| `bun --no-env-file run test` | 294 文件、2570 项通过，含 17 项协议与真实 Node/DSH 集成测试 |
| `bun --no-env-file test packages/db` | 16 文件、710 项通过 |
| `bun --no-env-file test apps/web` | 57 文件、806 项通过，包含真实子进程、Gateway、认证、费用账本与聊天持久化 |
| `bun --no-env-file run typecheck` | 全 workspace 通过 |
| `bun --no-env-file run build` | 全 workspace 通过，包含 Node Host/plugin 产物 |
| `bun --no-env-file run lint` | 退出码 0；无错误，104 条警告、2 条提示；未全仓自动修格式 |
| 实际浏览器 | 桌面行情与网页工具、草案确认及真实回执接续、停止后核对、供应商失败提示、390px 移动布局 |

自动测试使用受控供应商，不读取个人 `.env` 或私人投资数据。运行日志与截图留在本地忽略目录 `output/dsh-plugin-platform/`，可重复运行的入口、配置和浏览器样例见 [开发运行底座](../../infra/dsh/README.md#web-受控验证)。架构、安全与用户手册已同步实际行为。

验收边界仍然明确：默认运行时为 AI SDK；DSH 只在显式托管开发配置启用，生产配置拒绝启动。当前 Web 原生网页能力仅开放 fixture；没有真实模型/行情/搜索质量或真实费用验证。历史接续采用临时 Session 重建，不代表持久恢复、断线重放或 exactly-once。OS/网络强隔离、多租户容量、备份删除恢复、社区插件准入与多 Agent 继续属于 D08–D10 和研究计划，不能由本次 4086 项测试推定完成。
