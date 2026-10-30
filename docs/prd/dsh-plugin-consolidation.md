# DSH 插件形态收敛 PRD

> 状态：**评审后修订版 v3.1**（2026-10-30）。v1 / v2 / v3 与四份评审记录见 `output/dsh-brainstorm/review/`。
> 日期：2026-10-30
> 上位文档：[luoome 的 DSH 改造详细设计](../ddd/luoome-dsh-transformation-detailed-design.md)、[dsh-luoome 纯插件详细设计](../ddd/dsh-luoome-plugin-detailed-design.md)
> 决策依据：`output/dsh-brainstorm/06-decisions.md`（P1–P10）
> 关联：[CONTEXT.md](../../CONTEXT.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)、[SECURITY.md](../SECURITY.md)、[AGENTS.md](../../AGENTS.md)
> 交付对象：把「已完成 DSH 迁移的 luoome」收敛为「一个可交付的 DSH 投资能力」，五个里程碑共 **54 条需求**。

**v3.1 相对 v3 的变更**（采纳金融评审 6 条阻塞项 + 2 条转达）：
1. **修正 REQ-M3-03 量纲错**：`0<min≤max≤0.30` → `0 ≤ min ≤ max ≤ singleStockPct`（百分点 0–100），并按 action 分档允许 `exit/avoid` 取 0。
2. 补 `appliedPct` / `fallbackPct` 落库（无它则复盘不可判定）；`deltaPct` 改为读取时计算 min/max。
3. 预算冲突改为「`draft` 可存 / `draft→active` 必断」，替换 v3 自相矛盾的「软提示不阻断」；修正恒绿的验收用例。
4. 新增 REQ-M3-20 承载 P10（跨日禁令）——v3 里 P10 零承载。
5. REQ-M3-18 补 `origin` 与统计侧过滤；REQ-M3-10 补未了结排除、`excessHitRate`、`excluded` 计数、`metricVersion`。
6. REQ-M4-05 更名「质量 metric」并明确估值段不做；REQ-M3-01 回溯轨边界改三分法。

**v3 相对 v2 的变更**（采纳产品评审 11 条阻塞项 + 6 条建议项）：
1. **补 9 条被漏掉的需求**（M2-08、M2-10、M3-15、M3-16、M3-17、M3-18、M4-10、M4-11、M1-10）——v2 把产品报告里的 P0 项压进了「迁移 4 项」，压丢了。
2. **修正 M2-07 算术错误**：「文件数降 ≥30%」改为「被删 42 个测试文件零残留 + 文件数降 10%–15%（基线由脚本产出）」。
3. **补 M3-03 的失效条件结构化**：P3 承诺了「区间 + 失效条件」，v2 只做了区间。
4. **重排三条顺序**：PIT 属性快照前移 M3a；`M3-05` 的名实不符整改前移 M1；outcome 回填前移 M3。
5. **新增 §3.0 旅程唯一口径 + 需求×旅程矩阵**；「旅程」一词在文档内不再有两套含义。
6. **去条件式验收**（M4-02 的「若 M5-03 已上线」已删）。
7. **当期实测数字移入附录 A**，正文改为引用，避免随代码漂移失真。

---

## 1. 文档结论

**当前状态是「迁移完成、产品未收敛」**：运行形态已是纯 DSH 插件（Node 进程内原生注册工具 + 6 个面板 + 4 条随包技能，无 MCP 实例、无 CLI、无 worker），但产品身份、代码边界、文档口径、技能真源四件事仍停在旧形态，且 DSH 的编排类原语一个都没接。

| 里程碑 | 主题 | 周期 | 完成定义 |
|---|---|---|---|
| **M1** | 止血 | 1–2 周 | §3.0 旅程中的 **盘前 / 盘后 / 研究 / 复盘** 四条技能级 e2e 在本地与生产都绿；事实层无静默污染；暴露面可被工具化回答；名实不符的入口已改名或摘除 |
| **M2** | 删旧面 + 补必需能力 | 2–4 周 | 仓库只剩一个产品面；**删除前已补上完整账户维护与导入恢复**，不产生能力空窗 |
| **M3a** | 补能力·核心 | 4–10 周 | 回溯轨与 IC 同批；失效条件可被确定性检查；PIT 属性快照到位；严格回测诚实标注剩余缺项 |
| **M3b** | 补能力·可见性 | 10–14 周 | 交付物、事实缺口 UX、命中率口径与分母来源、单条建议归因、多供应商凭据、external 事实落库 |
| **M4** | 收口 | 14–19 周 | 旧看板下线、盘中闭环、多角色投研可用、首个真实 PIT 财务 metric 打通 |
| **M5** | 开新能力 | 19 周+ | 把确定性能力变成可编排单元（jobs / workflow / present / goal） |

**54 条需求分布**：M1 **10** 条、M2 **10** 条、M3 **19** 条（M3a 8 / M3b 11）、M4 **10** 条、M5 **5** 条。
（v3 相对 v2 的净变动：新增 9 条、`M3-05` 并入 `M1-05`、`M4-04` 改号为 `M3-19`。）

**一句话优先级**：如果只能做一件事，做 M1。M1 之前，其余所有评估都建立在一个不成立的前提上——
技能调不到工具时，任何「策略结果」「复盘结论」「研究判断」都不可信。

---

## 2. 背景与问题

### 2.1 形态已切换，产品身份未切换

已确认的形态级决策（D1–D12）已落地为可运行部署：`deploy/dsh/compose.yaml` 只跑 `profile-seed.mjs` + `dsh --profile`；插件在 DSH Node 进程内 `ctx.tools.register()` 原生注册工具。

但仓库里同时存在**五份旧形态源码**且仍在 CI 范围内（规模与测试预算见附录 A）：

| 遗留面 | 生产依赖 | 处置 |
|---|---|---|
| `packages/cli` / `packages/tui` | 否（`production.test.ts:756` 明列 forbidden） | M2 删除 |
| `apps/web` | 否 | M4 删除（先做能力裁决） |
| `packages/dsh-bridge` | 否（`test:dsh` 不在 `test:all`） | M2 删除 |
| `packages/mcp` | 否 | M2 只删用户入口 |

### 2.2 三个必须解决的问题

**问题一：技能双轨，两个环境各有各的坏法**

- DSH 技能优先级 `PROJECT_DSH_RANK=100` < `BUNDLED_SKILL_RANK=600`，同名取小者
  （`@deepseek-ai/dsh-skill-filesystem/lib/index.js:20,156`；插件在 `packages/dsh-luoome/src/host/skills.ts:44-52` 记录了这条语义）。
- 工作区 `.dsh/skills/` 6 条覆盖插件随包 4 条。6 条里 4 条使用 `mcp__luoome__*` / `mcp__luoome-analysis__*`
  命名空间（`morning-brief` 7 处、`post-close-review` 7 处、`stock-deep-dive` 5 处、`decision-journal` 2 处），
  而插件是裸名原生注册 → **这些工具名不存在**。
- 生产镜像 `Dockerfile` 不 `COPY .dsh`，生效随包 4 条 → **但随包 4 条没有 `morning-brief`，盘前旅程无技能**。

**问题二：严格回测名实不符**

- `saveMarketFacts` 全仓只出现在 4 处（core 接口声明、memory 实现、drizzle 实现、contract test），
  **没有任何 tool / workflow 调用** → `strategy_backtest_market_facts` 恒空 → 门禁恒 `partial` → 永远无 metrics，入口却叫「严格回测」。
- `execute_strict_strategy_backtest` 在 `packages/tools/src/tools/strategy-backtest.ts:408` 有领域实现却**不在 registry**，插件又实现了一份同名工具。
- `STRATEGY_EVALUATOR_CODE_HASH` 是 manifest 字符串的 sha256，不是代码文件 SHA-256 → 改代码 hash 不变。

**问题三：mock 财务事实污染真实评分**

`packages/adapters/src/fundamental/factory.ts:23-28` 是唯一允许的财务 provider 且为 mock；mock 事实写入
`financial_fact_revisions` 主表；`resolveVintage`（`packages/db/src/repository/drizzle/financial-fact.ts:217-229`）
**不按 source 过滤** → mock 的 roe/pe 会被真实评分解析。

### 2.3 量化基线

| 维度 | 现状 | 判据 |
|---|---|---|
| 运行形态切换 | ~85% | 生产只跑纯插件，但旧面仍在仓与 CI |
| 产品一致性 | ~50% | 两套技能集；文档以 CLI/TUI/Web 为主线 |
| DSH 能力利用 | ~25% | 已用 agent / schedule / skill / subagent / approval；未用 jobs / workflow / present / goal / web / session-query / ask-user |

**工具面数字一律见附录 A，正文不写死**（口徑由 REQ-M1-03 的 `exposure-report.md` 与 `bun run tools:list` 产出）。

---

## 3. 目标、旅程与非目标

### 3.0 旅程清单（唯一口径，全文只用这一套）

| # | 旅程 | 用户目标 | 承接需求（里程碑） | 本期是否补全 |
|---|---|---|---|---|
| J1 | **盘前** | 开盘前知道今天必须看什么 | M1-01（技能）、M3-08+**M3-17**（四段交付物）、M4-06（定时） | ✅ 是 |
| J2 | **盘中** | 看到触发 → 判断 → 就地改条件 | M3-09（提醒要素）、**M4-10**（触发→改条件闭环）、M4-01（告警规则迁移） | ⚠️ 部分：M1–M3 期间只保证「不误导」，不做就地操作 |
| J3 | **盘后** | 复盘当日判断并落记录 | M1-01（技能）、M3-08（收盘报告）、**M4-11**（复盘草稿）、M3-18（outcome 回填） | ✅ 是 |
| J4 | **研究** | 提假设 → 验证 → 发布 | M1-01（技能）、M3-01+M3-13（回溯与 IC）、M3-04/05（回测诚实）、M4-02（多角色） | ✅ 是 |
| J5 | **复盘** | 核对建议兑现、记 outcome、指向修订 | M3-18（回填）、M3-10（口径）、M3-14（单条归因）、M4-03（→策略修订） | ✅ 是 |
| J6 | **配置** | 配数据源、账户、导入恢复 | **M2-08**（账户维护）、**M2-10**（导入恢复）、**M3-15**（多供应商凭据）、M4-06（自动化档位） | ✅ 是 |

> **术语纪律**：`mvp-journeys.e2e.test.ts` 里的「旅程 1–5」是**工具级**用例（策略 create/publish、研究、
> DecisionReview、external 事实、策略上线），**不是**本表的六条用户旅程。v3 起该文件内的用例名统一加前缀
> 「工具级旅程 N」，本文与后续文档一律用 J1–J6 指代用户旅程。

### 3.1 目标

1. **六条旅程中四条（J1 盘前 / J3 盘后 / J4 研究 / J5 复盘）在本地与生产走同一条技能路径**；J2 盘中、J6 配置按 §3.0 的里程碑分批补全。
2. **事实层可信**：不存在静默污染路径；任何缺失显式 `unavailable` / `partial`，任何数字可追溯到 `dataAsOf`。
3. **单一产品面**：一个运行入口（DSH 插件）、一个技能根、一套可被工具化回答的工具暴露面口径。
4. **决策链路补全**：风险、归因、回测、交付四段从「设计里有」变成「用户看得见且诚实」。
5. **DSH 编排红利落地**：至少把「长任务」「交付物」「多角色取证」三类原语接进产品。

