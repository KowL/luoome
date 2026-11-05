# luoome 用户手册

> 给**人**看的使用文档：在 DSH 里安装插件、日常使用与复盘。如果你打算让外部 Agent 使用 luoome，请安装 [dsh-luoome 插件](../packages/dsh-luoome/README.md)；想了解架构看 [ARCHITECTURE.md](./ARCHITECTURE.md)。

luoome 是一个**本地优先**的个人投资 advisor agent。它能：

- 作为 **DSH 插件**接入 DSH：在 DSH Node 进程内提供看盘 / 持仓 / 关注 / 策略 / 告警 / 计划 / 复盘七个业务视图、DSH 内的投资设置、八条随包技能与原生工具
- 在**插件面板**里管理 Strategy、Watchlist、AlertPlan / TradingPlan 与复盘
- 通过**插件工具与 DSH 定时任务**跑 Strategy、同步 Watchlist、盯盘与生成报告

但 luoome **不会**替你下单。所有建议都带 `decision / confidence / horizon / reasoning / risks / disclaimers / validUntil`，人最终拍板。

当前形态是**单机版**：没有多租户、没有订阅计费、没有托管站点，也没有邮箱登录——
DSH 是唯一入口，`$LUOOME_HOME/luoome.db` 是唯一事实库。批处理由 DSH 的定时任务负责，
没有常驻调度进程，也没有常驻队列消费者。

## 目录

