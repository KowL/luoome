# luoome 用户手册

> 给**人**看的使用文档：本地安装、运行、自定义、复盘。如果你打算让外部 Agent 使用 luoome，请安装 [luoome Skill](../skills/luoome/SKILL.md)；想了解架构看 [ARCHITECTURE.md](./ARCHITECTURE.md)。

luoome 是一个**本地优先**的个人投资 advisor agent。它能：

- 作为 **DSH 插件**接入 DSH：默认部署由 dsh-luoome 在 DSH Node 进程内提供三面板、四条投研技能与原生工具/审批（旧 MCP 四实例仅保留给手动验收）
- 在**终端（TUI）**盯盘、看今日建议
- 在**浏览器（Web）**管理 Strategy、Watchlist、AlertPlan 与复盘
- 作为 **MCP server** 按显式授权向 Claude Desktop / OpenClaw 等 AI agent 暴露能力
- 通过**工作流**运行 Strategy、同步 Watchlist、盯盘与生成报告

但 luoome **不会**替你下单。所有建议都带 `decision / confidence / horizon / reasoning / risks / disclaimers / validUntil`，人最终拍板。

当前形态是**单机版**：没有多租户、没有订阅计费、没有托管站点，也没有邮箱登录——
DSH 是唯一入口，`$LUOOME_HOME/luoome.db` 是唯一事实库。批处理由 DSH 的定时任务负责，
没有常驻调度进程，也没有常驻队列消费者。

## 目录