### 3.2 非目标

- 不改行情抓取、技术指标、Strategy 规则引擎、Watch/Alert 的确定性逻辑。
- 不改 `Advice` 业务语义（决策、信心度、反例、风险、免责声明、有效期）。
- 不引入第二套调度器；DSH 定时任务是唯一后台调度。
- 不做自动交易；`trade` 永不进 MCP，也不进队列结果类型。
- 不在本期重写插件前端技术栈。
- 不把 DSH 插件 API 当领域契约；领域只认工具名。
- **J2 盘中的「实时行情体验」不做**（免费行情软件替代性高），只做「触发 → 改条件」的动作闭环。
- **严格回测的净收益 / 回撤 / Sharpe 不做**（缺公司行动与费率版本化事实，见 §8）。
- 不追求收益率承诺类结论；指标类输出在事实缺口时返回 `unavailable`。

---

## 4. 已确定的产品决策

### 4.1 决策台账

| # | 决策 | 结论 |
|---|---|---|
| P1 | `apps/web` 8 项独有能力的处置 | **迁 4 废 4**（迁：导入导出、告警规则编辑、通知目标、交易计划面板；废：飞书通知、研究库远程同步开关、草稿/工作区、账户绩效快照 API） |
| P2 | 资金体量与持仓周期 | **50 万以下 / 1–4 周** → 组合层优先于成本模型 |
| P3 | AI 是否参与仓位决策 | **B：目标仓位区间 + 失效条件**，用户确认后进 TradingPlan |
| P4 | 数据预算 | **C：自建采集**（不采购） |
| P5 | 「建议是否兑现」由谁判定 | **只由用户回填，AI 永不代填** |
| P6 | 自动化默认档位 | **定时开、自动执行关** |
| P7 | 策略风格 P0 | **趋势**（现有 qfq 日线即可） |
| P8 | 多智能体是否进 v1 | **① P0 就做多空风控三角** |
| P9 | 前 6 个月只积累事实 | **不接受；双轨（回溯轨 + 前瞻轨）加速** |
| P10 | `advice_market` 跨日引用 | **禁止跨日** |

### 4.2 因决策产生的前置改动（顺序不可调整）

| 前置 | 服务决策 | 为什么是阻塞项 | 对应需求 |
|---|---|---|---|
| `SignalObservation.vintage`（三值） | P9 | 回溯补数一旦落库会与前瞻观察混进同一统计池（统计只按 `sourceKind` 过滤，实体无 `scope` 字段） | M1-06 |
| 结构化 `missingFacts` | P8 | 现状是 `string[]` 自由文本，空头研究员无法引用「第 3 条缺口」反驳 | M3-02 |
| `targetPctRange` **+ 结构化失效条件** | P3 | **v2 只做了区间，漏了失效条件**；`invalidationConditions` 现为 `z.array(z.string())` 自由文本（`packages/core/src/entity/trading-plan.ts:190`），LLM 写的散文无法被盘中确定性检查 | M3-03 |

---

## 5. 需求总览

**依赖类型**：`硬` = 不做则本需求无法验收；`软` = 可并行但影响质量；`序` = 仅建议顺序。

| ID | 标题 | 里程碑 | 优先级 | 依赖 |
|---|---|---|---|---|
| REQ-M1-01 | 技能单一真源与外迁（8 条） | M1 | P0 | — |
| REQ-M1-02 | 技能内容契约守卫 | M1 | P0 | 硬 M1-01 |
| REQ-M1-03 | 暴露面一致性守卫与 exposure 报告 | M1 | P0 | 硬 M1-08 |
| REQ-M1-04 | mock 财务事实 source 隔离 | M1 | P0 | — |
| REQ-M1-05 | 严格回测同名双实现消除 **+ 名实不符整改** | M1 | P0 | 硬 M1-03 |
| REQ-M1-06 | `SignalObservation.vintage` 三值维度 | M1 | P0 | — |
| REQ-M1-07 | 领域层「零 AI」落到行为层守卫 | M1 | P1 | — |
| REQ-M1-08 | 工具暴露面归类（queue / chat / 私人研究） | M1 | P0 | — |
| REQ-M1-09 | 财务 revision 时点可得性 spike | M1 | P0 | — |
| REQ-M1-10 | 读者基建（术语表 / 状态机 / 旅程矩阵） | M1 | P1 | — |
| REQ-M2-01 | 批处理白名单与角色常量迁出 | M2 | P1 | — |
| REQ-M2-02 | 删除 `packages/dsh-bridge` 与旧代理产物 | M2 | P1 | 序 M2-01 |
| REQ-M2-03 | 删除 stdio MCP 用户入口（保留 surface 定义） | M2 | P1 | 硬 M2-09 |
| REQ-M2-04 | 迁移 CLI 独有能力（doctor / 手动补跑 / tools:list） | M2 | P1 | 软 M1-03 |
| REQ-M2-05 | 删除 `packages/tui` 与 `packages/cli` | M2 | P1 | 硬 M2-04、**M2-08、M2-10** |
| REQ-M2-06 | 删除部署侧旧 MCP 过渡面 | M2 | P1 | 序 M2-03 |
| REQ-M2-07 | 覆盖率基线增量重设与 CI 同步 | M2 | P1 | 序 贯穿 M2 |
| REQ-M2-08 | **完整账户维护**（加仓 / 平仓 / 现金 / 成交登记） | M2 | **P0** | 硬 M1-03 |
| REQ-M2-09 | surface 定义归位到 `tools/src/exposure` | M2 | P1 | 硬 M1-07 |
| REQ-M2-10 | **导入恢复**（SQLite 预检 → 计数对比 → 事务写入 → 回执） | M2 | **P0** | 硬 M2-08 |
| REQ-M3-01 | 回溯轨观察流水线 | M3a | P0 | 硬 M1-06 |
| REQ-M3-13 | IC / RankIC 计算层 | M3a | P0 | 硬 M3-01 |
| REQ-M3-02 | 结构化 `missingFacts` | M3a | P0 | — |
| REQ-M3-03 | `targetPctRange` **+ 结构化失效条件** | M3a | P0 | — |
| REQ-M3-04 | 严格回测 market facts 生产者 | M3a | P0 | 硬 M1-05、**M3-19** |
| REQ-M3-11 | 暴露面判定与 DSH per-agent 可见集合并 | M3a | P0 | 硬 M1-03、M2-09 |
| REQ-M3-12 | evaluator code identity 改真实文件 SHA-256 | M3a | P1 | 硬 M3-04 |
| REQ-M3-19 | **PIT universe 属性快照**（v3 从 M4-04 前移） | M3a | P0 | — |
| REQ-M3-06 | 组合风险只读工具 | M3b | P0 | 软 M3-03 |
| REQ-M3-07 | 账户层归因与超额收益可见 | M3b | P0 | — |
| REQ-M3-14 | 单条建议的事后归因 | M3b | P1 | 硬 M3-07 |
| REQ-M3-08 | 报告以交付物形式呈现（五类） | M3b | P0 | — |
| REQ-M3-17 | **盘前交付物四段结构 + 交付时点** | M3b | **P0** | 硬 M3-08 |
| REQ-M3-09 | 事实缺口 UX 一致性（含提醒要素） | M3b | P0 | 硬 M3-02 |
| REQ-M3-10 | 命中率口径统一 | M3b | P1 | 硬 M3-18 |
| REQ-M3-18 | **outcome 结构化回填**（v3 从 M5-03 前移） | M3b | **P0** | — |
| REQ-M3-20 | **`advice_market` 跨日引用禁令**（承载 P10） | M3b | **P0** | — |
| REQ-M3-15 | **其他供应商凭据配置** | M3b | P1 | — |
| REQ-M3-16 | **external 市场事实持久化** | M3b | P1 | 硬 M3-09 |
| REQ-M4-01 | `apps/web` 能力迁移与旧看板下线 | M4 | P1 | 硬 M2-05 |
| REQ-M4-02 | 多空风控三角 | M4 | P0 | 硬 M3-02、M3-06、M3-11 |
| REQ-M4-03 | 复盘 → 策略修订回路 | M4 | P1 | — |
| REQ-M4-05 | 自建采集首个真实 PIT metric | M4 | P1 | 硬 M1-04、M1-09 |
| REQ-M4-06 | 自动化三档 | M4 | P1 | — |
| REQ-M4-07 | 文档即事实表与文档守卫 | M4 | P1 | 序 M2 全 |
| REQ-M4-08 | CI 纳入插件形态验收 | M4 | P1 | 软 M2-07 |
| REQ-M4-09 | 用户可见的入口下线说明 | M4 | P2 | 序 M2 全 |
| REQ-M4-10 | **盘中「触发 → 改条件」闭环** | M4 | **P0** | 硬 M4-01 |
| REQ-M4-11 | **盘后复盘草稿** | M4 | P1 | 硬 M4-06、M3-08 |
| REQ-M5-01 | 长任务编排（jobs / workflow / schedule） | M5 | P1 | 硬 M1-03 |
| REQ-M5-02 | 交付物体系扩展 | M5 | P1 | 硬 M3-08 |
| REQ-M5-03 | 三项轻量接入（历史检索 / 评分回统计 / 成本） | M5 | P1 | 软 M3-02 |
| REQ-M5-04 | 完整多角色与风险官否决 | M5 | P2 | 硬 M4-02 |
| REQ-M5-05 | 目标式长跑 | M5 | P2 | 硬 M5-01 |

---

## 6. 逐条需求

### M1 — 止血

#### REQ-M1-01 技能单一真源与外迁

**需求**：
1. 插件随包技能从 4 条扩到 **8 条**：保留 `daily-market-analysis` / `post-close-review` / `strategy-lab` / `strategy-result-review`；从 `.dsh/skills` 迁入 `morning-brief` / `stock-deep-dive` / `decision-journal` / `luoome-batch`，正文全部改为**裸工具名**。
2. `analysis-worker` **不迁**（退役）；`deploy/dsh/skills.ts` 的 `WORKER_ONLY_SKILLS` 同批删除。队列代码保留。
3. `.dsh/skills/` 目录整个删除。
4. 同步三处清单：`BUNDLED_SKILL_NAMES`、`deploy/dsh/profile-seed.mjs` 的 `REQUIRED_SKILLS`、`skills-content.test.ts` 期望集合。
5. **术语整改**：`packages/dsh-luoome/src/host/mvp-journeys.e2e.test.ts` 内的「旅程 1–5」用例名改为「工具级旅程 1–5」，消除与 §3.0 的 J1–J6 的歧义。

**验收标准**：
- `bun run test:dsh-luoome` + `bun run test:plugin-install`（Node24）通过。
- `grep -rn "mcp__luoome" --include=SKILL.md .` 零命中。
- **三集合相等**：`readWorkspaceSkillNames() === readBundledSkillNames() === BUNDLED_SKILL_NAMES`（8 项），CI 输出差集。
- **技能级 e2e（新增定义，落 `packages/dsh-luoome/src/host/skill-journeys.e2e.test.ts`）**：J1 盘前 / J3 盘后 / J4 研究 / J5 复盘各一条，每条断言四件事——
  ① 该技能被 DSH catalog 命中（按名查得到）；
  ② 首轮 tool 调用名 ∈ 插件暴露集；
  ③ 调用成功率 100%；
  ④ 产出含 `dataAsOf`，且至少含 1 条 `missingFacts` 或显式 `unavailable` 标注。
  **不得复用** `mvp-journeys.e2e.test.ts` 的工具级用例作为技能级证明。