- [1. 安装](#1-安装)
- [2. 第一次启动](#2-第一次启动)
- [7. DSH 单机用法](#7-dsh-单机用法)
- [8. 多账户切换](#8-多账户切换)
- [9. 复盘与 confidence 校准](#9-复盘与-confidence-校准)
- [10. 数据存储位置](#10-数据存储位置)
- [11. 环境变量](#11-环境变量)
- [12. FAQ / 故障排查](#12-faq--故障排查)
- [13. 更多阅读](#13-更多阅读)

---

## 1. 安装

### 1.1 系统要求

- **DSH**（宿主）：luoome 以插件形态运行在 DSH profile 内，没有独立站点或命令入口
- **Node ≥ 22.22**：插件运行期使用 Node SQLite，已在 Node 24 验收
- **网络**（仅在启用 `LUOOME_MARKET_PROVIDER=real` 时需要，用于拉 Eastmoney / Tencent / Sina 行情）
- **Bun ≥ 1.3**（仅源码开发、构建与测试需要；运行插件不需要）
- **可选** Python 3.10+（仅诊断/可视化子工具间接依赖）

### 1.2 在 DSH 里安装插件

luoome 不再提供独立 CLI、Web 站点或 MCP 入口，唯一交付形态是 `dsh-luoome` 插件：

1. 在目标 DSH profile 目录安装插件包：

   ```sh
   npm install --save-exact dsh-luoome@0.2.3
   ```

2. 在该 profile 的 `cordis.patch.yml` 中加入插件，保留已有条目：

   ```yaml
   - insert:
       - id: luoome-plugin
         name: dsh-luoome
   ```

3. 启动 DSH 前设置：

   ```sh
   export LUOOME_HOME=/absolute/path/to/luoome-home
   export LUOOME_OWNER_USER_ID=local-owner
   export LUOOME_OWNER_ACCOUNT_ID=existing-account-id
   ```

   `LUOOME_HOME/luoome.db` 必须已有对应投资账户；插件不会创建示例账户。模型密钥使用 DSH 的现有模型配置，不填入插件参数。升级前请对业务库做 SQLite 一致性备份（见 [§7.7](#77-安装升级备份与回退宿主机直部署)）。

4. 启动 DSH 后确认：侧栏出现 LUOOME 入口，主区顶部标签在七个业务视图间切换，DSH「设置 → 投资设置」可配置行情源、通知渠道与账户改名，随包技能可由 DSH 会话直接触发。策略试跑不等于回测，建议不等于交易，插件不提供自动下单。

### 1.3 从源码运行（开发 / 验证）

不想 `git clone` 时，可用一键脚本把源码与工作区依赖装到 `$LUOOME_HOME/src`（脚本只负责源码与依赖，不生成任何命令，Windows 用 `install.ps1`）：

```bash
curl -fsSL https://raw.githubusercontent.com/KowL/luoome/main/install.sh | sh
```

装好后仍按 §1.2 把 `packages/dsh-luoome` 装进 DSH。开发与验证：

```bash
git clone git@github.com:KowL/luoome.git
cd luoome
bun install              # 装工作区依赖
bun run typecheck        # 全包静态检查
bun test                 # Node 兼容的 Vitest 测试
bun run test:all         # Vitest + Bun db/web 测试
```

---

## 2. 第一次启动

luoome 数据存在 `$LUOOME_HOME/luoome.db`（Node SQLite）。插件启动时要求事实库里有 `LUOOME_OWNER_ACCOUNT_ID` 指向的投资账户：

- 已有单机事实库（例如旧的 `~/.luoome/luoome.db`）可直接把 `LUOOME_HOME` 指过去，重启 DSH 后正常使用；
- 空库首次启动进入 recovery-only 模式：只开放数据导入/预检入口（含导入前一致性备份），导入成功后重启插件才进入正常模式。插件不会创建示例账户。

内置策略作为模板目录展示，不会写成 Strategy，也不会灌入账户、持仓、交易或建议；从模板创建的是独立用户策略，可以继续修改或删除。启动后从 DSH 侧栏 LUOOME 入口进入看盘页，账户切换、持仓维护、策略与计划操作都在插件面板或 DSH 会话中完成；本机通知在投资设置里配置。

---

## 7. DSH 单机用法

DSH 是当前唯一入口。luoome 以插件形态接入 DSH，自己不提供站点入口，也不需要账号登录：
公网经 Caddy 转发到 dsh-pocket，输入 Pocket 密码后自动完成 DSH 启动 token 握手，
认证由宿主与入口插件承担。

### 7.1 默认部署：纯插件（DSH Node 进程内）

默认部署只有两个进程：`luoome-dsh`（Node + DSH + `dsh-luoome` 插件，systemd 托管）与公网入口
`luoome-caddy`（同样由 systemd 托管）。运行期**没有** MCP client/server、Bun CLI、旧 Bun Web、
analysis worker 或 queue probe。部署细节见 [7.7](#77-安装升级备份与回退宿主机直部署)。

浏览器和手机直接打开 `http://<服务器公网 IP>/dsh/`，输入运维交付的 Pocket 公网密码即可，
不需要复制 DSH 的临时 token。只有 `/dsh/` 进入 DSH，根路径及其它路径保留给同机其它服务。
窄屏使用抽屉导航，点击 LUOOME
入口后会自动收起抽屉；主区顶部标签在七个业务视图间切换，导航按钮为面板标题留出空间，写操作仍须预览和确认。

公网密码保存在 `$DSH_HOME/dsh-pocket/token`（权限 `0600`），在 DSH「设置 → 手机访问」中
可修改为 8–64 位字母或数字的固定密码。升级须保留 `$DSH_HOME`；DSH 重启后登录状态失效，
重新输入同一密码即可。公网 IP 直连不需要开启 Cloudflare 隧道，也不需要发布 3080/3081 端口。
当前 HTTP 入口没有传输加密。

| 插件面 | 内容 |
|---|---|
| read（精确白名单） | 账户/持仓/交易/绩效、Advice/复盘、Strategy、关注/触发、本地市场事实等只读工具 |
| market external（精确白名单） | 指数、情绪、行情、新闻与有界策略试跑/对照；失败原样返回，不伪造空成功 |
| 个人写操作 | DecisionReview、`record_advice`、`record_analysis_result`、策略 create/version/validate/publish、`record_advice_outcome`、账户改名、登记成交/平仓/减仓/现金流水、关注列表与成员维护；batch 另需显式开启，按明确意图直接执行或通过精确任务授权 |
| client | 侧栏一个 LUOOME 入口，主区顶部标签切换看盘 / 持仓 / 关注 / 策略 / 告警 / 计划 / 复盘七个业务视图；投资设置位于 DSH 设置内，经宿主认证的 `/api/luoome/state` 读取固定 ToolResult |
| skills | `morning-brief`、`stock-deep-dive`、`strategy-lab`、`strategy-result-review`、`post-close-review`、`decision-journal`、`daily-market-analysis`、`luoome-batch` |

事实库是 `LUOOME_HOME/luoome.db`（Node SQLite），由插件在 DSH 进程内直接打开。通用
`/api/luoome/call` 仍只读；`trade` 永不注册，`LUOOME_EXPOSE_TRADE=true` 启动即失败；自动任务默认关闭。

旧「当前 MCP 过渡形态」的四个实例（`luoome` / `luoome-settings` / `luoome-analysis` /
`luoome-batch`）与手动 worker 已随 REQ-M2-03 删除源码，不再有手动 MCP 验收入口。

### 7.2 面板

DSH 侧栏通过 LUOOME 入口进入，主区顶部标签切换七个业务视图；投资设置从 DSH「设置」进入：

| 面板 | 内容 |
|---|---|
| 看盘 | 核心指数、账户总资产/账面现金/持仓市值、自选与持仓行情表、市场温度及连板分布、行业涨幅榜、今日触发、要闻、关注列表与研究摘要 |
| 持仓 | 当前账户持仓、最近成交和绩效快照；「记账与账户维护」提供登记成交、现金流水与平仓/减仓，写入走 Operation 冻结输入与业务回执 |
| 关注 | 独立管理关注列表与成员，展示股票名称、代码、研究阶段、优先级与关注来源；支持手动管理和交给 AI 管理 |
| 策略 | 四步骤实验工作台：问题与规则、试跑与诊断、分层验证、结论与更新；保存后恢复固定版本、范围、基准和未完成研究。保留正式策略定义、匹配结果与原始规则依据。点击股票可查看报价，个股详情自动读取日 K 与筹码档案，再进入带策略来源的新分析对话。 |
| 告警 | Watchlist 级告警规则集：规则增删改、冷却与日上限、最近触发次数与配置提示；试跑不自动交易 |
| 计划 | 逐股结构化交易计划：版本链、目标仓位与止损/止盈等四要素提示、失效条件、反证与风险；计划不会自动下单 |
| 复盘 | 建议命中率、真实 confidence calibration 分桶、DecisionReview 最近记录与来源、逐条 Advice 用户反馈（未回填不推断）、待补齐观察与样本数/未知/时间范围 |
| DSH 设置 → 投资设置 | FUYAO 服务地址与 API Key、行情源优先级、通知渠道、当前账户、数据健康与插件能力；账户改名直接保存并可查询操作回执 |

面板只做投影，不自己算数：数字必须与工具输出逐位一致。看盘页点击「刷新全部」或各区「刷新」，其他面板点击「刷新事实」读取当前工具结果，
工具失败显示错误，不以零值代替缺失数据。

个股详情打开后即自动并行读取行情、日 K 与筹码档案，不再需要点按钮才拉取；某块失败时显示错误，详情头部「刷新」统一重试。详情只保留股票名一个大标题，不再出现「个股详情」「行情快照」「筹码与板块」这类重复卡片标题；日 K 与行情同卡展示，包含前复权日线、价格刻度、成交量、区间最高/最低、首末收盘、工具给出的最新均线，以及来源、日线截止日和覆盖警告；缺失交易日不生成 K 线，也不从单次报价合成走势，区间数字只投影工具给出的收盘价，不重算收益率。筹码与板块内容展示最近一期统计截止日、股东户数、较上期变动、户均持股与户均市值，以及上游所属板块及入选理由；统计截止日与读取时间分开显示，合法空结果标注未披露，接口异常显示错误。两块分别使用 `get_stock_market_view` 与 `get_stock_profile` external 工具与 market 白名单，不经过通用 read 面；未启用时显示权限错误。筹码档案取自东方财富；雪球报价与日 K 由独立行情源配置控制，未接入雪球讨论。点击详情顶部的股票代码会在新窗口打开雪球个股详情页。

在「关注」页可新建、编辑、启停或归档列表，添加股票、调整研究阶段和优先级、移除手动关注。
每次修改在面板提交后按冻结输入直接执行并返回 Operation 回执；移除手动关注只结束 manual 来源，
有策略、持仓或其他来源时仍保留该股票。同步列表的成员由来源维护，不能手工添加。
「交给 AI 管理」会把当前列表带入可编辑的对话草稿，发送后由 AI 读取现状并提出方案，
写入按明确意图直接执行，不自动启用定时任务。

公网部署在 `/dsh/` 等子路径时，面板和确认操作的请求都跟随 DSH 的 document base。
0.2.1 修复了此前漏掉前缀、收到空响应而显示“读取失败”的问题。核心指数独立读取指数接口，
情绪维度超时不隐藏已取得的指数；行情时点保留供应商日期。情绪首次聚合可能需要十余秒，期间显示读取状态。

### 7.3 技能

默认部署安装 `dsh-luoome` 随包的八条技能（`packages/dsh-luoome/skills/`）：

| 技能 | 触发 | 行为 |
|---|---|---|
| `morning-brief` | 交易日 08:45 定时任务，或用户要求「盘前简报」 | 读隔夜事实、既有建议与观察条件，生成并落盘本日简报后交付 |
| `stock-deep-dive` | 用户点名个股要求深度分析 | 基于事实包与研究库输出可证伪的研究报告，必要时落为建议 |
| `strategy-lab` | 对话制定/修改策略 | 恢复研究问题和固定版本 → catalog 草案 → 独立校验 → 字段预检 → 同快照试跑/有界比较 → 历史验证与结论；个人版按明确意图直接执行，发布不被创建或校验自动触发 |
| `strategy-result-review` | 研究某次策略运行结果 | 按版本解释入选/临界/未入选/缺失，核对验证进度、真实 T+1/T+3/T+5 和持续观察回执；保留反证与限制，结论绑定可审计证据，改版走 strategy-lab |
| `post-close-review` | 收盘后复盘 | Advice 快照、DecisionReview、显式 Trade、观察、绩效与 calibration 分写；不推断用户跟随、不代填 outcome；复盘笔记按明确意图直接保存 |
| `decision-journal` | 用户记录投资决策 | 落 DecisionReview，保留当时依据、假设与失效条件 |
| `daily-market-analysis` | 每日市场分析 | 经精确 market external 白名单刷新指数/情绪/要闻/行情，保留 source/dataAsOf/partial/unavailable；形成 Advice 时另取有效 context 并按明确意图直接写回 |
| `luoome-batch` | 建立、检查或补跑 DSH 定时任务 | 五个每日/每周批处理入口的调度表、门槛口径与调用方式；非交易日/非盘中时段自动返回 skipped，不写库 |

技能本身不授予权限：能调哪些工具仍由插件的 read/market/policy 面决定。个人版写操作不再要求人工审批，但只在用户明确提出保存、发布、调度等意图时执行，并保留 Operation 回执。
操作入口按每项操作的领域 Zod schema 提供参数契约。账户和 requestId 由宿主绑定，业务参数应省略 requestId；冲突时错误会明确指向字段，不应删改笔记或盈亏试探。invalid_input 会返回字段路径与类型要求，
表示参数未通过校验，不代表缺少权限；纠正参数后直接重新执行，不用写调用探测工具或权限。
当前固定 SDK 下，MiniMax M3/M3.1 Flash 的原生调用**不会稳定写出 JSON null**——它在填对象参数时
用"省略该属性"表达"无值"。luoome 的写契约已按此调整：可空业务字段（如复盘的 `triggerFeedback`、
`adviceFeedback`、`note`）在参数契约上是可选的。**更新时省略保留原值，显式 null 才清除**；
tradeIds 省略保留关联，显式空数组解除关联。新建时省略字段初始为空数组/null。冻结参数展示的是
按 expectedRevision 补齐后的完整内容；字符串 `"null"` 这类占位值仍被拒。因此复盘保存与反馈写回在默认 native 配置下已实测通过，
不再需要 `DSH_TOOLS_MODE=ptc`。PTC 仍是官方备选通道，需要时在启动 DSH 进程时显式设置即可，
默认配置不会自动切换。完整边界见[部分更新与真实模型验收记录](./ddd/dsh-luoome-plugin-detailed-design.md#917-decisionreview-部分更新回归修复2026-10-25)。
旧 `.dsh/skills/`（`morning-brief`、`stock-deep-dive`、`decision-journal`、`luoome-batch`、
`analysis-worker`）属于旧 MCP 过渡形态，已随 REQ-M1-01/M2-03 删除；技能唯一根是插件包。

看盘页在交易时段每 60 秒自动刷新一次，非交易时段停止轮询、等下一次开盘再恢复；标签页隐藏时不发请求，回到前台立即刷新一次；刷新失败保留最后一次成功画面并提示，也可点「刷新全部」或各分区的「刷新 / 重试」。指数、市场温度、账户、持仓、自选、行业、要闻等分区独立请求并立即展示各自结果，慢接口不会阻塞其他区；刷新失败保留同一页上次成功数据，显示简短错误与重试入口。卡片和行情表不展示数据来源、读取时间或说明性提示，数值缺失保持空缺。自选汇总已启用关注列表中当前账户可见的成员，每页 40 只，涨跌幅和成交额排序仅作用于当前页；切页时不会展示上一页行情。今日触发按北京时间自然日筛选，显示优先级最高的 8 条。点击股票打开详情，日 K 走势与筹码档案自动加载，对话分析由用户主动点击。持仓页回读当前账户持仓、最近成交和绩效快照；DSH「设置 → 投资设置」可预览、取消和确认账户改名，名称以外的账本字段不变。刷新后可按操作 UUID 核对结果，浏览器不保存确认 token。新增/切换账户、其他供应商凭据配置和数据导入恢复仍使用现有受控管理入口。

在投资设置中填写 FUYAO 服务地址（默认 `https://fuyao.aicubes.cn`）和 API Key，再将 FUYAO 选为首选或备用行情源，点击「保存行情设置」。最多启用三个不同来源，按优先级依次尝试；保存后当前 DSH 进程立即应用，无需重启。API Key 不回显，留空保留已有密钥；配置以 `0600` 权限保存到 `$LUOOME_HOME/.env`，重启后继续生效。模型仍在 DSH 的模型设置中配置。

#### 策略研究的证据层次

在「问题与规则」填写一个小假设，选择基线和候选、股票范围、日期及基准。结构化编辑器使用真实字段目录；规则修改先保存为新候选，再独立校验。点击「检查数据资格」查看逐字段、逐股与 PIT 覆盖；范围变化后旧预检不再适用于当前设置。

「试跑与诊断」可选当前事实或指定历史交易日，对照两份已校验版本；查看规则输入、门槛和评分贡献，数据缺失单列。少量候选可做共享快照的敏感性比较，全部失败和限制都保留。「分层验证」准备历史任务后还要确认；操作受理与任务执行结束分开，查询、取消、续跑都沿用原 session。重启后 idle 的 running 任务需要再次明确确认恢复。

「结论与更新」保存结论、反证、限制、引用与下一步，并回看既有结论及比较记录。保存研究空间后可刷新或跨日继续；页面内未保存编辑不会持久化。并发修订会要求读取最新记录再合并，正式版本更新也不会自动替换原研究基线。下载文件保留完整 manifest envelope，包括 portable 定义、hash、研究状态、证据引用与数据可复现边界。

策略研究围绕一个明确问题修改规则，再用可核对的事实验证。开始前确定基线、候选版本、股票范围、日期和基准；版本冻结后由确定性规则引擎求值。自然语言讨论可以提出假设，但不会替代数据资格或写入审批。

| 证据 | 回答的问题 | 使用边界 |
|---|---|---|
| 同快照试跑 | 同一批实际输入上，规则修改改变了哪些入选结果和评分？ | 有限样本、非持久化运行；缺失数据保留为未知，不能推断全市场或收益 |
| 历史评估 | 每个历史交易日哪些股票满足规则？ | 需要本地历史与 PIT 事实；任务进度、失败日和缺失日分别保留 |
| 组合回测 | 按固定执行模型，组合在历史上如何变化？ | 必须通过可交易性、公司行动、基准等数据门禁；不能用当前行情补历史 |
| T+1/T+3/T+5 真实观察 | 已有信号随后实际出现了什么？ | 是逐股事后观察，不是组合回测；小样本和未到期观察不能证明策略有效 |

组合回测当前执行模型是 `next-open-full-rebalance-equal-weight-v1`。真实历史数据不具备所需字段时，页面应列出日期、字段或来源缺口；有日线不等于具备组合回测资格。同日不同版本、同策略跨日和不同策略比较的范围不同，只有后端提供的同口径事实才能比较。

持续观察还要核对 DSH 任务、有效授权和实际运行回执。仅开启策略日程不能证明后台正在运行，通知受理也不等于送达。研究结论应保存反证、限制和下一步；导出的 manifest 携带定义与证据引用，不携带完整供应商历史数据，也不会自动发布或交易。

### 7.4 DSH 定时任务与批处理

默认关闭批处理与自动执行。插件已具备五个原生入口，无需旧 MCP 实例：

- 部署设置 `LUOOME_BATCH_ENABLED=true` 后，可经 `luoome_confirmed_operation` 按明确意图直接补跑；`luoome_automation_catalog` 只读返回现有任务、任务指纹和账户绑定调用模板。
- `LUOOME_AUTOMATIONS_ENABLED=true` 还要求 batch 开关已开启。它允许核验持久授权，定时执行仍须精确任务授权。
- 每个入口完整要求 `write + external`。账户快照、计划与报告只作用于绑定账户；策略日循环与自治处理本地全局策略，自治可能按既有门禁暂停、归档或发布版本，执行前应展示这些影响。

下表是**新建任务的示例**，旧日程的 ID、时间与会话不能默默改写；旧时间不满足门槛时会跳过，应先展示变更再按明确意图执行。

| 批处理 | 原生操作名 | 示例 cron（Asia/Shanghai） | 门槛 |
|---|---|---|---|
| 策略日循环 | `run_strategy_daily_cycle` | `30 18 * * 1-5` | 交易日，收盘后当日日线已落库；内部策略调度仍独立认领 |
| 收盘报告截止 | `run_closing_report_cutoff` | `30 19 * * 1-5` | 交易日；18:00 截止且当日策略日循环结束后才记录缺口 |
| 账户绩效快照 | `run_portfolio_performance_snapshot` | `30 16 * * 1-5` | 交易日且已过 16:00 |
| 盘中计划批处理 | `run_intraday_plan_batch` | `35 9 * * 1-5` | 实际盘中时段，09:05 会跳过 |
| 策略自治周报 | `run_strategy_autonomy_weekly` | `30 9 * * 0` | 周日 |

迁移顺序：先保持自动执行关闭，只开 batch；在 DSH「自动化任务」核对原任务，在同一 ID 和原时间上改用原生调用提示。再读 `luoome_automation_catalog`，逐项选择对应调用模板，冻结宿主给出的 identity、scheduleHash、accountId、inputJson/inputHash、组合能力与有效期，使用 `configure_plugin_automation` 直接创建授权。最后才开启自动执行。目录按建议的 grant ID 查询既有授权；自定义 grant ID 要结合原操作回执核对。

提醒真正投递后，模型调用 `luoome_scheduled_operation`，提交 grantId、grantVersion、tool、accountId 和模板中的完整 input。任务身份与 occurrence 由宿主投递历史核验，prompt 或模型自报 taskId 无效；修改任务定义后，旧指纹不再匹配，必须重新核对授权。重复投递不会重复执行同一 occurrence。

手动 `force: true` 只在用户明确提出补跑意图时使用；定时授权拒绝 force。`partial` 表示部分失败，不能报告全部完成。操作状态 `unknown` 时只查询/核对业务回执，不自动补跑，也不能通过更换 operation ID 假定前次没有写入。

### 7.5 批量分析与队列

批量任务状态为 `pending → claimed → completed`，失败按退避重试，达到上限进入 `dead_letter`。

- `get_analysis_metrics` 查看积压、可执行任务与过期租约；`list_analysis_jobs`、`get_analysis_job` 查看任务状态。
- 交互式分析不建 job：插件 read 面取持久化 context 后，向你展示结论、反证、风险、有效期与
  将写回内容；只有你明确提出保存意图时，才直接调用 `record_advice` / `record_analysis_result` 写回。
- 单机形态没有生产者进程，默认部署也没有常驻消费者，空队列是正常状态。
- 过期租约可以重新领取，旧 token 不能写回。
- `queue` 是独立能力；默认部署只由两条 analysis record policy 使用，claim/complete/fail 与
  job 查询不在插件暴露面（旧 MCP profile 的完整队列消费白名单已随入口删除）。

建议展示保留反证、风险、免责声明和有效期；`legacy-ai` 表示迁移前的建议，
不能据此推断当时模型或技能版本。校准页面按生成方式、模型和技能版本分别统计，
每组以及每个信心桶至少需要 20 条明确跟随且填报盈亏的样本才展示比例。

### 7.7 安装、升级、备份与回退（宿主机直部署）

生产部署不再用容器：DSH 与 Caddy 直接跑在宿主机上，由 systemd 托管。改部署文件不再需要重建镜像。
容器栈保留在仓库里作为整栈回退方案（见文末「容器回退方案」）。

前置：目标机器有 systemd；Node ≥22.22（缺省由安装脚本从 nodejs.org 取官方二进制并校验 SHA256）、
Caddy（可从既有镜像里取二进制）。运行期不需要 Bun，也不需要 Docker。
从 `deploy/dsh/production.env.example` 复制私有 env 文件并填写（不要提交）。

插件 tarball 的运行依赖只包含固定版本的 DSH SDK；`@luoome/*` 与 Zod 是构建依赖，已编入 host bundle。
目标机器可以用 `npm install --omit=dev <插件 tarball 路径>` 正常安装，无需解析 workspace 或链接仓库模块。
`bun --no-env-file run test:plugin-install` 会在临时 profile 中实际执行 npm 安装并启动独立 DSH CLI，
还会用活 Agent 执行原生工具，验证 HTTP 之外的插件作用域与权限检查；此验收不调用模型。

**首次部署**

1. 把插件产物放到 `/opt/luoome/dsh/releases/dsh-luoome.tgz`。
2. 跑 `sudo deploy/direct/install.sh`：它装 Node 与全局 DSH/Pocket、应用 pocket 补丁、装配 profile、
   写 `host.env` 与 `caddy.env`、安装 systemd 单元。安装器不启停服务，也不碰既有数据。
3. 准备数据面：`/opt/luoome/dsh/{home,luoome-home,workspace}` 分别是 `DSH_HOME`、`LUOOME_HOME`、
   `DSH_WORKSPACE`，属主是系统账号 `luoome`、权限 700。`LUOOME_OWNER_USER_ID` /
   `LUOOME_OWNER_ACCOUNT_ID` 必须对应事实库里既有账户；插件装配失败会拒绝启动，不会回退默认账户。
   容器期的工作区根是 `/workspace`，工作区记录与历史会话的 `cwd` 都写着这个路径，所以安装器会建
   `/workspace` → `/opt/luoome/dsh/workspace` 的软链接把旧路径接回去（`WORKSPACE_COMPAT_PATH` 可改）。
   少了它，历史会话执行时会报 `working-directory: directory does not exist: "/workspace"`。
   注意 DSH 把会话挂到工作区的判定是 `realpath(会话 cwd)` 与工作区记录里的 `path` **字面相等**：
   历史会话靠软链接解析到真实目录，工作区记录里的 `path` 则必须直接写真实目录
   （`/opt/luoome/dsh/workspace`）。两者对不上时新建会话会报
   `session/workspace-attach-failed: ... its cwd resolves to '...'`；安装器会检查并告警。
4. `sudo systemctl enable --now luoome-dsh luoome-caddy`，然后用 Pocket 密码登录，确认
   `/dsh/api/luoome/profile` 可读取、七个业务视图与八条技能都在（只有密码页返回 200 不能证明 DSH 上游可用）。

**隔离与端口**

容器原本提供的隔离改由 systemd 加固项承担：DSH 以 `luoome`（无登录 shell、无 sudo）运行，
`NoNewPrivileges`、`CapabilityBoundingSet=`（无任何 capability）、`ProtectSystem=strict`、
`ProtectHome=read-only`、`PrivateTmp`、`PrivateDevices`、`ProtectProc=invisible`、`RestrictSUIDSGID`、
`LockPersonality`、`RestrictAddressFamilies`、`SystemCallFilter=@system-service`；`ReadWritePaths`
只放开自己的数据面与 HOME。改完单元用 `systemctl show -p CapEff,CapBnd,NoNewPrivs,Seccomp --value`
复核实际生效值。

DSH 只绑 `127.0.0.1:3080`，Pocket 绑 `127.0.0.1:3081`，两者都不对外；Caddy 是唯一公网入口，
只保留 `CAP_NET_BIND_SERVICE`。dsh-pocket 插件模式默认把代理绑在 `0.0.0.0`（`lib/service.mjs`），
部署补丁把它改成读 `DSH_POCKET_BIND_HOST`、默认 `127.0.0.1`；容器侧必须显式声明 `0.0.0.0` 才保持原语义。
少了这一步，宿主机上的 3081 会直接暴露到公网。

DSH 的应用内目录选择器默认浏览 HOME 并在当前目录下新建目录（创建工作区），所以 HOME
（`/home/luoome`）必须**能列出**也要能写。目录不可写时用户会看到
`cannot create /home/node/<名称>: EROFS: read-only file system` 之类的报错；不要靠放开系统目录写权限来绕过。
HOME 列不出来则是另一种报错：`cannot list /home/luoome: EACCES: permission denied`——
`ProtectHome=true` 会把整棵 `/home` 遮成不可访问，`ReadWritePaths` 覆盖不了它，
所以单元用 `ProtectHome=read-only` 再用 `ReadWritePaths` 单独放开 `/home/luoome`。
其它用户的家目录仍由文件属主权限挡住（`read-only` 只解除挂载点的只读，不改属主权限）。

**升级**

换插件不再构建镜像：备份 profile 与事实库 → 重新装配 profile → 重启服务 → 探针验收 → 失败自动回滚。

```bash
# 服务器上执行；插件产物先用 scp 传到 /opt/luoome/dsh/releases/。
sudo /opt/luoome/dsh/deploy/upgrade.sh /opt/luoome/dsh/releases/dsh-luoome.tgz
```

验收用 `deploy/dsh/dsh-web-probe.mjs`：先 `--health` 探双端口，再带 Pocket 密码跑完整矩阵
（业务 profile 200 / 未认证 API 401 / 外站 Origin 403 / WebSocket 101）。任何一项不过，
脚本把 profile 与事实库装回备份并重启，然后以非零码退出。

**容器回退方案**

`deploy/dsh/compose.yaml` 与 `deploy/dsh/upgrade.py` 仍在仓库里，用于整栈回退：compose 用 release
镜像起 `dsh-web` 与 `caddy`，数据在 `luoome-dsh_*` 卷上。回退时先停宿主机服务
（`systemctl stop luoome-caddy luoome-dsh`），再 `docker start luoome-dsh-caddy-1
luoome-dsh-dsh-web-1`（镜像与卷都保留）。需要重新走一遍 release 流程时用仓库内的脚本：
构建阶段用 Bun 打包插件、运行阶段只用 Node，发布包只包含应用 tarball、明确列出的部署文件和
SHA-256 清单。

**一致性备份**（不要只复制活跃的 `luoome.db` 主文件；WAL 里可能还有未合并数据）：

```bash
# 用 SQLite backup API 生成在线一致性快照（Node 22+；临时脚本，不提交）
node --input-type=module -e "
import { DatabaseSync, backup } from 'node:sqlite';
const db = new DatabaseSync('<挂载路径>/luoome.db');
await backup(db, '<备份目录>/luoome-$(date +%Y%m%dT%H%M%S).db');
db.close();
"
# 校验快照可独立打开
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('<快照路径>');console.log(d.prepare('pragma integrity_check').get());d.close()"
```

备份产物一律 gzip 存放（`luoome.db.gz`）：事实库是 GB 量级，压缩后约为原体积的四分之一。
还原前先 `gunzip`，并删掉目标库里残留的 `luoome.db-wal` / `luoome.db-shm`——旧 WAL 会盖掉刚恢复的库。
`deploy/direct/upgrade.sh` 就是这么做的：备份用 SQLite backup API 取一致性快照再 gzip，
回滚时自动清 WAL 后装回。

**回退演练/步骤**（先停新写入，不覆盖备份后新增事实）：

1. 停纯插件 Web，确认旧 origin 不可达、没有在途写入。
2. 恢复切换前的镜像/profile 与事实库一致性副本（不要用活跃 WAL 主文件当备份）。
3. 备份后新增的事实（Advice/DecisionReview/策略等）必须从切换后快照按业务键合并回恢复库，
   不能简单覆盖，也不能靠代码回退撤销已产生的业务事实。
4. `infra/dsh/plugin-switch-acceptance.ts` 在隔离环境演练了完整切换、一致性备份、回退合并与
   Node SQLite 重开持久化；它不代表真实生产已完成切换。

---

## 8. 多账户切换

账户不再内置，插件也不会创建示例账户：事实库必须已有账户，并通过 `LUOOME_OWNER_ACCOUNT_ID` 绑定当前操作者；新增账户仍走现有受控管理入口。所有账户均为 `kind: real`。

切账户后：

- **插件面板**：在 DSH「设置 → 投资设置」切换当前账户后，看盘 / 持仓 / 关注 / 策略 / 告警 / 计划 / 复盘按新账户重读。`list_holdings` 等读路径走 `ctx.user.defaultAccountId`。
- **DSH 会话工具**：账户相关 tool 可通过 `accountId` 显式选账户，缺省使用当前上下文账户；插件暴露面不暴露 `add_trade` 或 `record_decision_trade`。

### 8.1 给新账户加仓（演示）

1. 在 DSH「设置 → 投资设置」确认当前账户；
2. 进入「持仓」面板，在「记账与账户维护」里点「登记成交」，填入股票、买入方向、数量、价格与成交时间；
3. 保存后返回 Operation 回执，可回读「最近登记的成交」与持仓。

登记成交是人工记账，不等于下单；平仓与减仓分别走 `close_holding` 与卖出成交。

---

## 9. 复盘与 confidence 校准

复盘将当时依据、用户明确记录的行动和后来观察放在当前账户下回看。切换账户后，反馈和统计随账户切换。
建议采纳、实际成交和事后涨跌各自记录；系统不会从其中一项推断另外两项。

### 9.1 记录与修改复盘

先确认当前账户，再从建议、交易计划版本或提醒详情打开「决策与复盘」。弹窗展示当时依据、
反证、风险、有效期与明确关联的事后观察；没有显式观察链时会说明缺失，不按同股拼接。

- **填写反馈或备注**：Advice 可记录跟随、部分跟随或忽略；提醒可记录已处理、有用、无用或忽略。
  盈亏未知时留空，0 仅用于明确核对过的零盈亏。保存走插件的精确写 policy 与 Operation 回执。
- **关联已有成交**：在当前账户和股票下选择已有交易记录，列表可继续加载；保存关联不会再次入账，
  也不会自动把建议标为已采纳。
- **登记尚未入账的实际成交**：仅用于已在系统外完成的成交。核对方向、数量、价格、费用和北京时间，
  明确确认尚未登记后提交；成交、持仓、现金与所选依据关联一起保存。账本未对齐、余额或可卖数量不足、
  成交时间不符合顺序追加窗口时会拒绝，不会部分保存。

首次保存会冻结来源依据，每次修改追加新修订。可以查看旧修订；编辑需回到最新版本。
来源删除后仍能查看冻结快照，来源过期和成交事实变化会保留提示。遇到修订冲突时先刷新、核对最新内容。

若提交后网络中断或结果未确认，当前标签页会保留未决请求。回到原账户后先点「查询上次未决提交」，
需要重试时使用「复用原请求重试」；确认结果前不能创建新的提交。切换账户不会把原请求改投新账户。
未决请求保存在当前标签页的会话存储中，关闭标签页前应先核对交易流水与提交结果。
若服务端明确拒绝提交，点击「确认未提交并重新加载」核对同键回执；确认没有成功提交后会重新读取
最新上下文，允许修改内容后新建请求。网络结果未知时仍保留原请求，不能用此方式跳过核对。

明确反馈只能经 DSH 插件的 `record_advice_outcome` 或 `save_decision_review` 精确 policy 记录。
这些反馈入口不会登记成交，成交类 tool 不在任何暴露面出现。

旧版本没有账户归属的反馈仍留在历史数据中，不会自动分摊到当前账户。迁移只恢复可验证的旧成交与
Advice 显式关联，不据此生成采纳反馈；需要时由用户重新核对并记录。

### 9.2 看 confidence 校准

`get_confidence_calibration` 将当前账户的历史 Advice（包含已过期建议）按 confidence 分桶。
通用股票建议在本账户明确记录后才纳入账户样本。调用时可显式指定账户：

```json
{ "tool": "get_confidence_calibration", "input": { "accountId": "你的账户 ID" } }
```

每桶的 `total` 是建议数，`withOutcome` 是明确反馈数，`followedWithPnl` 是明确跟随且已填盈亏的样本数。
`hits` 只计算最后这组样本中盈利的条数；`hitRate = hits / followedWithPnl`，面板显示为「填报盈利占比」。
没有合格样本时显示未知，不用 0 代替。主观填报盈亏不做跨建议加总，`avgPnl` 等聚合盈亏字段保持未知。

这张表用于检查已填报样本与信心度之间的关系。样本量、未反馈记录和用户选择都会影响结果，
它不等于账户收益率，也不能把某个 confidence 桶理解为未来成功概率。
「复盘」面板与 `get_confidence_calibration` 工具都可查看。

### 9.3 报告中的复盘与后补

账户收盘报告和周报会保存生成时使用的复盘修订与成交事实。收盘复盘生成后保持原始快照，
后补记录可在「决策与复盘」中查看，不再追加补充报告。报告列表每个日期和范围只显示最新的一份，
历史收盘报告的 V2/V3 编号不再显示，已有历史数据仍保留。

周报后来补录或修改后，可在最新报告详情中点「生成复盘补充版」，只根据已保存的本地事实
更新复盘章节，保留旧版本和其它报告内容。
旧报告尚未包含新版复盘时会明确提示。补充请求结果未确认时，用同一按钮重试，不会重复创建同一请求的版本。

复盘补充版显示「按策略不通知」，不会额外发送通知，后续定时任务与投递重试也不能改变这一策略。
正常主报告及原研究补充版仍遵循原有通知规则。生成复盘补充需要 write 能力，不要求开启外部调用。

`daily-review` workflow 仍可单独运行（经 DSH 定时任务或插件工具），报告写到 `$LUOOME_HOME/reports/`。
执行步骤见 [workflows 包](../packages/workflows/src/daily-review.ts)。

---

## 10. 数据存储位置

| 路径 | 内容 |
|---|---|
| `$LUOOME_HOME/luoome.db` | Node SQLite 主库（账户 / 持仓 / 行情 / Strategy / Watchlist / AlertPlan / Advice / 交易计划） |
| `$LUOOME_HOME/reports/` | 报告与复盘落盘产物 |
| `$LUOOME_HOME/logs/audit.log` | 操作审计日志（按 `LUOOME_AUDIT_MAX_MB` / `LUOOME_AUDIT_KEEP` 轮转） |
| `$LUOOME_HOME/imports/` | 数据导入暂存与导入前一致性备份 |
| `$LUOOME_HOME/exports/` | 业务数据导出产物 |
| `$LUOOME_HOME/backups/` | 研究库等备份 |

覆盖路径：设置 `LUOOME_HOME=/path` 即可让 luoome 用别的根目录。

---

## 11. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUOOME_HOME` | `~/.luoome` | 数据根目录 |
| `LUOOME_OWNER_USER_ID` | 必填 | 插件操作者 id，由宿主绑定到所有会话与 Operation |
| `LUOOME_OWNER_ACCOUNT_ID` | 必填 | 绑定的投资账户 id，必须在事实库中已存在 |
| `LUOOME_MARKET_PROVIDER` | 必填 | 仅支持 `real`（Eastmoney → Tencent → Sina，仅 A 股） |
| `LUOOME_MARKET_SOURCES` | `eastmoney,tencent,sina` | 行情源顺序（最多三个）；可加入 `xueqiu`（访客会话）、`tushare`（需 `TUSHARE_TOKEN`）或 `fuyao`（需 `FUYAO_API_KEY`） |
| `LUOOME_STOCK_UNIVERSE_SOURCES` | `eastmoney,sina` | 股票目录源顺序；支持 `eastmoney,sina,tushare` |
| `LUOOME_RESEARCH_VAULT` | — | Obsidian Vault 绝对路径；写入 `$LUOOME_HOME/.env` 后重启 DSH 生效 |
| `LUOOME_RESEARCH_ROOT` | `Research` | Vault 内参与扫描的相对目录；设为 `.` 可扫描整个 Vault |
| `LUOOME_RESEARCH_MANAGED_ROOT` | `Research/Luoome` | luoome 受管文件目录，必须是 research root 的子目录 |
| `LUOOME_RESEARCH_EMBEDDING_ENABLED` | `false` | 显式挂载 Research embedding 外部 capability；默认仍为本地 FTS5 |
| `LUOOME_RESEARCH_EMBEDDING_CONFIG` | `$LUOOME_HOME/research-embeddings.json` | embedding 模型目录路径；密钥由目录里的 `apiKeyEnv` 从环境读取 |
| `LUOOME_RESEARCH_REMOTE_SYNC` | `false` | `git` 启用独立安全拉取 workflow；不配置则完全不装配 |
| `LUOOME_FEISHU_WEBHOOK_URL` | — | 飞书通知 webhook；可在 DSH「设置 → 投资设置」的通知渠道配置，缺失降级为 log channel |
| `LUOOME_BATCH_ENABLED` | `false` | 开启五个批处理原生入口；默认关闭 |
| `LUOOME_AUTOMATIONS_ENABLED` | `false` | 允许核验持久授权；还要求 batch 已开启，定时执行仍须精确任务授权 |
| `LUOOME_EXPOSE_TRADE` | `false`（**硬卡**） | `=true` 时启动即抛错退出；trade 类工具永不可达 |

read 面固定只读；market external 与个人写操作按插件白名单生效；trade 永不暴露，`LUOOME_EXPOSE_TRADE=true` 启动即失败。

---

## 12. FAQ / 故障排查

### 12.1 `bun: command not found`

Bun 只用于源码开发、构建与测试；插件运行只需要 Node。按官网安装 Bun 或用 `npx bun`。

### 12.2 面板打开是空白

旧单机 Web（`apps/web`）已随 M3-01 下线，`apps/web/public/js/*` 不再存在——**这类报错不会来自本仓库**。
当前形态是 DSH 插件：面板空白先看
①DSH 是否加载了 `dsh-luoome`（`bun run build:dsh-luoome` 后由 `profile-seed.mjs` 装配）；
②`test:panels-browser` 的失败末行（它是唯一 DOM 级门，会给出缺失元素与现场 DOM）；
③插件 client 的 `window.__luoomeErrors` 与页面里的 `[data-slot-error]` 标记——
**client 崩溃会被 `SlotErrorBoundary` 接走并「让位」，表现为「组件没渲染」而不是「组件报错」**。

### 12.3 Eastmoney / Tencent 失败 → 自动切 Sina 还是空？

`LUOOME_MARKET_PROVIDER=real` 按 `LUOOME_MARKET_SOURCES` 从左到右尝试已注册能力；默认顺序是
Eastmoney、Tencent、Sina。所有源都失败时明确返回行情源错误，不生成价格。Sina 当前只提供
沪深目录和 qfq 日线，不会伪装成实时快照或搜索来源；未覆盖的市场返回 not_supported。

雪球可在 DSH「设置 → 投资设置」的行情源列表启用并调整优先级，或配置 `LUOOME_MARKET_SOURCES=xueqiu,eastmoney,tencent`。它仅覆盖沪深个股报价与前复权日 K，个股详情沿用同一工具链读取，并显示实际数据来源；其他能力由已启用且支持该能力的源提供。访客会话自动建立和续期，不需要填写雪球账号 cookie；cookie 只存在进程内存。会话或接口异常时按现有优先级降级，不把不复权 K 线当作前复权数据。

### 12.4 luoome 侧找不到模型或 provider 密钥

模型推理与模型配置都由 DSH 承担，luoome 侧没有模型运行时、模型目录与模型设置页。
需要模型判断的任务由 DSH agent 通过插件注册的工具完成，密钥由 DSH 侧配置。

看盘、持仓、策略、提醒、计划与数据导入导出都不依赖模型，可直接使用。

### 12.5 `get_confidence_calibration` 没有盈利占比

先确认当前账户。只有该账户明确标记 followed 且填写盈亏的记录参与填报盈利占比；
没有这类样本时返回 null、面板显示未知。按实际情况补充反馈，尚未确认的盈亏保持留空。

### 12.6 切账户后持仓没变？

在 DSH「设置 → 投资设置」确认当前账户，重启或刷新面板后按新账户重读。如果仍然没变，说明该账户本来就没持仓——可用「持仓」面板的「登记成交」记一笔。

### 12.7 Advice 看不到 / 全部过期

`validUntil` 已过：默认 `get_advice` 不返回过期 advice（`includeExpired=true` 可强行列）。新建议由 DSH 会话的交互分析经 `record_advice` 写回，不会自动重新生成。

### 12.8 如何卸载？

```bash
rm -rf "$LUOOME_HOME"            # 删数据（默认 ~/.luoome）
# 在 DSH profile 目录卸载插件，并从 cordis.patch.yml 移除 luoome-plugin 条目，然后重启 DSH
npm uninstall dsh-luoome
```

---

## 13. 更多阅读

### 13.1 配置模型

模型推理在 DSH 侧完成：先在 DSH Settings → Models 配置模型与密钥，DSH agent 再通过插件
注册的 luoome 工具产出建议、简报与复盘。未配置模型时，历史事实、建议与只读面板仍可读取，
分析不会成功；不要把本机 API key 复制进部署配置。

luoome 侧不再保留模型目录、provider 密钥或模型设置页；插件面板只负责看盘、持仓、策略、告警、计划、复盘与数据导入导出。

### 13.2 部署注意事项

- 部署应以 HTTPS 为首选。若公网入口只能使用已授权的明文 HTTP 回退，Pocket 密码与 DSH 会话仍然校验，
  但没有传输加密；不要在不可信网络上传输凭据。
- DSH 侧栏的七个业务视图与聊天读同一份数据：面板只做投影，不在浏览器重算数值。
- 嵌入式 DSH Chat（Node Host + 业务 Cordis 插件）已随托管形态下线，仓库里不再有这条路径。
- 默认部署已切纯插件：`luoome-dsh`（Node + DSH + dsh-luoome）与 `luoome-caddy` 两个宿主机 systemd
  服务，没有 MCP/Bun/worker/queue probe 进程；插件 profile 由 `deploy/dsh/profile-seed.mjs` 装配。
  安装、升级、一致性备份与回退步骤见 [7.7](#77-安装升级备份与回退宿主机直部署)。
- 旧 MCP 过渡形态源码已删除（REQ-M2-03：`packages/mcp`、`luoome mcp serve`、部署侧探针）；
  仓库完成隔离切换/回退演练后，生产服务器已于 2026-10-25 切到纯插件形态（切换记录见服务器
  `/opt/luoome/DEPLOYMENT.md`）。
- 线上版本与升级结果保存在对应 release 的 `release-manifest.json`、`deployment-result.json`，
  升级与回退记录见服务器 `/opt/luoome/DEPLOYMENT.md`；升级保留既有自动任务开关与逐任务授权。

### 13.3 延伸阅读

- [文档导航](./README.md) — 产品需求、技术设计、运维手册与历史归档
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 模块 / 数据流 / advisor 模型
- [dsh-luoome 安装说明](../packages/dsh-luoome/README.md) — 外部接入：插件安装、面板与随包技能
- [AGENTS.md](../AGENTS.md) — 编码 Agent 仓库开发规范
- [ROADMAP.md](./ROADMAP.md) — 版本演进
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 贡献者指南
- [SECURITY.md](./SECURITY.md) — 副作用分级 + 单机入口鉴权与暴露面
- [BACKLOG.md](./BACKLOG.md) — 一致性 / 工程债清单