1. [安装](#1-安装)
2. [第一次启动](#2-第一次启动)
3. [CLI 速查](#3-cli-速查)
4. [TUI 用法](#4-tui-用法)
5. [Web 用法](#5-web-用法)
6. [MCP 接入](#6-mcp-接入)
7. [DSH 单机用法](#7-dsh-单机用法)
8. [多账户切换](#8-多账户切换)
9. [复盘与 confidence 校准](#9-复盘与-confidence-校准)
10. [数据存储位置](#10-数据存储位置)
11. [环境变量](#11-环境变量)
12. [FAQ / 故障排查](#12-faq--故障排查)
13. [更多阅读](#13-更多阅读)

---

## 1. 安装

### 1.1 系统要求

- **macOS / Linux / Windows**（Windows 用 PowerShell 5.1+，也可走 WSL2）
- **Bun ≥ 1.3**（[安装](https://bun.sh)；一键脚本会自动装）
- **网络**（仅在启用 `LUOOME_MARKET_PROVIDER=real` 时需要，用于拉 Eastmoney / Tencent / Sina 行情）
- **可选** Python 3.10+（仅诊断/可视化子工具间接依赖）

### 1.2 一键安装脚本（推荐，无需 git）

macOS / Linux：

```bash
curl -fsSL https://raw.githubusercontent.com/KowL/luoome/main/install.sh | sh
```

Windows（PowerShell）：

```powershell
irm https://raw.githubusercontent.com/KowL/luoome/main/install.ps1 | iex
```

脚本自动完成：检测并安装 Bun → 下载源码到 `~/.luoome/src`（Windows 为 `~\.luoome\src`）→
`bun install` → 生成 `luoome` 命令（macOS/Linux 在 `~/.local/bin`，Windows 在
`~\.luoome\bin\luoome.cmd` 并写入用户 PATH）。可用环境变量覆盖：`LUOOME_REF`（分支 / tag /
commit，默认 `main`）、`LUOOME_HOME`、`LUOOME_BIN_DIR`。重新执行即升级。

### 1.3 从源码运行（开发 / 验证）

```bash
git clone git@github.com:KowL/luoome.git
cd luoome
bun install              # 装工作区依赖
bun run typecheck        # 全包静态检查
bun test                 # Node 兼容的 Vitest 测试
bun run test:all         # Vitest + Bun db/web 测试
```

### 1.4 通过 Homebrew（macOS / Linux）

```bash
# tap 后 install（formula 由仓库内 homebrew/luoome.rb 提供）
brew tap KowL/luoome
brew install luoome

# 验证
luoome --version
luoome tools list | head
```

> Formula 走 git HEAD 构建（依赖 Bun 编译器）；首次安装会从 GitHub 拉源码 + 跑 `bun install`。tag 发布后会切到 tarball binary。

### 1.5 不安装直接用

如果只是接 MCP / Agent，跳过本地 install；先按 [luoome Skill 的 MCP 配置](../skills/luoome/references/mcp-setup.md) 连接 `luoome mcp serve`，再通过 Agent harness 的 Skill 机制安装整个 `skills/luoome/` 目录。

---

## 2. 第一次启动

luoome 数据存在 `~/.luoome/luoome.db`（SQLite）。首次运行只自动建表；内置策略作为模板目录
展示，不会写成 Strategy，也不会灌入账户、持仓、交易或建议。从模板创建的是独立用户策略，
可以继续修改或删除。创建账户等写操作要求以 `LUOOME_EXPOSE_WRITE=true` 启动
Web（严格默认，见 §11 环境变量）；然后打开 Web 进入「设置」创建第一个真实账户。

### 2.1 一键启动单机 Web

```bash
luoome start
```

这会在 `127.0.0.1:5173` 启动 Web。单机形态没有常驻盯盘进程：批量调度由 **DSH 定时任务**负责（见 [§7](#7-dsh-单机用法)）。首次启动还会：

- 创建 `~/.luoome/luoome.db`

打开 `http://127.0.0.1:5173/`，即可在「设置」页执行持仓、分组和盯盘修改（前提是以 `LUOOME_EXPOSE_WRITE=true` 启动；行情同步等外部调用还需 `LUOOME_EXPOSE_EXTERNAL=true`）。只想开 Web 时使用 `luoome web serve`。

「预警」页的交易计划卡片直接展示生成时参考价及来源时间、入场区间、止损/止盈、当前与目标仓位、持有周期和复核时间。参考价是计划生成时的事实，不代表实时行情；缺失或过时数据会明确标注。详情展示数值触发条件、前置约束、反证和风险；内部计划版本标识、账户事实指纹及来源标识收在默认折叠的「查看追溯信息」中。计划不会自动下单。

计划按多个交易日持续跟踪。盘后复核条件未变化时维持原版本和硬有效期，并在任务审计中记录本次复核；关键价位、仓位、风险或账户前提变化后生成新版本。复核时间与过期时间分开，到复核时间不代表计划已经过期，新的生效计划期限根据研究周期计算。

列表默认显示「当前计划」，可分别筛选可监控、待补全、等待数据和待生效。账户已变化、已过期、撤销或被替代的记录退出默认视图，可通过「已失效」「已过期」「历史版本」或「全部记录」查看，筛选项和头部均显示数量。生效计划未过期且账户前提有效时，新的修订草案会附在原计划下，不中断原计划监控；原生效版失效后，未过期新草案会成为主要展示版本。

草案最多保留首次生成后的两个交易日，重复失败和连续草案修订不延长期限；存量草案同样会被判定过期，历史依据保留。超过期限仍未补齐的草案继续留在历史，补齐前提并通过校验后才能发布新生效版。「等待价格进入区间」是有效计划的正常条件，缺价位、AI 失败或策略冲突属于待补全，账户事实不可用则显示等待数据。批次审计区分新增、维持与草案数量，全部产出草案也会显示部分完成。

「可监控」只表示计划具备监控资格，实际运行和送达仍以预警记录为准。多个入场条件必须全部满足，
风险与退出条件只在对应仓位已持仓时才形成提醒，命中时优先提醒风险；人工确认和过期事实不会被当作满足。
观察计划命中后先重新评估；未持仓计划的止损、目标价与退出条件只是入场前提，不推送提醒，只在预警页
留一条未投递记录（其命中仍会阻止入场提醒），也不会被当成卖出指令。盘中提醒不等待 AI、不自动修改原计划，通知保留
反证、风险、止损/目标价、有效期和可卖限制。试跑不会消耗正式提醒边沿或投递额度。


预警新建和编辑默认使用表单：按名称选择关注列表，添加价格、涨跌幅、成本止盈止损、策略信号或事件日期条件；百分比直接填写百分数（例如 5 表示 5%），规则标识由系统维护。保存失败会保留输入。

策略新建与新版本草案共用规则构建器，可从模板开始，再调整股票范围、筛选规则、评分权重和入场/退出/风险信号。常用指标条件通过下拉框与数值配置，复杂条件保留为可编辑表达式。需要完整配置时可主动切换「JSON 高级」；无效 JSON 会阻止保存，修正后可切回表单。底层保存格式与发布流程不变。

### 2.2 终端全屏

```bash
luoome tui
```

你应该看到顶部两行：免责声明横幅 + 当前账户名（如你创建时填写的账户名）；左栏持仓、右栏今日建议；底部快捷键栏。

### 2.3 浏览器

```bash
luoome web serve
# 默认 5173 端口；浏览器开 http://localhost:5173/
```

页面包含看盘、持仓、Strategy、Watchlist、AlertPlan、研究、建议、报告、复盘和设置。

看盘页优先展示个人看板与今日预警，板块热力和要闻位于其后。个人看板可按全部、我的持仓、我的关注、今日触发切换，并可叠加关注列表筛选。普通关注只需启用 Watchlist，不要求配置 AlertPlan；其它账户独有的 portfolio 来源不会混入当前账户的关注。服务器先筛选再分页，每页 10/20/40 只，超过 40 只仍可翻页查看。价格排序与涨跌统计仅针对本页；缺行情或昨收基准单列为“未知”。今日触发范围基于今日全部记录，包含已移出持仓或关注的股票，覆盖不完整时明确标注。

窄屏下个人看板按股票排成纵向卡片，价格、涨跌幅、关注来源和预警无需横向滚动即可阅读；顶部排序框可切换本页价格或涨跌幅升降序，也可恢复持仓优先。桌面保留表格，切换屏幕宽度和自动刷新时沿用排序。行情异常才算内容：旧快照或本地兜底在现价下标注并附行情时间，取不到行情写“行情不可用”，正常行情不额外占位；条数与本页涨跌分布只在看板统计行写一次。

点击预警次数或“证据”可查看触发理由、证据、规则求值快照、行情时间、送达状态，并标记已处理、有用、无用或忽略。反馈写入受 `LUOOME_EXPOSE_WRITE` 和同源校验保护；失败时不会伪装成功，也不会执行交易或重发通知。每只股票的“事件与计划”入口提供今日事件、当前账户的已保存计划版本，以及行情、研究、建议入口。计划记录状态不等于当前可执行资格，仍需结合有效期与当前账户事实核对。

看板每 15 秒刷新，市场情绪、板块、要闻与数据健康每 60 秒检查更新；隐藏标签页暂停自动请求，回到前台立即刷新看板与市场区块。刷新保留看板页码、每页数量、排序和建议展开状态；要闻新增条目保留已加载列表与阅读位置。可点击“刷新看盘”重试，失败时保留最后成功画面并提示；抓取时刻只在页面顶部状态条写一次，卡片不再逐块重复，市场情绪仍单独显示数据截至时刻与实际交易日。成功类状态提示 4 秒后自动隐去，错误提示保留到下一次状态更新。

点击“查看全部事件”可分页浏览今日记录，每页 20 条，支持优先级、反馈（含未反馈）及送达状态筛选；打开证据后可返回原筛选与页码。列表固定打开时的时间上界，重新打开可查看新增事件。首页股票范围和分布基于今日全部记录。

首页今日预警先在完整事件范围按紧急、重要、普通排序，同级按时间倒序，仅返回前 8 条；较早的紧急事件不会被大量新普通事件挤掉。今日预警总数与这 8 条预览分开：优先级、送达和反馈分布按全部记录聚合，噪声率使用全部已反馈记录；列表预览超过范围会提示；总数由数据库按筛选条件准确计数，不再受 10,000 条扫描边界限制。读取失败显示不可用，不视为没有触发。

看盘各区块独立降级：建议、盯盘状态或预警读取失败不会阻塞股票看板；持仓或关注来源失败会标注列表覆盖不完整，无法读取所选范围时显示不可用。失败区块不显示零条或“暂无数据”。切换范围后请求失败会显示重试入口，保留所选范围；同一范围的自动刷新失败则保留最后成功画面。

看板范围、关注列表、页码、每页数量和排序按账户保存在当前浏览器，刷新页面或切回账户时自动恢复；“重置视图”恢复当前账户的默认设置。浏览器禁用本地存储时仍可正常操作，但不会记忆设置。切换范围、账户或离开看盘页会取消浏览器中已失效的看板请求，避免继续等待旧请求；这不保证中止服务器已开始的查询。

阅读时可点击“暂停自动更新”，暂停看板和市场区块的定时更新及返回前台刷新；手动刷新、筛选和页面导航仍可使用。恢复自动更新会立即刷新看板与市场区块。暂停仅对当前页面会话生效，不会暂停服务端盯盘任务。

单股预警列按今日全部事件显示准确次数和“今日最高”，不受列表预览条数限制。点击次数打开最近一条记录，其优先级可能低于汇总中的最高级别；全部事件可在事件列表查询。

“事件与计划”先展示该股最近 8 条今日事件及准确总数；点击“查看该股全部今日事件”可进入固定股票范围的分页列表，继续按优先级、反馈和送达状态筛选。查看证据再返回时保留股票范围、筛选与页码。

所有 write/external mutation 同时要求显式环境开关与同源 `Origin`。

**持仓 tab 支持完整持仓管理（v0.8 起）**：卡片头部「+ 新增持仓」（建仓即写交易记录；股票输入走外部数据源搜索——Eastmoney 主 → Tencent 备，无结果时按代码位数给出 .SH/.SZ/.HK/.US 后缀候选兜底，选定后自动填入现价）；每行行内操作 **加仓 / 减仓 / 纠错 / 平仓**，页面下方保留近期交易流水。写操作受 `LUOOME_EXPOSE_WRITE` 控制；MCP 暴露策略不受影响。

**Watchlist 页（对齐 PRD §10）**：自上而下四层——状态统计卡片（列表数 / 成员数 / 今日 entered-exited / 待研究，后两者点击跳转同名区块；过期来源与紧急重要触发为非 0 才显示的提示小字）、分组列表股票区（tab 为「全部 + 每个列表」：全部展示去重行情表（名称/现价/涨跌幅 + 持仓标记），单列表展示信息条与成员行情表，支持编辑列表（名称 / 描述 / 启停）、归档列表（归档即停用，成员与历史保留）、手动加成员、成员 stage / priority 行内修改与归档、来源健康与关联 AlertPlan 入口）、今日变化区块、待研究区块（一键开始研究 / 归档）；已归档经页头按钮弹窗查看。Strategy 工作台设置页可明确选择目标 Watchlist、创建或取消持久订阅；只有 published operational run 会投影，partial/failed 只标 stale，evaluation/trial/withheld/non-publishing/failed 不改变 Watchlist。写操作受 `LUOOME_EXPOSE_WRITE` 控制。

**Strategy 模拟回测**：进入已发布且运行中的策略工作台，点击「模拟回测」，选择最长 31 个自然日的历史区间；股票代码留空时按历史时点全市场运行，也可输入不超过 500 只股票缩小范围。系统逐交易日使用 point-in-time 股票池和可用的历史数据版本，结果保存为 `evaluation`，只展示求值、入选、信号、失败和数据版本状态，不会替换当前股票池。该功能是历史回放模拟，不包含组合收益、费用、滑点或可交易性模型；运行需要同时开启 `LUOOME_EXPOSE_WRITE=true` 与 `LUOOME_EXPOSE_EXTERNAL=true`。

**研究页**：在“本地 Research Vault”卡片填写 Obsidian Vault 的绝对路径、扫描目录和受管目录，点击“保存并同步”。配置会写入 `$LUOOME_HOME/.env` 并立即应用，无需重启；保存前会校验真实路径及目录边界。普通 Markdown 只有带 luoome frontmatter 才进入索引，也可通过“导入本地资料”把明确提供的 Markdown/TXT 正文复制为受管研究文档。配置、同步和导入均受 `LUOOME_EXPOSE_WRITE` 控制；远程 URL 导入还需 `LUOOME_EXPOSE_EXTERNAL`。默认搜索只使用本地 FTS5。勾选“语义扩展（外部）”后，查询文本会发送给显式配置的 embedding provider；“增量重建”还会发送私人 chunk 正文并要求 `external + write`。页面会显示模型 identity、覆盖状态与不完整诊断；未配置、provider 失败或覆盖不完整时稳定回退 FTS5，零命中不代表完整研究库无证据。固定评测只比较版本化判定集的 Recall@K/MRR/成本/延迟，不等同于生产质量结论。

Embedding 模型目录默认位于 `$LUOOME_HOME/research-embeddings.json`。下例不含密钥；`RESEARCH_EMBEDDING_API_KEY` 必须单独放在环境中。修改目录或开关后重启进程：

```json
{
  "version": 1,
  "defaultModel": "small",
  "models": {
    "small": {
      "provider": "my-provider",
      "baseURL": "https://provider.example/v1",
      "apiKeyEnv": "RESEARCH_EMBEDDING_API_KEY",
      "model": "embedding-small",
      "dimensions": 1536,
      "version": "2026-08",
      "maxBatchSize": 64,
      "inputCostPerMillionTokensUsd": 0.02
    }
  }
}
```

同时设置 `LUOOME_RESEARCH_EMBEDDING_ENABLED=true`；Web 语义查询还需 `LUOOME_EXPOSE_EXTERNAL=true`，增量重建另需 `LUOOME_EXPOSE_WRITE=true`。目录或密钥无效时其它 Research 能力继续启动，embedding 状态显示为未挂载。

可选 Git 远端同步需把 Vault 本身配置为有 upstream 的 Git 工作树，并设置
`LUOOME_RESEARCH_REMOTE_SYNC=git`、`LUOOME_EXPOSE_WRITE=true`、`LUOOME_EXPOSE_EXTERNAL=true`。
研究页会显示“拉取远端并重建索引”，每次点击仍需确认。系统只接受完全干净工作树上的
fast-forward，先在 `$LUOOME_HOME/backups/research-vault/` 创建权限为 `0600` 的 bundle，再通过既有
索引流程重建；分叉、冲突、未完成 Git 操作、超时或取消都会停止。它绝不自动 commit、push、reset、
rebase 或选边。远端应使用私有仓库，HTTPS 凭证放系统 credential helper，SSH 凭证放 SSH agent，
不要写进 remote URL。

恢复时先运行 `git bundle verify <bundle>`，再运行 `git clone <bundle> <新的恢复目录>` 检查备份；
确认内容后人工复制所需文件或明确执行自己的 Git 恢复步骤。luoome 不会自动恢复或删除 bundle。
CLI 可显式运行：

```bash
luoome workflow run sync-research-vault-remote --mode manual
```

飞书报告采用手机摘要，只发送市场、策略研究、预警和事件信息；账户估值、持仓、仓位、逐账户交易计划、
交易归因与个人行为复盘仅在应用内完整报告中查看，账户数据缺失也不会变成群通知中的告警。
标题只出现一次，时间统一为北京时间；正常建议保留关键价位、反证、风险与有效期，AI 规则兜底按批次合并。
复盘优先展示已有数据：空指标合并说明，全空表格列不铺占位，缺失原因在「数据说明」中集中查看。
单日收益取上一交易日至当日的估值；未配置基准时不展示空基准指标，多账户收益率不相加。
市场部分覆盖时保留有效指数、涨跌样本和涨停/炸板行业分布，并明确样本范围；缺失数据不会填成零。
已有报告可直接使用新排版；取数修正需重新生成报告，历史快照不会自动改写。

收盘复盘的交易计划部分先汇总可监控、待补全、等待数据、待生效、未发布修订与停止跟踪的数量，
再列当日新增版本、维持原版和重复草案复核；复核按账户、目标日与确切版本去重，当日新增版本的
后续复核不会重复计入维持。下一交易日跟踪清单优先展示待补全、等待数据及临近到期计划（最多 20 项），
附下一步、截止时间、反证与风险，并可点开完整版本；手机上可横向查看跟踪表。有效旧版不会被新草案覆盖；未发布修订单列，
过期、失效和退役记录退出跟踪清单并保留引用。草案截止时间使用两个交易日上限，不沿用旧快照的长有效期。
前一交易日即使没有新增版本，也会显示已记录的维持复核。审计缺失或读取不完整会明确说明，不能解释为
全部计划已复核。跨日补发时版本截至目标日，资格按生成时的账户事实和有效期核验；历史报告保持原快照。
收盘复盘等待当日预期策略和账户交易计划批次完成后统一生成，每个账户每天只生成一份。
18:00 时任务尚未完成会继续等待；任务结束仍有数据缺口时在这份报告中明确说明。
手动生成新收盘报告也会检查策略和账户计划是否完成，未完成时提示稍后生成。
重复手动生成、定时运行和通知重试复用原报告，后到的数据不再生成 V2/V3 或改写正文。
清单展示前 20 项不会缩小报告保存的计划事实范围。

**飞书通知**：在“设置 → 飞书通知”填写群自定义机器人的新版 HTTPS Webhook。页面只展示是否已配置，读取 API 和浏览器均不会回显密钥；保存后写入权限为 0600 的 `$LUOOME_HOME/.env` 并立即应用。保存需要 `LUOOME_EXPOSE_WRITE=true`，发送测试消息还需要 `LUOOME_EXPOSE_EXTERNAL=true`。当前只支持 `open.feishu.cn/open-apis/bot/v2/hook/...`，建议机器人安全关键词配置为 `luoome`，不要开启签名校验。

### 2.4 MCP 模式

```bash
luoome mcp serve    # stdio JSON-RPC
```

安装 [luoome Skill](../skills/luoome/SKILL.md) 并连接 MCP 后，Agent 即可发现当前版本默认暴露的 read + advice tools；完整库存以 MCP discovery 为准。

---

## 3. CLI 速查

`luoome <子命令>` 全部子命令一览：

| 子命令 | 用途 |
|---|---|
| `luoome start [--port 5173] [--host 127.0.0.1]` | 启动单机 Web（批量调度由 DSH 定时任务负责） |
| `luoome tui` | 终端全屏应用（依赖 opentui） |
| `luoome web serve [--port 5173]` | 仅启动 Web |
| `luoome watch [--interval 60] [--alert-plan ID] [--once]` | 启动 AlertPlan 盯盘或执行单轮 |
| `luoome strategy list|get|validate|run` | 查询、校验或运行 Strategy |
| `luoome watchlist list|get|sync` | 查询 Watchlist 或同步 portfolio 来源 |
| `luoome tools call subscribe_strategy_to_watchlist --input '{...}'` | 明确订阅 Strategy 到目标 Watchlist |
| `luoome tools call unsubscribe_strategy_from_watchlist --input '{...}'` | 取消订阅并保留审计历史 |
| `luoome alert list` | 查询 AlertPlan |
| `luoome mcp serve` | 启动 MCP stdio server |
| `luoome tools list [--json]` | 列全部注册 tool（含 sideEffect） |
| `luoome tools inspect <name>` | 看 tool 的 input/output schema |
| `luoome tools call <name> --input '{...}'` | 直接调 tool（按解析后的 ctx） |
| `luoome accounts list` | 列账户（含 kind / currency / initialCapital） |
| `luoome holdings list [--accountId X]` | 列持仓（含现价、PnL、汇总） |
| `luoome analyze <stockId> [--include-evidence]` | 单只股票深度分析 |
| `luoome advice list [--since 7d] [--limit 50]` | 历史建议 |
| `luoome advice stats [--since 30d]` | 准确率统计（命中率、跟单盈亏） |
| `luoome advice outcome <id> --followed true --pnl 100` | 回填 advice 结果（write） |
| `luoome sync-quotes` | 全量同步当前账户持仓行情（写库） |
| `luoome daily-review [--since 7d]` | 触发 daily-review workflow，写入报告文件 |

`--since / --until` 接 ISO 时间或 `7d / 30d / 24h / 1y` 等相对量。详见 `luoome --help`。

---

## 4. TUI 用法

启动 `luoome tui` 后：

### 4.1 顶部两行

- 第 1 行：**STANDARD_DISCLAIMERS 前两条**——这是工具提示（不建议覆盖）。
- 第 2 行：**当前账户名 + 币种 + 初始资金** + `[a] 切换` 提示。

### 4.2 快捷键

| 按键 | 行为 |
|---|---|
| `[q]` | 退出 |
| `[r]` | 立即刷新（持仓 + 建议，绕过 5 s 自动刷新） |
| `[d]` | 当前持仓详细建议（核心论点 / 支持 / 反证 / 风险 / 免责声明） |
| `[s]` | **复盘统计**：命中率、跟单盈亏、按决策分解 |
| `[c]` | **confidence 自校准**：每 10 一档，看到底 confidence 被高估还是低估 |
| `[o]` | outcome 复盘：最近 20 条建议的状态（已回填 / 待回填） |
| `[a]` | **账户切换**：j/k 上下移动 + Enter 选中 |
| `[↑/↓]` 或 `[j/k]` | 滚动列表 / 弹层 / 账户光标（取决于当前激活视图） |
| `[esc]` | 关闭弹层；二次按下等同 `[q]` |

TUI 内部用 `ctxRef` 包裹当前 ToolContext；切账户 = clone user 不动 repos。刷新周期 5 s 自动 + `[r]` 手动。

---

## 5. Web 用法

`luoome start` 或 `luoome web serve` 启动后，浏览器访问 `http://127.0.0.1:5173`。

### 5.1 写操作开关

Web API 不做 token 校验。浏览器账户切换会将当前账户 id 通过 `X-Luoome-Account-Id` 随请求发送，服务端按请求隔离账户上下文，避免多个 tab 互相覆盖；这不是账户级鉴权。写操作仍需显式设置 `LUOOME_EXPOSE_WRITE=true`，外部调用仍需设置 `LUOOME_EXPOSE_EXTERNAL=true`；浏览器 mutation 保留同源 Origin 校验。

### 5.2 核心页面

| Tab | 内容 |
|---|---|
| **首页** | AI 讨论入口、持仓变化、参与方向与计划进展；事实先展示，研究结果和当前共识独立保存。原指数、看板、预警与数据健康保留在「行情与原看盘工作台」。 |
| **持仓** | 建仓、加仓、减仓、纠错、平仓 + 近期交易流水。 |
| **Strategy** | 从模板创建、版本校验、发布、删除、自动调度、dry-run 与运行结果；设置页支持显式订阅/取消目标 Watchlist。 |
| **Watchlist** | 统计卡片 + 分组列表股票区（全部 / 单列表 tab）+ 今日变化 + 待研究 + 已归档弹窗；支持用逗号、空格或换行批量添加成员，以及成员 stage/priority 编辑与归档、列表编辑/归档、来源健康与关联 AlertPlan 联动。 |
| **AlertPlan** | 规则管理、手动试跑和 Trigger 审计；试跑不自动交易。 |
| **研究** | 配置本地 Obsidian Vault、同步索引、创建 Topic、导入本地正文或远程 URL。 |
| **建议** | 历史 + decision 过滤。 |
| **复盘** | 当前账户的明确反馈、成交归因、事后观察与 confidence 校准表；从建议进入「决策与复盘」。 |
| **报告** | 查看与导出报告；收盘复盘统一生成一份，周报支持根据后补记录生成不可通知的复盘补充版。 |
| **设置** | 数据源 / 账户，以及可按分类选择的本地 JSON 数据导出与合并导入。单机部署没有管理员角色：数据源由这台机器上的操作者自己改。 |

个股详情不是侧栏 tab，从看盘、持仓、Watchlist、预警或顶栏搜索点击股票进入（深链接形如 `#market?stockId=002594.SZ&range=3m`）。打开后固定在顶部展示报价卡（名称与代码、价格与涨跌、今开 / 最高 / 最低 / 昨收、成交量额、换手与振幅、估值与股本），下方才是 K 线 / 分时图与关联事实。**打开详情或换股都会回到顶部报价卡**；只有切换区间（1M / 3M …）或粒度（日 K / 周 K / 分时）时保留当前滚动位置。切换左侧导航同样回到页面顶部，但页内自动刷新不会改变滚动位置。

模型对话已随 DSH 改造退役：luoome 侧不再有 AI 助手页面，模型推理在 DSH 侧完成。保留下来的是
不依赖模型的待确认草案链路，要求启动时显式开启 `LUOOME_EXPOSE_WRITE=true` 和
`LUOOME_EXPOSE_EXTERNAL=true`。在首页工作台发起「生成待确认草案」，页面会展示待确认卡片，
包括实际账户、数量、金额和现金影响；核对后点击「确认执行」或「取消」。
多项草案逐项处理，刷新页面会保留各项状态，重复确认不会重复执行。若显示执行中且进程曾中断，
请先核对实际账本；确认未执行后可点「取消该草案」
（终态，不会补执行），再让助手重新生成。
账户和持仓操作只维护本地账本，不自动交易；正式建议仍需保留反证、风险和有效期。

#### 首页共同研究

从持仓、方向或计划点击「一起讨论」，输入处会显示当前主体；可选择最多四个对象比较。
「深入展开」进入完整会话，返回先回到就地讨论，再恢复原卡片位置。手机完整讨论使用可用视口高度；
「停止回答」只停止本轮响应，不暂停既有跟踪。刷新会从服务端恢复真实消息和草案状态；
未发送文本仅在当前浏览器会话中保存，退出或换用户即清理。弱网时先核对会话状态，不自动重复执行。

「提出研究草案」在你再次确认后才使用模型。有合格的已发布策略时比较策略事实；没有预设策略或合格运行时，
读取可用的市场广度、A 股指数和涨停/炸板事件池事实。最多三个方向，明确披露范围、来源时间、反对意见、风险、
等待/放弃条件与有效期；没有合格事实或模型失败时不会编造方向。事件池行业分布不等于完整行业行情或个股推荐。
选择主次方向或调整近期意愿后，核对可读草案再确认。共识按版本保存；其它页面已更新时旧草案会失败，
请读取最新版本后重新确认。删除聊天保留已确认共识和跟踪。

共识保存与方向跟踪是两步。市场方向可以保存共识；尚未关联真实策略和股票候选时，页面显示不能开启个股跟踪及原因。
混合方向只连接已有真实映射的策略方向，并保留未连接原因。市场事实到期后共识标为待复核，历史仍可回看。
跟踪只连接方向专用关注列表和策略订阅；没有开启原策略自动调度时会显示部分可用，
不会声称后台已运行，也不会自动新增付费研究、预警计划或通知渠道。「暂停新机会」不关闭持仓风险监控。
收到确切提醒链接后，先查看原触发快照与最新资格；历史触发不代表当前行动条件仍成立。
「登记 / 关联实际成交」复用原有专用登记入口，数量、价格、时间和尚未入账确认仍由你核对。

单机形态的通知走本机配置的飞书链路：Webhook 在「设置 → 飞书通知」里填写，只展示是否已配置，
读取和回显都不会带出密钥。渠道受理和设备到达分别表达，未获回执时保持未知。
真实模型、行情与手机通知、iOS/Android 真机仍需单独验收。
详细契约见 [AI 投资协作首页详细设计](./ddd/ai-investment-workspace-detailed-design.md)。

### 5.3 顶栏与侧栏

顶栏（窄屏下两行）：左侧品牌，右侧依次是股票搜索、账户、时钟——搜索靠右与账户/时钟同簇，不居中。搜索支持代码与名称，候选可直接点击或 `↑`/`↓` + `Enter` 选中、`Esc` 清空；任意页面按 `⌘K`（Windows/Linux 为 `Ctrl K`）聚焦搜索，在非输入控件处按 `/` 也一样，输入框内不会抢键。时钟显示当前时间（窄屏去秒），鼠标悬停可看完整日期、时区与交易时段；时段徽标（交易中 / 午间休市 / 已收盘 / 盘前 / 非交易日）来自服务端 `get_market_data_status` 的交易时段，不在浏览器里重算交易日历，读取失败时仅隐藏徽标。主题皮肤入口在侧栏底部（窄屏时为导航条右侧的「◈ 主题」按钮），点击打开右侧皮肤抽屉。

切换顶栏账户会向 `POST /api/account/select` 发请求，后端更新当前默认账户，然后自动 reload 当前视图。localStorage 持久化（`luoome.accountId`）以便下次启动自动复原。

---

## 6. MCP 接入

`luoome mcp serve` 启动 stdio JSON-RPC server。配置参考 [luoome Skill 的 MCP 配置](../skills/luoome/references/mcp-setup.md)。默认暴露：

- **read** tools（list / search / get / compute）

opt-in 追加：

- `LUOOME_EXPOSE_WRITE=true` → 追加账户、持仓、交易、研究、事件和反馈等 write tools
- `LUOOME_EXPOSE_EXTERNAL=true` → 追加行情、同步、刷新和通知等 external tools
- `LUOOME_EXPOSE_QUEUE=true` → 追加队列工具（分析面与手动 worker 实例专用）
- `LUOOME_EXPOSE_TOOLS` / `LUOOME_EXPOSE_DENY` → 按工具名精确放行 / 拒绝

`LUOOME_EXPOSE_TRADE=true` **永远硬卡**：MCP server 启动即抛错退出；advice × trade 隔离硬约束绝不通过 MCP 暴露。

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
窄屏使用抽屉导航，点击看盘、
持仓、策略或复盘后会自动收起抽屉；导航按钮为面板标题留出空间，写操作仍须预览和确认。

公网密码保存在 `$DSH_HOME/dsh-pocket/token`（权限 `0600`），在 DSH「设置 → 手机访问」中
可修改为 8–64 位字母或数字的固定密码。升级须保留 `$DSH_HOME`；DSH 重启后登录状态失效，
重新输入同一密码即可。公网 IP 直连不需要开启 Cloudflare 隧道，也不需要发布 3080/3081 端口。
当前 HTTP 入口没有传输加密。

| 插件面 | 内容 |
|---|---|
| read（精确白名单） | 账户/持仓/交易/绩效、Advice/复盘、Strategy、关注/触发、本地市场事实等只读工具 |
| market external（精确白名单） | 指数、情绪、行情、新闻与有界策略试跑/对照；失败原样返回，不伪造空成功 |
| 确认写操作 | DecisionReview、`record_advice`、`record_analysis_result`、策略 create/version/validate/publish、`record_advice_outcome`、账户改名、关注列表与成员维护；batch 另需显式开启，每次写入均经确认或精确任务授权 |
| client | 看盘 / 持仓 / 关注 / 策略 / 复盘五个业务面板，投资设置位于 DSH 设置内，经宿主认证的 `/api/luoome/state` 读取固定 ToolResult |
| skills | `strategy-lab`、`strategy-result-review`、`post-close-review`、`daily-market-analysis` |

事实库是 `LUOOME_HOME/luoome.db`（Node SQLite），由插件在 DSH 进程内直接打开。通用
`/api/luoome/call` 仍只读；`trade` 永不注册，`LUOOME_EXPOSE_TRADE=true` 启动即失败；自动任务默认关闭。

旧「当前 MCP 过渡形态」的四个实例（`luoome` / `luoome-settings` / `luoome-analysis` /
`luoome-batch`）与手动 worker 仍保留源码，但**只用于手动/隔离验收**，默认部署不启动；P5 再统一删除。

### 7.2 面板

DSH 侧栏有五个 luoome 业务面板，投资设置从 DSH「设置」进入：

| 面板 | 内容 |
|---|---|
| 看盘 | 核心指数、市场情绪、账户与资产概览、盯盘触发、既有建议、市场数据健康 |
| 持仓 | 当前账户持仓、最近成交和绩效快照；不在浏览器重新计算业务数字 |
| 关注 | 独立管理关注列表与成员，展示股票名称、代码、研究阶段、优先级与关注来源；支持手动管理和交给 AI 管理 |
| 策略 | 四步骤实验工作台：问题与规则、试跑与诊断、分层验证、结论与更新；保存后恢复固定版本、范围、基准和未完成研究。保留正式策略定义、匹配结果与原始规则依据。点击股票可查看报价，主动读取真实历史日 K，再进入带策略来源的新分析对话。 |
| 复盘 | 建议命中率、真实 confidence calibration 分桶、DecisionReview 最近记录与来源、逐条 Advice 用户反馈（未回填不推断）、待补齐观察与样本数/未知/时间范围 |
| DSH 设置 → 投资设置 | FUYAO 服务地址与 API Key、行情源优先级、当前账户、数据健康与插件能力；账户改名需预览并明确确认 |

面板只做投影，不自己算数：数字必须与工具输出逐位一致。点击「刷新事实」读取当前工具结果，
工具失败显示错误，不以零值代替缺失数据。

在「关注」页可新建、编辑、启停或归档列表，添加股票、调整研究阶段和优先级、移除手动关注。
每次修改先预览，再确认或取消；移除手动关注只结束 manual 来源，有策略、持仓或其他来源时
仍保留该股票。同步列表的成员由来源维护，不能手工添加。「交给 AI 管理」会把当前列表带入
可编辑的对话草稿，发送后由 AI 读取现状并提出方案，写入仍需逐次确认，不自动启用定时任务。

公网部署在 `/dsh/` 等子路径时，面板和确认操作的请求都跟随 DSH 的 document base。
0.2.1 修复了此前漏掉前缀、收到空响应而显示“读取失败”的问题。核心指数独立读取指数接口，
情绪维度超时不隐藏已取得的指数；行情时点保留供应商日期。情绪首次聚合可能需要十余秒，期间显示读取状态。

### 7.3 技能

默认部署安装 `dsh-luoome` 随包的四条投研技能（`packages/dsh-luoome/skills/`）：

| 技能 | 触发 | 行为 |
|---|---|---|
| `strategy-lab` | 对话制定/修改策略 | 恢复研究问题和固定版本 → catalog 草案 → 独立校验 → 字段预检 → 同快照试跑/有界比较 → 历史验证与结论；每项持久操作独立审批，发布不被创建或校验隐含批准 |
| `strategy-result-review` | 研究某次策略运行结果 | 按版本解释入选/临界/未入选/缺失，核对验证进度、真实 T+1/T+3/T+5 和持续观察回执；保留反证与限制，结论绑定可审计证据，改版走 strategy-lab |
| `post-close-review` | 收盘后复盘 | Advice 快照、DecisionReview、显式 Trade、观察、绩效与 calibration 分写；不推断用户跟随、不代填 outcome；复盘笔记经原生审批保存 |
| `daily-market-analysis` | 每日市场分析 | 经精确 market external 白名单刷新指数/情绪/要闻/行情，保留 source/dataAsOf/partial/unavailable；形成 Advice 时另取有效 context 并经原生审批写回 |

技能本身不授予权限：能调哪些工具仍由插件的 read/market/policy 面决定；写操作一律要 DSH 原生审批。
原生确认入口按每项操作的领域 Zod schema 提供参数契约。账户和 requestId 由宿主绑定，业务参数应省略 requestId；冲突时错误会明确指向字段，不应删改笔记或盈亏试探。invalid_input 会返回字段路径与类型要求，
表示参数未通过校验，不代表缺少人工授权；纠正参数后仍需独立审批，不用写调用探测工具或权限。
当前固定 SDK 下，MiniMax M3/M3.1 Flash 的原生调用**不会稳定写出 JSON null**——它在填对象参数时
用"省略该属性"表达"无值"。luoome 的写契约已按此调整：可空业务字段（如复盘的 `triggerFeedback`、
`adviceFeedback`、`note`）在参数契约上是可选的。**更新时省略保留原值，显式 null 才清除**；
tradeIds 省略保留关联，显式空数组解除关联。新建时省略字段初始为空数组/null。审批卡展示的是
按 expectedRevision 补齐后的完整内容；字符串 `"null"` 这类占位值仍被拒。因此复盘保存与反馈写回在默认 native 配置下已实测通过，
不再需要 `DSH_TOOLS_MODE=ptc`。PTC 仍是官方备选通道，需要时在启动 DSH 进程时显式设置即可，
默认配置不会自动切换。完整边界见[部分更新与真实模型验收记录](./ddd/dsh-luoome-plugin-detailed-design.md#917-decisionreview-部分更新回归修复2026-10-25)。
旧 `.dsh/skills/`（`morning-brief`、`stock-deep-dive`、`decision-journal`、`luoome-batch`、
`analysis-worker`）属于旧 MCP 过渡形态，默认部署不安装；`analysis-worker` 仅用于手动 worker 验收。

看盘页在交易时段每 60 秒自动刷新一次，非交易时段停止轮询、等下一次开盘再恢复；标签页隐藏时不发请求，回到前台立即刷新一次；刷新失败保留最后一次成功画面并提示，也可随时点「刷新事实」手动刷新。持仓页回读当前账户持仓、最近成交和绩效快照；DSH「设置 → 投资设置」可预览、取消和确认账户改名，名称以外的账本字段不变。刷新后可按操作 UUID 核对结果，浏览器不保存确认 token。新增/切换账户、完整持仓维护、其他供应商凭据配置和数据导入恢复仍使用现有受控管理入口。

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
| 严格回测 | 按固定执行模型，组合在历史上如何变化？ | 必须通过可交易性、公司行动、基准等数据门禁；不能用当前行情补历史 |
| T+1/T+3/T+5 真实观察 | 已有信号随后实际出现了什么？ | 是逐股事后观察，不是组合回测；小样本和未到期观察不能证明策略有效 |

严格回测当前执行模型是 `next-open-full-rebalance-equal-weight-v1`。真实历史数据不具备所需字段时，页面应列出日期、字段或来源缺口；有日线不等于具备严格回测资格。同日不同版本、同策略跨日和不同策略比较的范围不同，只有后端提供的同口径事实才能比较。

持续观察还要核对 DSH 任务、有效授权和实际运行回执。仅开启策略日程不能证明后台正在运行，通知受理也不等于送达。研究结论应保存反证、限制和下一步；导出的 manifest 携带定义与证据引用，不携带完整供应商历史数据，也不会自动发布或交易。

### 7.4 DSH 定时任务与批处理

默认关闭批处理与自动执行。插件已具备五个原生入口，无需旧 MCP 实例：

- 部署设置 `LUOOME_BATCH_ENABLED=true` 后，可经 `luoome_confirmed_operation` 单次确认补跑；`luoome_automation_catalog` 只读返回现有任务、任务指纹和账户绑定调用模板。
- `LUOOME_AUTOMATIONS_ENABLED=true` 还要求 batch 开关已开启。它允许核验持久授权，不能代替逐任务的原生审批。
- 每个入口完整要求 `write + external`。账户快照、计划与报告只作用于绑定账户；策略日循环与自治处理本地全局策略，自治可能按既有门禁暂停、归档或发布版本，审批说明会展示这些影响。

下表是**新建任务的示例**，旧日程的 ID、时间与会话不能默默改写；旧时间不满足门槛时会跳过，应先展示变更再确认。

| 批处理 | 原生操作名 | 示例 cron（Asia/Shanghai） | 门槛 |
|---|---|---|---|
| 策略日循环 | `run_strategy_daily_cycle` | `30 16 * * 1-5` | 交易日，内部策略调度仍独立认领 |
| 收盘报告截止 | `run_closing_report_cutoff` | `5 18 * * 1-5` | 交易日；18:00 截止后允许明确记录缺口 |
| 账户绩效快照 | `run_portfolio_performance_snapshot` | `30 16 * * 1-5` | 交易日且已过 16:00 |
| 盘中计划批处理 | `run_intraday_plan_batch` | `35 9 * * 1-5` | 实际盘中时段，09:05 会跳过 |
| 策略自治周报 | `run_strategy_autonomy_weekly` | `30 9 * * 0` | 周日 |

迁移顺序：先保持自动执行关闭，只开 batch；在 DSH「自动化任务」核对原任务，在同一 ID 和原时间上改用原生调用提示。再读 `luoome_automation_catalog`，逐项选择对应调用模板，冻结宿主给出的 identity、scheduleHash、accountId、inputJson/inputHash、组合能力与有效期，使用 `configure_plugin_automation` 的原生审批创建授权。最后才开启自动执行。目录按建议的 grant ID 查询既有授权；自定义 grant ID 要结合原操作回执核对。

提醒真正投递后，模型调用 `luoome_scheduled_operation`，提交 grantId、grantVersion、tool、accountId 和模板中的完整 input。任务身份与 occurrence 由宿主投递历史核验，prompt 或模型自报 taskId 无效；修改任务定义后，旧指纹不再匹配，必须重新核对授权。重复投递不会重复执行同一 occurrence。

手动 `force: true` 只经单次明确确认；定时授权拒绝 force。`partial` 表示部分失败，不能报告全部完成。操作状态 `unknown` 时只查询/核对业务回执，不自动补跑，也不能通过更换 operation ID 假定前次没有写入。用户拒绝后，同一请求中的后续写入会被宿主阻断；需要新的用户请求才能重新审批。

### 7.5 批量分析与队列

批量任务状态为 `pending → claimed → completed`，失败按退避重试，达到上限进入 `dead_letter`。

- `get_analysis_metrics` 查看积压、可执行任务与过期租约；`list_analysis_jobs`、`get_analysis_job` 查看任务状态。
- 交互式分析不建 job：插件 read 面取持久化 context 后，向你展示结论、反证、风险、有效期与
  将写回内容并得到明确确认，再经原生审批调用 `record_advice` / `record_analysis_result` 写回。
- 单机形态没有生产者进程，默认部署也没有常驻消费者，空队列是正常状态。
- 过期租约可以重新领取，旧 token 不能写回。
- `queue` 是独立能力；默认部署只由两条 analysis record policy 使用，claim/complete/fail 与
  job 查询不在插件暴露面。手动 worker 验收才用完整队列消费白名单（旧 MCP profile）。

建议展示保留反证、风险、免责声明和有效期；`legacy-ai` 表示迁移前的建议，
不能据此推断当时模型或技能版本。校准页面按生成方式、模型和技能版本分别统计，
每组以及每个信心桶至少需要 20 条明确跟随且填报盈亏的样本才展示比例。

### 7.6 单机 Web

需要图形界面做精细管理时仍可起单机 Web（`luoome web serve`，默认 `127.0.0.1:5173`）。
它与 DSH 读同一份单机事实库；写操作同样受 `LUOOME_EXPOSE_WRITE` 与同源校验保护。
远程访问请走 SSH 隧道或受控反代，不要直接把端口暴露到公网。

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
4. `sudo systemctl enable --now luoome-dsh luoome-caddy`，然后用 Pocket 密码登录，确认
   `/dsh/api/luoome/profile` 可读取、五个面板与四条技能都在（只有密码页返回 200 不能证明 DSH 上游可用）。

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

账户不再内置。首次启动在 Web「设置」页创建；也可调用
`create_account({ name, currency, initialCapital })`。所有账户均为 `kind: real`。

切账户后：

- **TUI**：持仓 / 建议全部按新账户重读。list_holdings 等读路径走 `ctx.user.defaultAccountId`。
- **Web**：账户下拉切换会触发 `/api/account/select`，然后 reload 当前路由。
- **CLI / MCP**：账户相关 tool 可通过 `accountId` 显式选账户，缺省使用当前上下文账户；MCP 不暴露 `add_trade` 或 `record_decision_trade`。

### 8.1 给新账户加仓（演示）

```bash
# 添加到「短线交易」账户
luoome tools call add_trade --input '{
  "accountId": "a1b2c3d4-0001-4000-8000-000000000002",
  "stockId": "002594.SZ",
  "side": "buy",
  "quantity": 200,
  "price": 105.8,
  "executedAt": "2026-07-21T09:35"
}'
```

完成后切到「短线交易」账户，`list_holdings` 会显示这条新持仓。

---

## 9. 复盘与 confidence 校准

复盘将当时依据、用户明确记录的行动和后来观察放在当前账户下回看。切换账户后，反馈和统计随账户切换。
建议采纳、实际成交和事后涨跌各自记录；系统不会从其中一项推断另外两项。

### 9.1 记录与修改复盘

先确认顶栏账户，再从建议、交易计划版本或提醒详情打开「决策与复盘」。弹窗展示当时依据、
反证、风险、有效期与明确关联的事后观察；没有显式观察链时会说明缺失，不按同股拼接。

- **填写反馈或备注**：Advice 可记录跟随、部分跟随或忽略；提醒可记录已处理、有用、无用或忽略。
  盈亏未知时留空，0 仅用于明确核对过的零盈亏。保存需要 `LUOOME_EXPOSE_WRITE=true`。
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

CLI 仍可用 `luoome advice outcome <adviceId> --followed true --pnl 80` 记录当前账户的明确反馈；
MCP 在开启 write 能力后可用 `record_advice_outcome` 或 `save_decision_review`。
这些反馈入口不会登记成交，成交类 tool 不通过 MCP 暴露。

旧版本没有账户归属的反馈仍留在历史数据中，不会自动分摊到当前账户。迁移只恢复可验证的旧成交与
Advice 显式关联，不据此生成采纳反馈；需要时由用户重新核对并记录。

### 9.2 看 confidence 校准

`get_confidence_calibration` 将当前账户的历史 Advice（包含已过期建议）按 confidence 分桶。
通用股票建议在本账户明确记录后才纳入账户样本。CLI 可显式指定账户：

```bash
luoome tools call get_confidence_calibration --input '{"accountId":"你的账户 ID"}'
```

每桶的 `total` 是建议数，`withOutcome` 是明确反馈数，`followedWithPnl` 是明确跟随且已填盈亏的样本数。
`hits` 只计算最后这组样本中盈利的条数；`hitRate = hits / followedWithPnl`，页面显示为「填报盈利占比」。
没有合格样本时显示未知，不用 0 代替。主观填报盈亏不做跨建议加总，`avgPnl` 等聚合盈亏字段保持未知。

这张表用于检查已填报样本与信心度之间的关系。样本量、未反馈记录和用户选择都会影响结果，
它不等于账户收益率，也不能把某个 confidence 桶理解为未来成功概率。
TUI 按 `[c]`，Web「复盘」页都可查看。

### 9.3 报告中的复盘与后补

账户收盘报告和周报会保存生成时使用的复盘修订与成交事实。收盘复盘生成后保持原始快照，
后补记录可在「决策与复盘」中查看，不再追加补充报告。报告列表每个日期和范围只显示最新的一份，
历史收盘报告的 V2/V3 编号不再显示，已有历史数据仍保留。

周报后来补录或修改后，可在最新报告详情中点「生成复盘补充版」，只根据已保存的本地事实
更新复盘章节，保留旧版本和其它报告内容。
旧报告尚未包含新版复盘时会明确提示。补充请求结果未确认时，用同一按钮重试，不会重复创建同一请求的版本。

复盘补充版显示「按策略不通知」，不会额外发送通知，后续定时任务与投递重试也不能改变这一策略。
正常主报告及原研究补充版仍遵循原有通知规则。生成复盘补充需要 write 能力，不要求开启外部调用。

`luoome daily-review [--since 7d]` 仍运行独立的 daily-review workflow，写报告到 `~/.luoome/reports/`。
执行步骤见 [workflows 包](../packages/workflows/src/daily-review.ts)。

---

## 10. 数据存储位置

| 路径 | 内容 |
|---|---|
| `~/.luoome/luoome.db` | SQLite 主库（账户 / 持仓 / 行情 / Strategy / Watchlist / AlertPlan / Advice） |
| `~/.luoome/reports/` | workflow 产物（日报 / 周报 / 诊断） |
| `~/.luoome/luoome.log` | （如果开启 `LUOOME_LOG=info`） |

覆盖路径：设置 `LUOOME_HOME=/path` 即可让 luoome 用别的根目录。

---

## 11. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUOOME_HOME` | `~/.luoome` | 数据根目录 |
| `LUOOME_HOST` | `127.0.0.1` | Web 监听地址；默认不暴露到局域网 |
| `LUOOME_MARKET_PROVIDER` | 必填 | 仅支持 `real`（Eastmoney → Tencent → Sina，仅 A 股） |
| `LUOOME_MARKET_SOURCES` | `eastmoney,tencent,sina` | 行情源顺序；可显式加入 `tushare`（需 `TUSHARE_TOKEN`）/ `fuyao`（需 `FUYAO_API_KEY`） |
| `LUOOME_STOCK_UNIVERSE_SOURCES` | `eastmoney,sina` | 股票目录源顺序；支持 `eastmoney,sina,tushare` |
| `LUOOME_RESEARCH_VAULT` | — | Obsidian Vault 绝对路径；推荐直接在 Web「研究」页配置 |
| `LUOOME_RESEARCH_ROOT` | `Research` | Vault 内参与扫描的相对目录；设为 `.` 可扫描整个 Vault |
| `LUOOME_RESEARCH_MANAGED_ROOT` | `Research/Luoome` | luoome 受管文件目录，必须是 research root 的子目录 |
| `LUOOME_RESEARCH_EMBEDDING_ENABLED` | `false` | 显式挂载 Research embedding 外部 capability；默认仍为本地 FTS5 |
| `LUOOME_RESEARCH_EMBEDDING_CONFIG` | `$LUOOME_HOME/research-embeddings.json` | embedding 模型目录路径；密钥由目录里的 `apiKeyEnv` 从环境读取 |
| `LUOOME_RESEARCH_REMOTE_SYNC` | `false` | `git` 启用独立安全拉取 workflow；不配置则完全不装配 |
| `LUOOME_EXPOSE_WRITE` | `false` | MCP 追加 write tool；Web 放行复盘、报告补充等本地写入端点 |
| `LUOOME_EXPOSE_EXTERNAL` | `false` | MCP 放行外部副作用；Web 放行白名单内 external tool（fetch_quote、盯盘 run-once 等） |
| `LUOOME_EXPOSE_TRADE` | `false`（**硬卡**） | `=true` 时启动即抛错退出 |
| `LUOOME_FEISHU_WEBHOOK_URL` | — | 飞书通知 webhook；也可在 Web 设置页配置，缺失降级为 log channel |
| `LUOOME_LOG` | info | `debug` / `info` / `warn` / `error` / `silent` |
| `LUOOME_PORT` | 5173 | Web 端口（与 `--port` 等价） |

只读路径（read + advice）永远默认全部放行；write / external / trade 必须显式 opt-in。

---

## 12. FAQ / 故障排查

### 12.1 `bun: command not found`

按官网安装 Bun 或用 `npx bun`。

### 12.2 Web 端打开是空白，console 报 `await is only valid in async functions`

检查 `apps/web/public/js/app.js` 与 `pages.js` 是否被浏览器当 ES module 解析——确认 `<script type="module">` 或 http 头 `content-type: text/javascript`。

### 12.3 TUI 报「需要交互式终端」

TUI 依赖 opentui 渲染器，必须在真 TTY 跑。CI / pipe / `nohup` 都会触发。请改用 `luoome web serve` 或 tool/workflow CLI 走文件输出。

### 12.4 Eastmoney / Tencent 失败 → 自动切 Sina 还是空？

`LUOOME_MARKET_PROVIDER=real` 按 `LUOOME_MARKET_SOURCES` 从左到右尝试已注册能力；默认顺序是
Eastmoney、Tencent、Sina。所有源都失败时明确返回行情源错误，不生成价格。Sina 当前只提供
沪深目录和 qfq 日线，不会伪装成实时快照或搜索来源；未覆盖的市场返回 not_supported。

### 12.5 luoome 侧找不到模型或 provider 密钥

模型推理与模型配置都由 DSH 承担，luoome 侧没有模型运行时、模型目录与模型设置页。
需要模型判断的任务由 DSH agent 通过 MCP 调用工具完成，密钥由 DSH 侧配置。

看板、持仓、策略、提醒、待确认草案与数据导入导出都不依赖模型，可直接使用。

### 12.6 `get_confidence_calibration` 没有盈利占比

先确认当前账户。只有该账户明确标记 followed 且填写盈亏的记录参与填报盈利占比；
没有这类样本时返回 null、页面显示未知。按实际情况补充反馈，尚未确认的盈亏保持留空。

### 12.7 切账户后持仓没变？

Web 端确认当前路由已 reload（页面状态行的「账户已切换」提示）。TUI 按 `[r]` 也可强制刷新。如果仍然没变，说明该账户本来就没持仓——用 `add_trade` 灌一笔。

### 12.8 Advice 看不到 / 全部过期

`validUntil` 已过：默认 `get_advice` 不返回过期 advice（`includeExpired=true` 可强行列）。内置 `analyze_stock` 工具已随 DSH 瘦身上下线，新建议由 DSH 交互分析（`luoome-analysis` 实例）经 `record_advice` 写入，不会自动重新生成。

### 12.9 如何卸载？

```bash
rm -rf ~/.luoome          # 删数据
brew uninstall luoome     # 卸载 brew 安装的 luoome
```

---

## 13. 更多阅读

### 13.1 配置模型

模型推理在 DSH 侧完成：先在 DSH Settings → Models 配置模型与密钥，DSH agent 再通过 MCP
调用 luoome 工具产出建议、简报与复盘。未配置模型时，历史事实、建议与只读面板仍可读取，
分析不会成功；不要把本机 API key 复制进部署配置。

luoome 侧不再保留模型目录、provider 密钥或模型设置页；Web 只负责看板、持仓、策略、提醒、
待确认草案与数据导入导出。

### 13.2 部署注意事项

- 部署应以 HTTPS 为首选。若公网入口只能使用已授权的明文 HTTP 回退，Pocket 密码与 DSH 会话仍然校验，
  但没有传输加密；不要在不可信网络上传输凭据。
- DSH 侧栏的五个面板与聊天读同一份数据：面板只做投影，不在浏览器重算数值。
- 嵌入式 DSH Chat（Node Host + 业务 Cordis 插件）已随托管形态下线，仓库里不再有这条路径。
- 默认部署已切纯插件：`dsh-web`（Node + DSH + dsh-luoome）与 `caddy` 两个服务，没有 MCP/Bun/
  worker/queue probe 进程；插件 profile 由 `deploy/dsh/profile-seed.mjs` 装配。安装、升级、
  一致性备份与回退步骤见 [7.7](#77-安装升级备份与回退宿主机直部署)。
- 旧 MCP 过渡形态源码保留但默认不启动；仓库完成隔离切换/回退演练后，生产服务器已于
  2026-10-25 切到纯插件形态（切换记录见服务器 `/opt/luoome/DEPLOYMENT.md`），旧 MCP/Bun
  源码尚未删除（P5）。
- 线上版本与升级结果保存在对应 release 的 `release-manifest.json`、`deployment-result.json`，
  升级与回退记录见服务器 `/opt/luoome/DEPLOYMENT.md`；升级保留既有自动任务开关与逐任务授权。

### 13.3 延伸阅读

- [文档导航](./README.md) — 产品需求、技术设计、运维手册与历史归档
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 模块 / 数据流 / advisor 模型
- [luoome 的 DSH 改造详细设计](./ddd/luoome-dsh-transformation-detailed-design.md) — 当前形态的契约、阶段与验收口径
- [luoome Skill](../skills/luoome/SKILL.md) — 外部 Agent 接入、工具编排与安全规则
- [AGENTS.md](../AGENTS.md) — 编码 Agent 仓库开发规范
- [ROADMAP.md](./ROADMAP.md) — 版本演进
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 贡献者指南
- [SECURITY.md](./SECURITY.md) — 副作用分级 + 单机入口鉴权与暴露面
- [BACKLOG.md](./BACKLOG.md) — 一致性 / 工程债清单