**运行环境**：技能文件与断言用 Bun；`test:plugin-install` 与 skill-journeys 用 Node 24。

**风险**：`post-close-review` 两份内容冲突（55 行差异），保留插件严版；`stock-deep-dive` / `morning-brief` 正文**保留原结构只改工具名**（内容资产是金融评审唯一判定「方法论成立」的部分）。

---

#### REQ-M1-02 技能内容契约守卫

**需求**：`skills-content.test.ts` 增三条断言 + 各一条负例：
1. **单根**：`.dsh/skills` 与 `packages/dsh-luoome/skills` 不得同时非空。
2. **命名空间**：技能正文 `mcp__` 出现次数 = 0。
3. **可达性**：「建议调用」工具名 ∈ 暴露集合；「禁止调用」工具名 ∉ 暴露集合（单独白名单）。

**验收标准**：三条断言各有负例（注入失败样例后测试必须红）。

---

#### REQ-M1-03 暴露面一致性守卫与 exposure 报告

**需求**：
1. `surface-consistency.test.ts`：遍历生产 operation policies，断言每个 `policy.tool.name` 在 registry 中且 `sideEffect` / `requiredCapabilities` 一致。
2. `packages/tools` 增显式 `WORKFLOW_ONLY_TOOL_NAMES`；守卫断言「registry 外的 tool 定义必须在此名单内」。
3. `bun run tools:list`（**新建**，当前不存在）：Node 24 下输出全部工具、插件暴露集、不可达集及五类分类。
4. 生成 `exposure-report.md`。

**验收标准**（**不写死数字**）：
- 未归类工具数 = 0；
- 五类分类的并集 = 全部工具名集合；
- 每个 tool 有 `exposed` / `unreachable-by-design` 标签；
- 负例：故意改错一个 policy 工具名，测试必须红。
- 工具总数由报告生成，**不进断言**（避免工具增删即红）。

**运行环境**：**Node 24**（加载 `production.ts`，其依赖 `node:sqlite`）。

---

#### REQ-M1-04 mock 财务事实 source 隔离

**需求**：`resolveVintage` 增 `source` 白名单（真实查询默认只解析真实来源）；mock 写独立表或以 source 标签隔离；真实源接入前 `run_fundamental_score` 一律 `unavailable`；既有 `providerKind` / `gate` 披露字段不变。

**同步清单**：Core entity（source 约束语义）；Repository（`resolveVintage` 签名 → drizzle + memory + contract tests）。

**验收标准**：mock 写入后真实 source 查询返回 `unavailable`；`run_fundamental_score` 返回 `unavailable` 且不写可消费结果；双实现契约测试通过。

---

#### REQ-M1-05 严格回测同名双实现消除 **+ 名实不符整改**（v3 吸收 M3-05 的第 1/3/4 条）

**背景**：产品评审指出 M1 门宣称「事实层不再有静默污染」，但名实不符这类缺陷全留到 M3，中间 4–10 周
用户看到的是「永远 `partial` 的严格回测」——PRD 自己写「名实不符视同缺陷」，却留了一个窗口。这四条改动都是
改文案 + 摘暴露面 + 面板不渲染数字，量级 S，必须止血期内做完。

**需求**：
1. 把领域实现注册进 registry、删除插件侧同名副本，保持「一个能力一份实现」（**回退方案**：改名保留内部使用）。
2. `execute_strict_strategy_backtest` **移出插件暴露面**（降为内部工具）。
3. 「模拟回测 / backtest」文案与路由统一改为「历史评估（逐日重放）」，输出保留 `limitations`。
   **命名分档（v3.3 按 T06 实作校正）**：两类东西不得同名——
   - **规则重放 / evaluation session** → 「历史评估（逐日重放）」（原「模拟回测」）；
   - **组合层严格回测** → 「组合回测（门禁审计）」（原「严格回测」；对外入口已降为内部工具）。
   理由：面板若两者都叫「历史评估」会更混淆；分档后名字本身说明了「这是选股重放」还是「这是组合净值回测」。
4. 门禁未 `complete` 时面板**不出现**收益率 / 回撤 / Sharpe 占位，只显示门禁审计表与阻塞项清单。

**验收标准**：
- 全仓同名 `defineTool` 仅一处；M1-03 守卫覆盖该工具。
- `execute_strict_strategy_backtest ∉ exposed`。
- 文案字典 `grep "严格回测"` 零命中（白名单仅 `docs/archive/`）。
- 面板门禁态快照不含「收益率/回撤/Sharpe」数字文本；门禁卡 ≥1 条具体缺失事实。

---

#### REQ-M1-06 `SignalObservation.vintage` 三值维度

**需求**：
1. `vintage: 'pit' | 'restated' | 'legacy'`。
2. 迁移：存量默认 `pit`，**但 `horizon='t20'` 与 legacy `sourceKind` 显式标 `legacy`**。
   **降级只对默认池生效**：SQL guard 必须是 `WHERE vintage = 'pit'`，**不得用 `vintage <> 'legacy'`**——
   后者会把显式标注为 `restated` 的行也折成 `legacy`（T07b 已复现）。
   原则：**显式标注压过迁移推断**——`restated` 是 T18 回溯轨的刻意声明，启动迁移不得静默覆盖。
3. 双仓储 + DDL 同步；迁移幂等。
4. `get_signal_observation_stats` 入参增 `vintage?`，**默认只统计 `pit`**；请求其它值必须显式；未指定时 `limitations` 说明被排除组与数量。
5. 观察列表与面板加 vintage 角标。
6. 混算守卫：断言同一统计结果内不得混合不同 vintage。

**同步清单**：Core entity；Repository（接口 + 双实现 + contract tests + DDL）；Tool；API/Web（角标）。

**验收标准**：迁移连跑两次结果一致；三组样本（pit/restated/legacy）默认只统计 pit 且 `limitations` 明示排除组；混合样本请求全量时输出含混算提示。

**运行环境**：`bun run test:db`。

---

#### REQ-M1-07 领域层「零 AI」落到行为层守卫

**需求**：
1. `check-layers.ts` 扩展：领域包内不得出现模型 endpoint 字面量（`/embeddings`、`/chat/completions`、`/completions`），白名单只留 `research-embedding`。
2. research embedding 写成 `ARCHITECTURE.md` 的显式受控外部 capability（新增「模型运行时边界」节）。
3. 清理 `core/src/entity/advice.ts` 的 `llmReasoning` / `RULE_FALLBACK_PREMISE_MARKER` 残留。

**验收标准**：`bun run check:layers` 通过；负例：在 `packages/core` 加一行含 `/chat/completions` 的字符串，守卫必须失败。

---

#### REQ-M1-08 工具暴露面归类

**需求**：为全部工具各落一个显式标签，共 **5 类**（`仅四类会漏掉 read 工具`——本轮自查修正）：
1. **只读面**（`read`，经 read / market allowlist 暴露给对话与面板）；
2. **可写面**（`write` / `external`，经 operation policy 按明确意图执行）；
3. **queue-worker 面**（`queue`，设计上不暴露，H1 已定保留不暴露）；
4. **私人研究 opt-in**（默认拒绝，显式开启）；
5. **废弃**（从 registry 摘除）。
queue 与 chat 面必须选定，不允许悬空。

**验收标准**：未归类 = 0；**五类**各有计数与清单且并集 = 全部工具名集合；queue 面的「当前无生产者」声明写入 `ARCHITECTURE.md` 与 `packages/dsh-luoome/README.md`。

---

#### REQ-M1-09 财务 revision 时点可得性 spike

**背景**：P4=C 的难点不在抓数在抓时点。初稿把验证放 M4，等于 10–19 周后才知道走不通。

**需求**：只验证不实现（1–2 天）。抓 1 家公司 3 期财报，回答四问：
① 能否区分「新一期披露」与「旧一期被修订」；② 能否拿到 `publication` 与 `revisionPublishedAt`；
③ 同一 metric 两次抓取的值变化能否归因到修订；④ 若不可得，是否有可接受代理（公告时间 + 摘要校验）。

**验收标准**：四问各有明确答案与取证（URL / 字段名 / 样本值），产出 `output/dsh-brainstorm/revision-spike.md` 并回写 §10 K4 状态。
**若结论为「不可行」，REQ-M4-05 立即改道，不进入 M4 排期。**

---

#### REQ-M1-10 读者基建（术语表 / 状态机 / 旅程矩阵）

**背景**：本文是三个读者共用一份（产品读 §3–§5、开发读 §6、未来 agent 读全篇）。缺三样东西。

**需求**：
1. **术语表**（已在 §11，本需求负责保持与 `CONTEXT.md` 同步）：`pit` / `restated` / `legacy` / `missingFacts` / `targetPctRange` / gate / 暴露面 / `partial` / `unavailable` / Operation 回执 / 精确任务授权。
2. **状态机图**：`TradingPlan` draft→active→superseded/revoked/expired；`Advice` 生命周期；`evaluation session` 生命周期；M1–M5 阶段门。
3. **需求 × 旅程矩阵**（§3.0 已给出承接种，本需求补完整 54×6 覆盖表，标出每格「有承接 / 本期不补 / 不适用」）。

**验收标准**：`check-docs` 断言三样齐全；术语表条目与 `CONTEXT.md` 同名概念无冲突（对账脚本）；矩阵中每格有明确取值，无空白。

---

### M2 — 删旧面 + 补必需能力

> 通则：每条删除**同批**删除测试、脚本、CI step、文档章节，并给出「删除后仍能通过的命令」。
> **顺序原则：先补能力，再改脚本，最后删目录。**

#### REQ-M2-01 批处理白名单与角色常量迁出

**需求**：`BATCH_TOOL_NAMES` 与 `StandaloneRole` 从 `packages/dsh-bridge` 迁到 `packages/batch`。

**验收标准**：`deploy/dsh/batch-tools.test.ts` 改断言 `packages/batch` 名集合；五个批处理入口 `sideEffect` 均为 `write`。

---

#### REQ-M2-02 删除 `packages/dsh-bridge`

**需求**：删整包 + `infra/dsh/build.ts` 的两个旧 entrypoint + 根 `package.json` 的 `test:dsh`。

**验收标准**：`typecheck` / `test` / `lint` / `build` / `build:dsh-luoome` 全绿。

---

#### REQ-M2-09 surface 定义归位

**需求**：暴露面判定（名字 / 能力 / 副作用 / 私人研究拒绝清单）归位到 `packages/tools/src/exposure/`，
只暴露纯数据契约，不引入任何 `@deepseek-ai/*` 类型；插件侧做适配。

**验收标准**：`check:layers` 新增「`packages/tools` 不含 `@deepseek-ai/`」断言；MCP 面与插件面对同一工具判定一致（对账测试）。

---

#### REQ-M2-03 删除 stdio MCP 用户入口（保留 surface 定义）

**需求**：删 `packages/mcp` 的 bin / server / transport、`deploy/dsh/mcp-tool-probe.ts`、`deploy/dsh/settings-tools.ts`、
根 `package.json` 的 `test:analysis-surface` 与 `mcp:smoke`；先迁 `analysis-surface.e2e.test.ts` 的写回契约到 `dsh-luoome`。

**验收标准**：`test:all` 通过；`test:plugin-install` 通过；写回契约有等价测试；`USER_GUIDE` §6 标记下线。
**依赖**：仅硬依赖 M2-09（与 M2-02 无实际依赖，可并行）。

---

#### REQ-M2-04 迁移 CLI 独有能力

**需求**：迁出三项：
1. **诊断** → **`settings` 面板内的 `section=diagnostics`**（**不新增顶层面板**，避免与 M3-09 的面板计数冲突）；
2. **手动补跑批处理** → 策略面板（复用 `client/daily-cycle.js` 范式）；
3. **工具清单** → `bun run tools:list`。

**验收标准**：
- 诊断：3 类坏数据 fixture（缺行情 / 迁移未完成 / 连接失败）下页面各渲染 ≥1 条结论，结论含**具体表名或字段名 + 日期**；
- 补跑：点一次产 1 条 Operation 回执，回读状态一致，`get_closing_batch_audit` 可查该批次；
- `tools:list`：输出非空且未归类 = 0。

**运行环境**：诊断页需浏览器验收（`test:panels-browser` 范式，手动）。

---

#### REQ-M2-08 完整账户维护（**v3 新增，P0**）

**背景**：`packages/dsh-luoome/README.md` 明示「完整账户维护……尚未全部迁入插件」；产品报告列 P0（「产品可独立成立」级）。
没有它，用户记不了成交、改不了现金，后面所有仓位/收益/风控数字都建立在一条更新不了的账户上。
v2 把它压进了 M4-01 的「迁移 4 项」，压丢了。

**需求**：持仓面板提供三个写操作，走既有 operation 内核：
1. 登记成交（`add_trade`，**保持人工记账 write，不是 trade 能力**）；
2. 平仓 / 减仓（`close_holding`）；
3. 现金流水（入金 / 出金 / 分红 / 费用）。

**验收标准**：每个操作产出冻结输入的 Operation 回执且可回读；`add_trade` 的 `sideEffect` 仍为 `write` 而非 `trade`；
`advice` 与 `trade` 分类不变；账户事实指纹随操作变化（保障 M3-03 的区间失效逻辑）。

**依赖**：硬 M1-03（暴露面守卫必须先能回答「这个工具该不该暴露」）。

---

#### REQ-M2-10 导入恢复（**v3 新增，P0**）

**背景**：换机与版本升级的唯一路径；当前只有 `apps/web` 实现，而 M2 删 CLI 后就再无入口，M4-01 才迁——
中间形成能力空窗（见 §10 K10）。必须与 CLI 删除同批或先于它。

**需求**：SQLite 预检只读 → 账户/持仓/成交/建议计数对比 → 事务写入 → Operation 回执 → 幂等。

**验收标准**：导入前后四类计数完全一致；重复导入幂等（第二次返回原回执）；导入失败整体回滚不留半写；
预检阶段不写库。

**依赖**：硬 M2-08（先有维护入口，导入结果才可验证）。

---

#### REQ-M2-05 删除 `packages/tui` 与 `packages/cli`

**需求**：删两包，同步删 `cmdMcpServe` / `cmdTui` / `web serve` / `watch` / `daemon` 子命令与依赖声明。

**验收标准**：`typecheck` / `test` / `lint` / `build` 全绿；`rg "@luoome/(cli|tui)"` 零命中（测试除外）。
**依赖**：硬 M2-04、**M2-08、M2-10**（能力先迁后删）。

---

#### REQ-M2-06 删除部署侧旧 MCP 过渡面

**验收标准**：`deployment-config.test.ts` 负例改为「文件不存在」；`entrypoint.sh` 与 `plugin-switch-acceptance.ts` 断言仍成立；`test:plugin-install` / `test:mvp-journeys` 通过。

---

#### REQ-M2-07 覆盖率基线增量重设与 CI 同步

**背景（v3.4 二次修正算术错误）**：v3 写「被删 42 个测试文件 + 文件数降 10%–15%」——**两处都不成立**。

- **42 的错**：v3 把 `apps/web` 的 29 个测试文件算进「M2 被删五面」，但 `apps/web` 由 **M4-01** 删除，不在 M2。
  M2 实际删除测试文件 **17 个**：`packages/cli` 6、`packages/tui` 1、`packages/dsh-bridge` 3、
  `packages/mcp` 3、`deploy/dsh` 4。
- **10%–15% 的错**：这个指标方向就是错的。M2 一边删旧面（−17），一边为新能力加测试（+17：
  T47 账户四写、T48 导入/gate/备份、T14 诊断与补跑等），**净值 ≈ 0（实测 −4）**。
  用「测试文件总数下降」衡量删面收益，会把「新增能力有测试」当成坏事，与实际质量目标冲突。

**需求**：
1. 每个删除 PR **内联重设基线**（增量下降），不等到阶段末尾。
2. 每删一个面，同批删对应脚本与 CI step。
3. CI 纳入 `test:plugin-install` + `test:mvp-journeys`；`test:panels-browser` 保留手动并写入 README。
4. 新增 `bun run test:baseline` 产出基线文件（**不写死数字**）。

**验收标准（v3.4）**：
- **M2 删除的 17 个测试文件在 `test:all` 中零残留**（逐文件断言，不看总数）：
  `packages/cli` 6、`packages/tui` 1、`packages/dsh-bridge` 3、`packages/mcp` 3、`deploy/dsh` 4；
- **`bun run test:baseline` 产出基线文件**，内容含 `test:all` 的文件数与用例数，**不写死数字**；
  任何 PR 改动测试数量必须重跑脚本更新基线，不允许手改常量；
- 覆盖率基线重设为删除后实测值，PR 模板记录差因（预期 ≤2pp 波动）；
- CI 绿灯且 step 列表含 `test:all`、`typecheck`、`check:layers`、`test:plugin-install`；
- **不再以「测试文件总数下降百分比」作为验收指标**（理由见背景）。

---

**v3.4 修订说明**：本条原始意图是「删面后不留孤儿测试、基线不漂移」。用百分比表达会诱导
「为了达成下降而少写新测试」，故改为**残留清单 + 脚本基线**两个可验证事实。

---

### M3a — 补能力·核心

#### REQ-M3-01 回溯轨观察流水线

**背景**：P9。代码已支持回溯观察（`create_strategy_observation_candidates` 的 `evaluationSessionId` 分支，
校验 `run.scope === 'evaluation'` 且属同一 session 且已完成）。baseline 由
`packages/core/src/strategy/evaluator.ts:270-280` 写入 `evaluationSnapshot.baseline`（**已复核，前提成立**）。

**需求**：新增回填 workflow：历史区间 → evaluation session 逐日 replay → 观察候选（带 `evaluationSessionId`）
→ `vintage='restated'` 观察。不写 operational 前态、不改 `publication`、不生成 Advice。产出报告含样本数、
覆盖天数、缺失原因分布、vintage 标注。

**验收标准**：
- 产出 `restated` 观察；operational 统计 before/after **字节级相等**。
- **历史行情断言**：同一区间跑两次（历史 checkpoint vs 故意喂当前行情），`baselinePrice` 必须不同，
  且 checkpoint 版等于该交易日收盘价。
- **vintage 逐行断言**：`rows.length === rows.filter(r => r.vintage === 'restated').length`，且 `sourceKind` 与 `vintage` 不互推。
- **历史性硬约束**：`restated` 的观察与信号**不得**用于 ①「策略历史命中」陈述 ② Advice 证据链 ③ DecisionReview 的「当时依据」——三条路径各一条拒绝测试。
- **边界三分法（v3.1 修正，原为二分法）**：产品文案必须写清三类，不能只写「能补 / 不能补」——
  **(a) 可补**：IC / RankIC、分位收益、gross 毛收益、break-even cost、规则换手、参数邻域方差；
  **(b) 看似可补实不可补**：可实现换手（受容量约束）、信号胜率**不等于**建议命中率（同名不同物）、
  IC 的幸存偏差（幸存者股票池前视）、超额收益（需同 cutoff 基准）、成本后净收益；
  **(c) 能补但被排除**：任何需要「当时可见性」的结论（信号历史性、建议兑现）。
  三类各给一句面向用户的说法，避免用户把 (b) 当 (a)。

**运行环境**：Node 24。

---

#### REQ-M3-13 IC / RankIC 计算层

**背景**：回溯轨声明用来「补 IC」，v2 里没有任何需求实现 IC → 产出无人消费。按 P7=趋势，排序能力是准入门槛而非附属指标。

**需求**：`packages/core/src/strategy/ic.ts` 新增：输入逐日 `StrategyResult.score` 横截面 + 次日收益；
输出逐日 IC / RankIC、均值、标准差、IR、正 IC 占比。新增 `get_strategy_ic` 只读工具进 allowlist。
必须按 `vintage` 分组，不同 vintage **不得**合并成单一数字。样本 <20 交易日返回 `unavailable`；缺失日不填 0。

**验收标准**：25 日固定样本逐日 RankIC 与 IR 等于复算值（1e-6）；19 日返回 `unavailable`；pit / restated 分组不混算。

---

#### REQ-M3-02 结构化 `missingFacts`

**需求**：`analysis-context` 增 `missingFacts: Array<{ kind, subjectId, reason, asOf }>`；**保留**原 `limitations: string[]`
用于展示与兼容；`get_analysis_context` 逐条填充；技能正文更新为可引用条目。

**验收标准**：旧消费方读 `limitations` 行为不变；缺数据场景 ≥1 条且 `kind` 可枚举；
**引用一致性 checker 存在，且对一份构造报告输出 ≥1 条具体不符项**（引用不存在的 factId / 空缺口编号）。

---

#### REQ-M3-03 `targetPctRange` **+ 结构化失效条件**（v3.1 按金融评审重写）

**背景**：P3 承诺「目标仓位**区间** + **失效条件**」。v3 只做了区间，且**区间本身写错了量纲**。
`invalidationConditions` 现状是 `z.array(z.string().min(1))` 自由文本（`packages/core/src/entity/trading-plan.ts:190`），
不可被确定性代码检查。**而结构化类型 `TradingPlanConditionSchema` 已经存在**（同文件 :43-60，含
`kind ∈ {price-range, price-threshold, change-pct-threshold, market-fact, manual-confirmation}`、`phase`、
`comparator`、`metric`、`factId`，注释写明「LLM 不能把自由文本当作已验证事实」），只是没被用作失效条件。

> **v3.1 修正的三处硬错（金融评审 F1/F2/F3，均有源码证据）**：
> 1. **量纲错**：`TradingPlanPositionSchema.targetPct` 是 `z.number().min(0).max(100)`（**百分点**，
>    `trading-plan.ts:127`），预算上限 `singleStockPct` 默认 `30` 也是百分点（`trading-plan-budget.ts:14,28`）。
>    v3 写的 `≤ 0.30` 是比例单位 → 与持久化字段差 **100 倍**，且「兼容旧单值」会让两套单位并存而无人报错。
> 2. **`0 < min` 堵死减仓**：`exit` / `avoid` 类计划目标仓位应为 0，`min > 0` 使其恒不可满足。
> 3. **选点不可判定**：只有 `rangePick` 枚举、没有落库的实际取值，复盘无法回答「当时为什么是 8%」。

**需求**：

**A. 单位与不变量**
1. `targetPct` → `targetPctRange: { min, max }`，**单位为百分点 0–100**，与 `currentPct` / `deltaPct` /
   `singleStockPct` 同量纲；保留旧单值读取兼容（读旧值时 `min = max = targetPct`）。
2. 不变量：`0 ≤ min ≤ max ≤ limits.singleStockPct`。
   **按 action 分档**：`add` / `hold` 类要求 `min > 0`；`exit` / `avoid` 类允许 `min = max = 0`；
   其余 action 不得出现 `max = 0` 与 `min > 0` 并存的自相矛盾组合。
3. **分层宽度按百分点**：`max ≤ 10` → `max − min ≤ 4`；`max ≤ 20` → `≤ 6`；`max ≤ 30` → `≤ 8`。
   同时校验相对宽度 `(max − min) / max ≤ 0.30`（`max = 0` 时跳过），**二者取更严**。

   **v3.5 澄清「取更严」的实际含义**（此前验收示例与此条冲突，已修正）：相对规则在中小目标上必然先绑定，
   因此**实际允许宽度 = min(分层上限, 0.30 × max)**：

   | max | 分层上限 | 0.30×max | **实际上限** | 绑定方 |
   |---|---|---|---|---|
   | 10 | 4 | 3.0 | **3.0** | 相对 |
   | 20 | 6 | 6.0 | **6.0** | 相等 |
   | 25 | 8 | 7.5 | **7.5** | 相对 |
   | 30 | 8 | 9.0 | **8.0** | 分层 |

   相对规则的存在理由（H4）：防止大目标用「宽区间」把纪律架空；在 `max ≤ 20` 区间它同时收紧小目标的
   相对宽度，避免 `6–10` 这种「40% 相对带」被当成有纪律的区间。
4. 预算占用与单票上限**一律用 `max`** 计算（保守口径），并在回执中同时输出 `min 合计` 与 `max 合计`。

**B. 选点与落库取值**
5. 选点规则强制枚举 + 参数：`rangePick ∈ { ruleId, params }`，`ruleId ∈ { 'lower-bound', 'mid', 'volatility-scaled' }`；
   `'volatility-scaled'` **必须带参数**（至少 `volatilityMetric` 与 `tiers`），否则拒绝。
6. **必须落库 `appliedPct`**（本次实际采用的百分点值）与 `fallbackPct`。
   不变量：`min ≤ appliedPct ≤ max`；`fallbackPct === min`（降级到下限）。
   没有 `appliedPct`，复盘无法回答「当时为什么是这个仓位」，F2 指的就是这一点。
7. `rangePick` 缺失或 `volatility-scaled` 缺参数时**拒绝发布**。

**C. 预算与状态机**
8. **预算冲突的分档处置**（替换 v3 的「软提示不阻断」——它与本需求第 10 条自相矛盾）：
   - `draft`：**可保存**，冲突只记 `constraintStatus='blocked'` + `constraintReasons`；
   - **`draft → active`：超限必须阻断**并抛 `InvariantError`，与第 10 条同一条规则。
9. `deltaPct` 在区间下**不再持久化为派生值**：改为读取时计算 `deltaPctMin = min − currentPct` 与
   `deltaPctMax = max − currentPct`；旧记录的单值 `deltaPct` 保留读取兼容。
   （原因：区间使 `deltaPct = target − current` 无定义，而它是有 `min(-100).max(100)` 校验的持久化字段。）
   **必须同步修改既有硬不变量**：`packages/core/src/entity/trading-plan.ts:284-289` 现有一条
   「`deltaPct` 必须等于 `round(targetPct − currentPct, 2)`」的 `InvariantError` 校验——
   区间计划会让这条**对每个新计划都抛错**。实施时必须把它改为按 action 与 `appliedPct` 求值，
   或在有区间时跳过该断言并改用 `deltaPctMin/Max` 校验。**注意：`deltaPct` 位于 `plan_json` 内，
   而 `plan_json` 是唯一完整领域载荷（见 `CONTEXT.md` §逐股交易计划），不能只在列层改。**

**D. 失效条件**
10. **`active` 计划必须 ≥1 条结构化失效条件**（v3.5 修正：原写「非 draft」，但 `expired` / `cancelled` 已不再触发任何动作，强制它们补规则只增加迁移负担而无纪律收益；`draft` 与终态计划豁免），复用 `TradingPlanConditionSchema`，
    `phase ∈ {exit, risk}` 或 `kind === 'market-fact'`；`invalidationConditions` 保留为展示层，
    **但不得作为唯一失效表达**。
11. 区间与失效条件**随账户事实指纹变化一起重算**，不得沿用旧区间或旧失效条件。
12. 观察计划（`watch → observe`）同样携带区间、`appliedPct` 与结构化失效条件。

**同步清单**：Core entity（schema / 类型 / 不变量 / 导出 / 测试）；Repository（接口 + drizzle + memory +
contract tests + DDL 幂等迁移）；Tool；Workflow（`WorkflowToolMap`）；API/Web（计划面板需显示 min / max 两个合计与 `appliedPct`）。

**验收标准**（全部为可判定断言）：
- **量纲**：`targetPctRange` 取值 0–100；旧单值 `targetPct=30` 读出的区间为 `{min:30,max:30}`；
  拒绝 `{min:0.1,max:0.3}` 这类比例值（证明不会两套单位并存）。
- **action 分档**：`exit` 计划 `{min:0,max:0}` 通过；`add` 计划 `{min:0,max:5}` 被拒（`min` 必须 > 0）。
- **分层宽度**（v3.5 修正，按上表实际上限）：`max=30` 宽度 8 过 / 8.01 拒；`max=25` 宽度 7.5 过 / 7.51 拒；`max=10` 宽度 3 过 / 3.01 拒，**宽度 4 必须拒**（4/10 = 40% > 30%，作为相对规则的负例）。
- **选点**：缺 `rangePick` 拒绝；`volatility-scaled` 缺 `tiers` 拒绝；落库后 `min ≤ appliedPct ≤ max` 且 `fallbackPct === min`。
- **预算**：三个 `max=30` 的计划合计 **90 百分点**——**刻意不超 100**，用于验证「合法组合不被误伤」；
  另加一个 `max=40` 使合计 130 百分点，验证 `draft` 可存但 `draft → active` 抛 `InvariantError` 并给出按 `min` 复算的数值。
  （v3 原用例只有三个 30% 合计 90%，产生不了超限，测试恒绿——这是评审 F3 指出的缺陷。）
- **deltaPct**：区间下不再持久化派生值；读取返回 `deltaPctMin` / `deltaPctMax`；旧单值记录仍可读；
  **负例**：创建区间计划不得触发 `trading-plan.ts:284-289` 的旧不变量抛错（改造前该测试必须红）。
- **失效条件**：`draft → active` 缺结构化失效条件抛 `InvariantError`；三条件齐备时转换成功并留痕。
- **指纹**：账户事实指纹变化后旧区间与旧失效条件同时失效。
- **迁移幂等**：连续启动两次结果一致。
- **guard 强断言**：构造 `restated` + `t20` + `tactic-signal` 三条同时命中的行，迁移后**仍保持 `restated`**；
  同批的 `pit` + `t20` 行被降级为 `legacy`（作为「迁移确实执行」的对照）。

---

#### REQ-M3-19 PIT universe 属性快照（**v3 从 M4-04 前移到 M3a**）

**背景**：`stock_universe_snapshot_members` 只存 `sync_id + stock_id`，`listSnapshotMembers` 回 join 当前
`stocks` 取 industry/name → 属性前视。它本身是 REQ-M3-04 的前置，留在 M4 会造成跨里程碑倒置。

**需求**：snapshot members 扩列存 `listing_status` / `industry` / `list_date` / `delist_date` 快照值。

**验收标准**：与当前 `stocks.industry` 冲突时以快照为准；PIT 查询返回快照期属性。

---

#### REQ-M3-04 严格回测 market facts 生产者

**需求**：
1. 新增同步任务：按 evaluation day 的 `revisionCutoff` 从 `daily_bar_revisions` 读 OHLCV，叠加 PIT universe 的
   `listing_status` 与涨跌停价判定，写 `strategy_backtest_market_facts`，并写 `corporateActionsStatus`。
2. **涨跌停价口径**：由「前收盘价 × 板块幅度」确定性计算，幅度表版本化（`tradability-rule-v1`）；
   ST 状态取自 PIT universe 快照属性；无前收盘价或无 ST 状态时该日 `partial` 并列出缺失。
   不得从行情源直接取（口径不可审计）。

**验收标准（v3 修正：不再承诺 M3 内 `complete`）**：
- `tradability` 从 `partial` 升为 `complete`；`market_facts` 表有数据。
- 门禁审计**逐项**列状态：`pit-universe` `complete`（依赖 M3-19）；`corporate-actions` **明确 `unavailable`**
  并标注「无分红送转数据源，属 §8 不在本期范围」；其余项按事实如实。
- **不要求** `gateAudit.status === 'complete'`——因为 `corporate-actions` 在本期无数据源，
  强行要求会造出「永远红的验收」或诱导伪造数据。
- **数值正确性**：固定 5 股 × 3 日日线 + 一份 spec，断言 `metrics` 每项等于手算值（1e-6），含佣金 / 最低佣金 / 印花税 / 滑点四项分解。
- 同一 spec + 输入指纹重跑得到同一 run。

**运行环境**：Node 24。**依赖**：硬 M1-05、M3-19。

---

#### REQ-M3-11 暴露面判定与 DSH per-agent 可见集合并

**背景**：插件内 4 套 allowlist 重复实现 DSH `dsh-tools` 已有的 per-agent 可见集收窄。P8 要求「子 agent 不继承父权限」，
这正是 DSH 已提供的能力。**前置**：先做半天 spike 确认 DSH `0.2.1-rc.2` 的 per-agent 接口稳定；
不稳定则退化为「保留插件侧判定 + 加与 DSH 的对账测试」，不阻塞 M4-02。

**需求**：可见集裁剪交给 DSH per-agent；插件只保留「能力 + 副作用」判定；私人研究拒绝清单保持在 `tools/src/exposure` 单点。

**验收标准**：权限负例全绿（未授权调用返回 `permission_denied`）；agent-scoped 测试证明子 agent 看不到父写工具；`check:layers` 通过。

---

#### REQ-M3-12 evaluator code identity 改真实文件 SHA-256

**需求**：对求值器源码文件集合计算 SHA-256，纳入 run 身份。

**验收标准**：改 evaluator 代码后 `strategyRunUsesEvaluator` 不匹配；不改代码时重复计算稳定；该 hash 进入 run 身份可审计。

---

### M3b — 补能力·可见性

#### REQ-M3-06 组合风险只读工具

**验收标准**：缺价返回 `unavailable` 而非 0；输出带基准 / 窗口 / `dataAsOf`；与 `targetPctRange` 的 `max` 语义一致。

---

#### REQ-M3-07 账户层归因与超额收益可见

**需求**：`get_account_performance` 进 read allowlist；快照摘要带 TWR / 基准 TWR / 超额 / 完整性。

**验收标准**：覆盖不足只返回状态与缺失日期，不填 0；归因指向 fact id；样本不足写「不足」不给百分比。

---

#### REQ-M3-14 单条建议的事后归因

**需求**：按 Advice 关联的成交与观察给出单条贡献度（金额与占比）；区分「已成交 / 未成交 / 未回填」三态。

**验收标准**：无成交或未回填返回 `unavailable`，**不得用观察收益冒充实际盈亏**；有成交时贡献度之和与账户层可对账；每条结论可追到 `adviceId` + `tradeId`。

---

#### REQ-M3-08 报告以交付物形式呈现（五类）

**需求**：盘前简报 / 开市 / 收盘 / 日复盘 / 风险五类，各一个「生成并交付文件」动作，落 `$LUOOME_HOME/reports/`，
经 DSH `present` 交付，对话给文件卡片。

**验收标准**：文件存在且可**解析出五段**（`dataAsOf` / 反证 / 免责 / 有效期 / 结论），任一缺失即红；
文本正则不含 `买入|卖出|已建仓|下单`；`present` 产出恰好 1 张卡片；文件内容与工具结构化输出字段级 diff 为空。

---

#### REQ-M3-17 盘前交付物四段结构 + 交付时点（**v3 新增，P0**）

**背景**：产品报告对盘前期望形态的原话是「账户 / 隔夜 / 既有建议+反证 / 观察条件」四段，08:45 前送达。
v2 只要求「可打开 + 含 dataAsOf/反证/免责/有效期」——没有结构约定，`morning-brief` 迁进来仍是一篇自由长文，
用户「不知道今天必须看什么」的断点没被解决。

**需求**：盘前简报固定四段：① 账户概览（含 `dataAsOf` 与可用性）② 隔夜事实（指数 / 要闻 / 事件，带来源与观察时间）
③ 既有建议与反证（含有效期）④ 今日观察条件（触发价 / 条件 / 失效条件）。交付时点由 REQ-M4-06 的定时档位驱动，目标 08:45。

**验收标准**：四段各有一个可断言的结构字段，缺段即红；每段内的数字都带 `dataAsOf`；
在定时档位开启时，08:45 前产出且落 `$LUOOME_HOME/reports/`；四段顺序固定。

**依赖**：硬 M3-08；交付时点部分依赖 M4-06。

---

#### REQ-M3-09 事实缺口 UX 一致性

**需求**：
1. 仓位 / 收益 / 命中率 / 建议四类数字，出现即带 `dataAsOf` 与可用性。
2. 建议固定卡片五段：结论 / 反证 / 风险 / 有效期 / 免责。
3. **`PANEL_NAMES.length` 个面板**顶层均有「数据健康」角标（**不写死数字**；诊断页是 `settings` 内的 section，不新增顶层面板）。
4. `FundamentalScore` 在 `gate=not-ready` 时零数字输出。
5. 提醒消息必须含触发价、止损 / 目标价、反证、风险、有效期、卖出限制；缺任一项则该条**不投递**并记 `not-requested`。

**验收标准**：缺价账户不出现百分比仓位；面板角标数量 === `PANEL_NAMES.length`；
**渲染函数在五段任一为空时阻断渲染并报缺段名**，5 组缺段 fixture 逐条红（不靠人工看截图）；
构造缺要素提醒，断言未投递且状态 `not-requested`。

---

#### REQ-M3-18 outcome 结构化回填（**v3 从 M5-03 前移，P0**；v3.1 补来源标记）

**背景**：P5 已拍板「兑现只由用户回填」，但 v2 把回填入口放在 M5-03（19 周+），而 M3-10 在 M3 统一口径并输出分母——
**分母的来源要等到 M5 才有**，中间统计口径统一了却长不出样本。这是顺序倒置。

**需求**：
1. 复盘页提供结构化回填：**兑现 / 部分兑现 / 忽略 / 不知道** 四选一（`ask-user` 实现，S 级）；
   AI 不得预选、不得代填；选项必须含「不知道」。
2. **写入侧必须带 `origin`**（`user` / `model` / `import`）并落库——v3.1 补：只堵「AI 代填」的入口不够，
   `record_advice_outcome` 仍可在其它会话被直接调用。
3. **统计侧按 `origin` 过滤**：`get_advice_stats` / `get_confidence_calibration` 默认只统计 `origin='user'`，
   非 user 来源必须显式请求且在输出中披露数量。

**验收标准**：回填后 `get_advice_stats` 的 `denominator` 同步变化且可解释；脚本模型尝试代选时测试必须红；
四选项齐全，缺「不知道」即红；回填记录与客观成交分表存储；
**构造一条 `origin='model'` 的回填，断言默认统计不含它且输出披露被排除数量（负例）。**

**依赖**：与 REQ-M3-10 同批验收。

---

#### REQ-M3-10 命中率口径统一（v3.1 按金融评审细化）

**需求**：
1. 统一为「明确 followed 且填有 pnl 的**已了结**样本中 pnl>0 占比」；**分母排除未了结样本**并披露其数量。
2. 输出 `denominator`、`minimumSampleMet`、`excluded`（未了结 / 非 user 来源 / `partially_followed` 各自计数）。
   `partially_followed` **不得静默排除**，必须单列计数。
3. **并列 `excessHitRate`**：绝对 `pnl > 0` 会被 beta 污染，需同时给「扣基准后仍为正」的比率；基准缺失时该项 `unavailable`。
4. 最小样本门槛 <20 不给分组结论，**并在输出中给出该门槛下的置信区间宽度**（n=20、p=0.5 时 95% 区间约 [0.30, 0.70]），
   让调用方知道「20 条也只够看趋势」。
5. 输出**口径版本号** `metricVersion`，口径变更即升版，旧结果不被新口径覆盖。
6. `get_confidence_calibration` 注释与实现对齐。

**验收标准**：两工具同窗口同结果；输出必带分母、`excluded` 三类计数与 `metricVersion`；
19 个样本时拒绝分组；构造含未了结与 `partially_followed` 的样本，断言它们不进分母但进 `excluded`；
基准缺失时 `excessHitRate` 为 `unavailable` 而非 0。
**依赖**：硬 M3-18（否则分母无来源）。

---

#### REQ-M3-20 `advice_market` 跨日引用禁令（**v3.1 新增，承载 P10**）

**背景**：P10 已拍「禁止跨日引用」，但 v3 的 53 条需求里**零承载**——决策没有落地对象。
A 股市场状态一天即变，现有「写回窗口 24h + 数据有效期 7 天」本身就是伪精确的来源。

**需求**：
1. `advice_market` 类分析上下文的可用窗口收窄为**当日**（Asia/Shanghai 自然日）；跨日读取返回 `unavailable`
   并给原因码 `market-advice-same-day-only`。
2. 报告与对话中引用市场级判断必须带 `observedAt`；超过当日 15:00 的引用降级标注为「历史观察」，
   不得作为当前依据进入建议链。
3. 会话内不追溯：昨日会话的市场结论不出现在今日 `get_analysis_context` 的可用事实里。

**验收标准**：
- 跨日读取返回 `unavailable` + 上述原因码；
- 报告渲染层不存在「无 `observedAt` 的市场级判断」（一条渲染断言）；
- 构造昨日 `advice_market` 上下文，今日 `get_analysis_context` 不包含它（一条负例）；
- 当日 15:00 后引用当日观察被标为「历史观察」而非直接删除。

---

#### REQ-M3-15 其他供应商凭据配置（**v3 新增**）

**背景**：`README.md` 明示未迁入；产品报告列 P0（「单源无冗余，用户付费源用不上」）。
P4 选自建采集后，用户自带的合法数据源更该可接。

**需求**：设置页多供应商分区；密钥 `0600` 且不回显；空值保留原密钥；保存立即生效且重启后保留。

**验收标准**：新增 1 家源后可切换并成功取一条真实行情；已配置密钥留空保存后仍保留且不回显；
配置文件权限断言为 `0600`。

---

#### REQ-M3-16 external 市场事实持久化（**v3 新增**）

**背景**：`README.md` 明示未迁入。它是「研究结论可回溯到当时那条公告」的唯一底座，也是 §7.2 诚实性的前提——
M3-09 要求 Advice 每条可独立成立，但外部事实根本无处落库。

**需求**：抓取 → 落事实（带 `source` + `observedAt`）→ 可被 strategy 证据引用；**未落事实不得进 Advice**。

**验收标准**：每条外部事实有 `source` 与 `observedAt`；未落库的外部内容进 Advice 时被拒绝（一条负例）；
引用链路可从 Advice 追到具体事实 id。

---

### M4 — 收口

#### REQ-M4-01 `apps/web` 能力迁移与旧看板下线

**需求**：按 P1 裁决——迁：��据导入导出（M2-10 已提前）、告警规则编辑、通知目标、交易计划面板；
废：飞书通知、研究库远程同步开关、草稿 / 工作区、账户绩效快照 API（由面板重做）。然后删 `apps/web`。

**验收标准**：**每条迁移项 1 条 e2e**：动作 → Operation 回执（含冻结输入）→ 面板回读一致；四项缺一即红；
四个废弃项各有一条用户可见说明（对应 M4-09）；删除后 `typecheck` / `test:all` / `build` 全绿，`test:web` 与 CI step 已删。

---

#### REQ-M4-10 盘中「触发 → 改条件」闭环（**v3 新增，P0**）

**背景**：产品报告判定「看到触发 → 想改条件 → 被迫跳对话重述上下文」是**最高频流失点**。
v2 只有 M4-01 的「告警规则编辑迁移」，没有「从触发到改规则」的动作路径与回执要求。

**需求**：在触发详情内提供两条路径——① 就地编辑条件（阈值 / 方向 / 通知目标）；② 一键生成对话草稿（复用关注页「交给 AI 管理」范式）。
两条路径的改动都产生 Operation 回执，且面板可回读。

**验收标准**：从触发详情就地改阈值 → 回执 → `list_alert_plans` 立即反映新值；
草稿路径生成的可编辑会话不含自动发送；两条路径各 1 条 e2e；改完不动历史 WatchTrigger 记录。

**依赖**：硬 M4-01。

---

#### REQ-M4-02 多空风控三角

**需求**：
1. 一次分析装配**一个** AnalysisContext，所有角色共享 `contextId` 与 `factIds`；角色间只传 fact 引用。
2. 四角色：多头（支持证据 + ≥3 条可证伪条件）、空头（专职证伪）、裁决官（只核对与并列，**无 buy/sell 权限**）、
   风险官（`pass` / `veto(reason+evidence)` / `need-more-data`）。
3. 裁决官必须把「因事实缺口而不下结论」作为一等公民输出。
4. **门槛**：`dataHealth=unavailable` 时禁止开启；**`partial` 时允许并推荐**。
5. **场景门槛（v3 新增）**：盘时段内禁止开启（返回独立原因码，不复用 dataHealth）；
   单票快问场景在提示中标注「不推荐」但不硬拦。
6. **事前成本（v3 新增）**：启动前展示预估 token 区间与预计时长，用户确认后才启动。
7. **降级路径（v3 新增）**：预算超限或超时（>15 分钟）自动降级单 agent，并在结果首段写明「已降级及原因」。
8. 写回仍走 `record_advice` / `record_analysis_result` 校验边界；子 agent 只读，不继承父权限。

**验收标准（**无条件式验收**）**：
- 分歧点定位到具体 fact id；`unavailable` 场景被拦截并给出原因；`partial` 场景产出「缺口清单 + 阻塞条件」。
- 结果首段含 `tokenUsed` 与 `elapsedMs`（**M4 内即为硬验收，不依赖 M5**）。
- `estimatedTokenRange` 在启动前展示且用户确认后才启动。
- 超时或超预算时输出含「已降级单 agent」及原因。
- 盘时段内开启被拒并返回独立原因码。

**依赖**：硬 M3-02、M3-06、M3-11。

---

#### REQ-M4-03 复盘 → 策略修订回路

**验收标准**：新研究 state 可读来源复盘 id；不产生自动发布；提案须引用具体 fact / 复盘 id。

---

#### REQ-M4-05 自建采集首个真实 PIT **质量** metric（v3.2 按 T09 spike 实测结论定稿）

**背景**：P4=C 选「自建采集」。T09 spike 已完成实测（见 `output/dsh-brainstorm/revision-spike.md`），
结论是**可走但必须走代理方案**：metric 级 `revisionPublishedAt` 无法直取，须由「定期报告 / 更正公告的
**文档级版本链** + 公告披露日」推导。

**spike 的硬证据（全部实测，2026-10-30）**：
- **可区分新一期与修订**：同 `(stock, metric, periodEnd)` 出现**新披露载体**=修订；`periodEnd` 递增=新一期。
  载体有两种：①「（更正后）」独立年报（实测 `002717` 同一 2022 年报三版：2023-04-29 / 2023-07-15 / 2026-10-28，
  id 与 PDF 字节均不同）；②《前期会计差错更正公告》，含更正前 / 累计影响 / 更正后三列。
- **时点可得**：`publication` 与 `revisionPublishedAt` 均取巨潮 `hisAnnouncement/query` 的 `announcementTime`
  （日粒度 00:00）+ `announcementId`。东财只有 `NOTICE_DATE`（首次披露日），**不够**。
- **值变化可精确归因**：康美 `600518` 2017A 营业收入 264.77 亿 → 175.79 亿，差 −88.98 亿，
  与 2019-04-30 更正公告「累计影响金额」**到分一致**。
- **东财单行是混合 vintage**：实测出现假阳性（2016 值未变但 `UPDATE_DATE` 变）、漏报（2017 停在 v2 缺 v3）、
  漂移（2018 `UPDATE_DATE` 比公告日早 4 个月）。→ **`UPDATE_DATE` 不得进入 PIT 逻辑。**

**需求**：
1. 打通**一个** metric 端到端：采集 → 写 `financial_fact_revisions`（带 `publication` / `revisionPublishedAt` /
   `recordedAt` 三时点 + `contentHash`）→ `resolveVintage` 按 asOf 正确取版本。
2. **首个 metric 改为「合并利润表营业收入」，不用 ROE**。理由（实测）：ROE 的口径不一致——公告值 7.20%
   与东财值 4.81%，且 ROE 是派生指标；营业收入是表内原始科目、更正公告必列、差额可直接校验。
3. **变更检测三层，职责分离**：
   - 层 1「公告版本集合差分」→ 判定因果（新一期 / 被修订），这是 `publication` 与 `revisionPublishedAt` 的唯一来源；
   - 层 2「PDF 值抽取 + `contentHash`」→ 判定内容是否真的变了；
   - 层 3「东财快照 `ingestHash`」→ **只告警不入库**，用于发现上游漂移。
4. **`recordedAt` 永不回填**。历史 asOf 查询落 `missing(recorded-after-cutoff)`——这是**覆盖率下降，不是前视**，
   必须在输出里如此表述，不得表述为「数据缺失」了事。
5. **日粒度按 T+1 规则**：`announcementTime` 为日粒度 00:00，当日 asOf 查询不得使用当日公告，最早可用日为次日。
6. 单条采集失败不产生半条事实；不得用抓取时间替代披露时间。

**验收标准**：
- 历史 asOf 取到当时可见版本；同一 metric 的修订保留双版本且可区分载体。
- 给定康美 `600518` 2017A 营业收入，v1 与 v2 数值差与更正公告「累计影响金额」到分一致（可直接作为 golden case）。
- `recordedAt` 回填检测：构造一条 `recordedAt > asOf` 的记录，查询返回 `missing(recorded-after-cutoff)` 而非该值。
- 日粒度：当日公告不被当日 asOf 使用（一条负例）。
- 层 3 的 `ingestHash` 命中时只产生告警，事实表零写入。
- 采集失败整体回滚；不得用抓取时间替代披露时间。

> **边界澄清**：本需求只打通**质量指标**的时点链路，**不构成估值能力**。
> 真正的估值（PB / PE）需要 PIT 总股本，本期明确不做，已写入 §8。

> **成本与改道（spike 结论）**：本需求约 **11–13 人日**，其中 PDF 表格抽取 6–8 人日是主要成本。
> 若后续要求「全市场 + 历史回补」，应改道采购带 `ann_date` / `f_ann_date` / `update_flag` 的源
> （Tushare 需 2000 积分，spike 未申请未实测），而不是继续加厚自建采集。

**依赖**：硬 M1-04、M1-09（已通过：结论为「可走 + 代理方案」）。

---

#### REQ-M4-06 自动化三档

**验收标准**：首启向导完成后设置页渲染 5 行 × 3 字段（下次到期 / `scheduleHash` / grant 版本）且值来自真实调度；
关→开→关产生 3 条 Operation 回执可查；非交易日返回 `skipped` 且事实表零写入。
「3 分钟」记为可用性目标，**不进断言**。

---

#### REQ-M4-11 盘后复盘草稿（**v3 新增**）

**背景**：产品报告要求「收盘后自动落一份复盘草稿，用户确认才写 DecisionReview」。v2 只解决了 P6 的「定时开」，
没定义开盘 / 收盘后自动产出什么。

**需求**：收盘后（由 REQ-M4-06 定时档位驱动）自动生成复盘草稿，落 `$LUOOME_HOME/reports/`；
草稿**不写** DecisionReview，用户确认后才写。

**验收标准**：定时档位开启时收盘后产出草稿文件；草稿存在时 `list_decision_reviews` 计数不变（证明未写）；
用户确认后写入且带来源草稿 id；不改原建议。

**依赖**：硬 M4-06、M3-08。

---

#### REQ-M4-07 文档即事实表与文档守卫

**需求**：重写 `ARCHITECTURE` §3/§9/§10/§11、`SECURITY` MCP 章、`USER_GUIDE` 入口章节、`AGENTS.md` 架构图；
新增 `infra/check-docs.ts`；**把本文纳入过期检查**（附录 A 的 asOf 过期即告警）。

**验收标准**：`grep -n "packages/dsh-luoome" docs/ARCHITECTURE.md` 有命中；`grep -rn "178 个 tool" docs/` 无命中；
`USER_GUIDE` 前 100 行不含 CLI/TUI 安装步骤；`check-docs` 进 CI；`git diff --check` 干净。

---

#### REQ-M4-08 CI 纳入插件形态验收

**验收标准**：CI 绿灯且含 `test:plugin-install` + `test:mvp-journeys` + 五类守卫（技能单一真源 / policy ⊆ registry /
vintage 混算 / restated 不可引用 / 文档过期）；`test:panels-browser` 在 README 标注手动。

---

#### REQ-M4-09 用户可见的入口下线说明

**验收标准**：四个被删入口各有「已下线 + 替代路径」条目；面板可访问；`CHANGELOG` 与 PRD 的 R 编号可对上。

---

### M5 — 开新能力

> 通则：每条必须有「不违反三条红线」的验收——`advice≠trade`、领域层零 AI 依赖、事实缺口诚实返回。

#### REQ-M5-01 长任务编排

**验收标准**：触发同步 ≤2s 返回 job id；**同一回合内可继续 ≥3 次工具调用**；job `kill` 后状态 `cancelled` 且输出可读；
失败输出含 `lastErrorKind`；调度不写入「数据是否到位」的判断字段（由 `get_market_data_status` 决定）。

---

#### REQ-M5-02 交付物体系扩展

**验收标准**：只导出已发布 / 已冻结内容；交付物内容与工具结构化输出字段级 diff 为空；
manifest 声明「不含供应商历史数据，不能保证异机重放」。

---

#### REQ-M5-03 三项轻量接入（**v3 移出 outcome 回填 → 已前移 M3-18**）

| 能力 | 断言 |
|---|---|
| 跨会话历史判断检索 | 命中结果必须回显原 `dataAsOf` 且标为**历史**；引用历史结论时不得当作当前事实 |
| 建议兑现评分接回统计 | 主观评分表与成交表分表，交叉查询不互写 |
| 成本可见（token 计量） | 只读；开启「自动降级开关」时启动失败（防止诱导跳过事实） |

**验收标准**：三项逐条断言，不用「各有一条 e2e」这种循环定义。

---

#### REQ-M5-04 完整多角色与风险官否决

**验收标准**：`veto` 后主 agent 无法继续写建议；升级路径可审计；每次否决有 reason + evidence。

---

#### REQ-M5-05 目标式长跑

**验收标准**：registry 无 `trade`；目标轮次内 tool 调用集不含交易类写；每轮 ≥1 个 `factId` 进产出；
每轮修订次数 ≤1；`blocked` 必带具体条件字符串。

---

## 7. 非功能需求

### 7.1 安全与副作用

- `advice` 永不等同 `trade`；`trade` 永不进 MCP / 队列结果类型 / 插件暴露面。
- `LUOOME_EXPOSE_TRADE=true` 在任何 IO 之前拒绝启动。
- 写能力保持显式 opt-in；新增工具必须正确声明 `sideEffect` 与 `requiredCapabilities`。
- owner 与账户由部署显式绑定；缺失即 fail closed。
- 子 agent 不继承父权限。

### 7.2 诚实性（核心质量属性）

- 指标类输出在事实缺口时返回 `unavailable` / `partial`，**不得用推断值、0 或中性值补齐**。
- 任何数字可追溯到 `dataAsOf` 与来源。
- 「回测 / 命中率 / 基本面分」的呈现必须与实际能力一致；**名实不符视同缺陷**（故 M1-05 前移）。
- `pit` / `restated` / `legacy` 三值必须可区分，不得未披露混算。
- `restated` 数据不得作为「当时判断」的证据。

### 7.3 可观测

- 外部数据源调用有 `SourceObservation`；workflow 执行有 `WorkflowRun` 审计；插件写操作有 Operation 回执。

### 7.4 兼容与迁移

- schema 变更必须双实现（drizzle + memory）+ contract test + 幂等启动迁移。
- 旧记录读取兼容优先于写入简化。
- 破坏性变更（`vintage`、`targetPctRange`、`invalidationConditions` 结构化）必须写明升级前备份与回退窗口，按 `USER_GUIDE` §7.7 备份流程。
- 不覆盖或删除用户未提交改动。

### 7.5 验收运行环境

`packages/dsh-luoome/src/host/production.ts` 依赖 `node:sqlite`（Node 22+ 内置）。**Bun 下加载会报
`No such built-in module: node:sqlite`**（已实测）。

| 验收类型 | 运行环境 |
|---|---|
| 纯领域单测 | Bun（`bun run test`） |
| 涉及 `production.ts` / 插件装配 / Node Drizzle repo | **Node 24** |
| db 合约测试 | Bun（`bun run test:db`） |
| 浏览器验收（面板） | Node 24 + 本机 Chrome（手动） |
| `tools:list` / surface 校验 | **Node 24** |

---

## 8. 不在本期范围

- **严格回测的净收益 / 回撤 / Sharpe**：`corporate-actions` 无分红送转数据源，`pit` 事实无法闭合。属 P2。
- **估值（PB / PE）段**：需要 PIT 总股本，本期不做。REQ-M4-05 只打通**质量指标（ROE）**的时点链路，**不构成估值能力**——避免出现「既没承诺也没排除」的中间态。
- 分钟线与日内策略。
- 板块 / 概念成分、股东户数、资金流日频历史。
- A/H 跨市场覆盖。
- 第三方 MCP 只读数据源接入、插件自助安装、权限预设（P2 实验项）。
- 多租户、托管、计费（已随 D9 下线，不恢复）。

---

## 9. 里程碑与验收门

| 里程碑 | 验收门（全部满足才进入下一阶段） |
|---|---|
| **M1** | §3.0 的 J1/J3/J4/J5 技能级 e2e 绿（每条四判据）；技能零 `mcp__`；三集合相等（8 条）；`surface-consistency` 绿且未归类 = 0；mock 隔离生效；vintage 三值混算被拦；`check:layers` 行为守卫绿；**`execute_*` 已出暴露面且文案零「严格回测」** |
| **M2** | 完整账户维护与导入恢复**先于** CLI 删除完成；每个删除 PR 内联重设基线；被删 42 个测试文件零残留；文件数降 10%–15%；CI 绿；`tools` 不含 `@deepseek-ai/` |
| **M3a** | 回溯轨 `restated` 观察 + IC 同批且分 vintage；restated 三条禁用路径断言绿；`missingFacts` 可被引用（checker 有断言）；`targetPctRange` 分层宽度 + 结构化失效条件全覆盖；PIT 属性快照到位；严格回测门禁逐项如实（`corporate-actions` 标 `unavailable`） |
| **M3b** | 账户层与单条建议归因可读且缺价 `unavailable`；五类报告可打开且五段齐全；盘前四段结构固定；提醒要素完整；outcome 回填可用且分母同步；多供应商凭据可切；external 事实可落库可引用 |
| **M4** | 仓库单一产品面；盘中闭环可用；多空三角在 `partial` 下产出分歧点与阻塞条件、`unavailable` 被拦、事前成本与降级生效；首个真实 PIT metric 可按 asOf 取版本；自动化三档与复盘草稿可用；文档守卫进 CI |
| **M5** | 每条新能力有「不违反三条红线」的验收记录；坏事实场景下多智能体被拦截 |

---

## 10. 风险登记

| # | 风险 | 触发判据 | 影响 | 缓解 / 回退 | 复核人 |
|---|---|---|---|---|---|
| K1 | 删旧面时误删唯一实现 | 某用户动作在插件内无替代路径 | 真丢能力 | M2-04 / M2-08 / M2-10 / M4-01 迁移裁决先于删除；每项有 e2e 证据 | 产品 |
| K2 | 回溯补数污染前瞻统计 | 统计结果混入 `restated` | 统计不可信且不可逆 | M1-06 前置；默认只统计 `pit`；混算守卫进 CI | 量化 |
| K3 | 多智能体在坏事实上放大噪声 | `dataHealth=unavailable` 仍允许开启 | 拿到「更详细但更错」的结论 | `unavailable` 硬拦；`partial` 允许；结构化缺口 | 金融 |
| K4 | 自建采集拿不到 revision 时点 | **已由 T09 spike 关闭**：代理方案成立（公告版本链 + 公告日 + T+1） | 估值段永远缺 | 首个 metric 改为营业收入；成本 11–13 人日；全市场回补需改道采购 | 量化 |
| K5 | 删除后覆盖率下降被误读 | 单 PR 覆盖率跌 >2pp | 团队误判质量 | M2-07 增量基线 + PR 模板记录差因 | 工程 |
| K6 | 区间仓位引入模糊授权 | 计划区间宽度超分层上限或选点规则非枚举 | 「10%–30%」等于没约束 | 分层宽度 + 枚举选点 + 缺项拒绝发布（M3-03） | 金融 |
| K7 | 文档与实现再次漂移 | `check-docs` 红或附录 A 过期 | 后续 agent 被误导 | M4-07 守卫 + 本文纳入过期检查 | 工程 |
| K8 | 用 Bun 跑 Node-only 验收脚本 | 报 `No such built-in module: node:sqlite` | 误判为代码缺陷 | §7.5 运行环境表 + 每条需求标注 | 工程 |
| K9 | 回溯轨被当作「策略历史命中」引用 | 复盘或 Advice 引用 `restated` | 复盘变成前视 | M3-01 历史性硬约束 + 三条拒绝测试 | 量化 |
| **K10** | **能力空窗期** | M2-05 已删 CLI 而 M2-08/M2-10 未完成 | 用户无法记账/导库，约 **0 周**（已通过前移消除） | **v3 已将 M2-08/M2-10 前移到 M2 且作为 M2-05 的硬依赖，空窗被设计消除**；若实施中被迫延后，须在 README 与面板横幅披露并写明临时兜底（只读 SQLite 手工导入说明 + Operation 回执） | 产品 |

---

## 11. 术语表

| 术语 | 含义 |
|---|---|
| `pit`（point-in-time） | 前瞻事实：真实交易日当时产生的观察/信号，可作「当时判断」证据 |
| `restated` | 回溯事实：用今天拉到的历史数据重算出的观察/信号。只可用于统计层（IC / 分位 / 换手），**不可**作「当时判断」证据 |
| `legacy` | 历史兼容事实：已退役 horizon（`t20`）与 legacy 来源的存量记录，默认不进当前统计 |
| `missingFacts` | 结构化事实缺口（kind / subjectId / reason / asOf），可被角色引用与反驳 |
| `targetPctRange` | 目标仓位区间 `{min, max}`，含分层宽度上限与枚举选点规则 |
| **结构化失效条件** | 复用 `TradingPlanConditionSchema`，`kind ∈ {price-range, price-threshold, change-pct-threshold, market-fact, manual-confirmation}`，可被盘中确定性检查 |
| `exposure-report` | `bun run tools:list` 产出的暴露面清单（只读面 / 可写面 / queue-worker 面 / 私人研究 opt-in / 废弃，五类） |
| `dataHealth` | 策略运行数据覆盖质量：`complete` / `partial` / `unavailable` |
| gate（门禁） | 严格回测的前置事实校验八项 |
| Operation 回执 | 写操作的冻结输入 + 幂等结果，可回读 |
| 技能级 e2e | 按 §3.0 的 J1–J6 加载技能并断言「catalog 命中 / 工具可达 / 调用成功 / 产出含 dataAsOf 与缺口标注」，区别于工具级用例 |

---

## 12. 需求 → 用户可见变化映射

| 需求 | 用户会看到什么不同 |
|---|---|
| M1-01 | 盘前 / 盘后 / 个股研究 / 复盘四条对话不再「查不到工具」 |
| M1-03 + M1-08 | 面板多一处「工具与能力」说明 |
| **M1-05** | 「严格回测」入口消失，改叫「历史评估」；未满足门禁时只显示缺什么 |
| M2-08 | 持仓页能记成交、平仓、记现金 |
| **M2-10** | 能从一个 SQLite 文件恢复全部事实，且计数可比对 |
| M3-01 + M3-13 | 策略页出现「历史评估（回溯）」分组带 `restated` 角标；能看到 IC 而不只是选股数 |
| M3-03 | 目标仓位变成区间 + 可被检查的失效条件；显示 min/max 两种合计 |
| **M3-17** | 盘前 08:45 拿到四段固定结构的简报 |
| **M3-18** | 复盘页可直接点「兑现/部分/忽略/不知道」 |
| M3-06 / M3-07 / M3-14 | 持仓页风险卡；复盘页账户归因与单条建议盈亏 |
| M3-08 | 五类报告以文件交付，可打开可归档 |
| M3-09 | 数字旁有数据时间；建议是固定卡片；提醒缺要素就不发 |
| **M3-15 / M3-16** | 设置页能配第二家数据源；研究结论能追到当时那条公告 |
| M4-06 | 设置页三档自动化 + 5 条日程可见 |
| **M4-10** | 看到触发后能就地改条件，不用跳对话重述 |
| **M4-11** | 收盘后自动有一份复盘草稿等你确认 |
| M4-02 | 多角色研究给出分歧点，且事前告知成本与时长 |
| M4-09 | 面板能看到哪些入口已下线 |
| M5-01 | 数据准备不再阻塞对话 |
| M5-03 | 能检索到「上次怎么判断的」；能看到一次研究花了多少 token |

---

## 附录 A：事实快照（asOf 2026-10-30，随代码漂移即失效）

> 正文只引用本附录，不重复维护。REQ-M4-07 的 `check-docs` 对本附录的 `asOf` 做过期检查。

| 项 | 实测值（2026-10-30，T03 与 Lead 复核后） | 取证方式 |
|---|---|---|
| registry 工具数 | 214（read 104 / write 75 / external 29 / queue 5 / trade 1） | `toolRegistry.all()` |
| 工具源文件数 | 194（部分文件含多个 tool 定义） | `ls packages/tools/src/tools/*.ts \| wc -l` |
| read allowlist | 64 | `DEFAULT_READ_TOOL_ALLOWLIST.length` |
| market allowlist | 10 | `DEFAULT_MARKET_TOOL_ALLOWLIST.length` |
| 插件暴露面（可达） | **100**：read allowlist 64 + operation policy 28（26 write + 2 queue）+ market allowlist 独占 8 | T03 实测（`output/exposure-report.md` §1，可复算）；早期稿写「约 101」为取整 |
| 不可达工具 | **114** | 同上 |
| 五类归类 | 只读面 91 / 可写面 89 / queue-worker 11 / 私人研究 22 / 废弃 1 = 214 | T03 + REQ-M1-08 |
| 全仓测试文件 | 346 | `find packages apps -name '*.test.ts' -o -name '*.test.js'` |
| 被删五面测试文件 | 42（web 29 / cli 6 / tui 1 / dsh-bridge 3 / mcp 3）= 12.1% | 同上按目录统计 |
| 遗留五面 LOC | ~50,562（占 18%） | 工程审计实测 |
| 面板数 | 6（`PANEL_NAMES`） | `panels.ts:27-34` |
| 随包技能 | 4 条（迁入后 8 条） | `packages/dsh-luoome/skills/` |
| 工作区技能 | 6 条（删除前） | `.dsh/skills/` |

---

> **本文的边界**：只定义「收敛到什么状态」与「如何验收」，不定义实现方案；实现细节按 `docs/ddd/` 分类另行落地。
> 与 `CONTEXT.md` 冲突时以 `CONTEXT.md` 为准并回写本文。
> 正文不写死任何运行时数字，一律引用附录 A 或工具输出。
