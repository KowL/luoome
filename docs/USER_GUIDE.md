# luoome 用户手册

> 给**人**看的使用文档：本地安装、运行、自定义、复盘。如果你打算让外部 Agent 使用 luoome，请安装 [luoome Skill](../skills/luoome/SKILL.md)；想了解架构看 [ARCHITECTURE.md](./ARCHITECTURE.md)。

luoome 是一个**本地优先**的个人投资 advisor agent。它能：

- 在**终端（TUI）**盯盘、看今日建议
- 在**浏览器（Web）**管理 Strategy、Watchlist、AlertPlan 与复盘
- 作为 **MCP server** 把全部能力暴露给 Claude Desktop / OpenClaw 等 AI agent
- 通过**工作流**运行 Strategy、同步 Watchlist、盯盘与生成报告

但 luoome **不会**替你下单。所有建议都带 `decision / confidence / horizon / reasoning / risks / disclaimers / validUntil`，人最终拍板。

## 目录

1. [安装](#1-安装)
2. [第一次启动](#2-第一次启动)
3. [CLI 速查](#3-cli-速查)
4. [TUI 用法](#4-tui-用法)
5. [Web 用法](#5-web-用法)
6. [MCP 接入](#6-mcp-接入)
7. [多账户切换](#7-多账户切换)
8. [复盘与 confidence 校准](#8-复盘与-confidence-校准)
9. [数据存储位置](#9-数据存储位置)
10. [环境变量](#10-环境变量)
11. [FAQ / 故障排查](#11-faq--故障排查)

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
Web（严格默认，见 §10 环境变量）；然后打开 Web 进入「设置」创建第一个真实账户。

### 2.1 一键启动完整 MVP

```bash
luoome start
```

这会在 `127.0.0.1:5173` 启动 Web，并进入盘中盯盘长驻循环。首次启动还会：

- 创建 `~/.luoome/luoome.db`
- 创建默认「全部持仓」分组和「持仓监控」盯盘池

打开 `http://127.0.0.1:5173/`，即可在「设置」页执行持仓、分组和盯盘修改（前提是以 `LUOOME_EXPOSE_WRITE=true` 启动；行情同步等外部调用还需 `LUOOME_EXPOSE_EXTERNAL=true`）。只想开 Web 时使用 `luoome start --no-watch` 或 `luoome web serve`。

「预警」页的交易计划卡片直接展示生成时参考价及来源时间、入场区间、止损/止盈、当前与目标仓位、持有周期和复核时间。参考价是计划生成时的事实，不代表实时行情；缺失或过时数据会明确标注。详情展示数值触发条件、前置约束、反证和风险；内部计划版本标识、账户事实指纹及来源标识收在默认折叠的「查看追溯信息」中。计划不会自动下单。

计划卡片同时显示「可监控」或「未就绪」，并说明账户变化、有效期、草案等阻塞原因及下一步。卡片徽标是**监控资格**（可监控 / 未就绪 / 草案 / 已过期），记录状态（生效 / 草案 / 已替代 / 已撤销）只在详情与版本差异里看。列表默认按资格分组：全部（不含已过期）/ 可监控 / 待处理 / 已过期 / 历史状态，筛选项带计数，头部汇总 `N 个 · 可监控 … · 待处理 … · 已过期 …`；默认隐藏的已过期计划在每个筛选档里都能找回来。每个计划只展示一个当前版本，规则与服务端一致：最新的 `active` 版本就是当前版本，更新的草案只是「这次没发布」、不顶掉仍在监控的生效版本（会在行下提示未发布的草案版本），更新的已替代 / 已撤销 / 已过期状态则按历史记录展示。
「可监控」只表示计划具备监控资格，实际运行和送达仍以预警记录为准。多个入场条件必须全部满足，
风险或退出条件命中时优先提醒风险；人工确认和过期事实不会被当作满足。观察计划命中后先重新评估，
没有持仓时的风险提醒要求暂停入场，不是卖出指令。盘中提醒不等待 AI、不自动修改原计划，通知保留
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

页面包含看盘、持仓、Strategy、Watchlist、AlertPlan、研究、建议、报告、复盘、对话和设置。

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
| `luoome start [--port 5173] [--interval 60]` | 启动完整 MVP（Web + 长驻盯盘） |
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
| **看盘** | 市场概况、我的看板、今日预警与建议；展示行情异常（旧快照时间）、数据降级和列表覆盖范围。 |
| **持仓** | 建仓、加仓、减仓、纠错、平仓 + 近期交易流水。 |
| **Strategy** | 从模板创建、版本校验、发布、删除、自动调度、dry-run 与运行结果；设置页支持显式订阅/取消目标 Watchlist。 |
| **Watchlist** | 统计卡片 + 分组列表股票区（全部 / 单列表 tab）+ 今日变化 + 待研究 + 已归档弹窗；支持用逗号、空格或换行批量添加成员，以及成员 stage/priority 编辑与归档、列表编辑/归档、来源健康与关联 AlertPlan 联动。 |
| **AlertPlan** | 规则管理、手动试跑和 Trigger 审计；试跑不自动交易。 |
| **研究** | 配置本地 Obsidian Vault、同步索引、创建 Topic、导入本地正文或远程 URL。 |
| **建议** | 历史 + decision 过滤。 |
| **复盘** | 准确率统计 + **confidence 校准表** + outcome 回填。 |
| **对话** | AI SDK 流式助手；项目内持久化会话，工具执行轨迹可回看，写操作先生成确认草案。 |
| **设置** | 数据源 / AI / 账户，以及可按分类选择的本地 JSON 数据导出与合并导入。 |

个股详情不是侧栏 tab，从看盘、持仓、Watchlist、预警或顶栏搜索点击股票进入（深链接形如 `#market?stockId=002594.SZ&range=3m`）。打开后固定在顶部展示报价卡（名称与代码、价格与涨跌、今开 / 最高 / 最低 / 昨收、成交量额、换手与振幅、估值与股本），下方才是 K 线 / 分时图与关联事实。**打开详情或换股都会回到顶部报价卡**；只有切换区间（1M / 3M …）或粒度（日 K / 周 K / 分时）时保留当前滚动位置。切换左侧导航同样回到页面顶部，但页内自动刷新不会改变滚动位置。

### 5.3 顶栏与侧栏

顶栏（窄屏下两行）：左侧品牌，右侧依次是股票搜索、账户、时钟——搜索靠右与账户/时钟同簇，不居中。搜索支持代码与名称，候选可直接点击或 `↑`/`↓` + `Enter` 选中、`Esc` 清空；任意页面按 `⌘K`（Windows/Linux 为 `Ctrl K`）聚焦搜索，在非输入控件处按 `/` 也一样，输入框内不会抢键。时钟显示当前时间（窄屏去秒），鼠标悬停可看完整日期、时区与交易时段；时段徽标（交易中 / 午间休市 / 已收盘 / 盘前 / 非交易日）来自服务端 `get_market_data_status` 的交易时段，不在浏览器里重算交易日历，读取失败时仅隐藏徽标。主题皮肤入口在侧栏底部（窄屏时为导航条右侧的「◈ 主题」按钮），点击打开右侧皮肤抽屉。

切换顶栏账户会向 `POST /api/account/select` 发请求，后端更新当前默认账户，然后自动 reload 当前视图。localStorage 持久化（`luoome.accountId`）以便下次启动自动复原。

---

## 6. MCP 接入

`luoome mcp serve` 启动 stdio JSON-RPC server。配置参考 [luoome Skill 的 MCP 配置](../skills/luoome/references/mcp-setup.md)。默认暴露：

- **read** tools（list / search / get / compute）
- **advice** tools（个股、持仓和市场观点分析）

opt-in 追加：

- `LUOOME_EXPOSE_WRITE=true` → 追加账户、持仓、交易、研究、事件和反馈等 write tools
- `LUOOME_EXPOSE_EXTERNAL=true` → 追加行情、同步、刷新和通知等 external tools

`LUOOME_EXPOSE_TRADE=true` **永远硬卡**：MCP server 启动即抛错退出；advice × trade 隔离硬约束绝不通过 MCP 暴露。

---

## 7. 多账户切换

账户不再内置。首次启动在 Web「设置」页创建；也可调用
`create_account({ name, currency, initialCapital })`。所有账户均为 `kind: real`。

切账户后：

- **TUI**：持仓 / 建议全部按新账户重读。list_holdings 等读路径走 `ctx.user.defaultAccountId`。
- **Web**：账户下拉切换会触发 `/api/account/select`，然后 reload 当前路由。
- **MCP**：agent 通过 `add_trade({ accountId: '...' })` 显式选账户，缺省用当前 ctx 默认。

### 7.1 给新账户加仓（演示）

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

## 8. 复盘与 confidence 校准

luoome 的 advice 永远是「带答卷 + 等批改」的状态。复盘 = 把结果写回来，让系统慢慢变聪明。

### 8.1 回填 outcome

三种粒度，越准确越好：

1. **CLI**（推荐，prompt 一问一答）：
   ```bash
   luoome advice outcome <adviceId> --followed true --pnl 80
   ```
2. **Web**：去「复盘」tab 点「回填 outcome」按钮。
3. **agent / MCP**：`record_advice_outcome` 工具。

### 8.2 看 confidence 校准

`get_confidence_calibration` 把历史 advice 按 confidence 桶（0-9 / 10-19 / ... / 90-100）聚合 hitRate。

```bash
luoome tools call get_confidence_calibration --input '{}'
```

返回每桶的 `total / withOutcome / hits / hitRate / avgPnl / avgConfidence`。

读法（v0.5 W4）：

- **高信心桶 hitRate 高**：confidence 校准有效；
- **高信心桶 hitRate 低**：系统 confidence **可能高估**——该考虑收紧 prompt / 调整 calibration；
- **低信心桶 hitRate 高**：系统 **偏保守**——可以适当抬信心；
- **整体命中率（overallHitRate）**：长期跟踪的胜率近似。

> TUI 按 `[c]`，Web 去「复盘」tab 都能看到这张校准表。

### 8.3 日报 / 周报

`luoome daily-review [--since 7d]` 跑内置 daily-review workflow，写报告到 `~/.luoome/reports/`。可在 [workflows 包](../packages/workflows/src/daily-review.ts) 看到执行步骤。

---

## 9. 数据存储位置

| 路径 | 内容 |
|---|---|
| `~/.luoome/luoome.db` | SQLite 主库（账户 / 持仓 / 行情 / Strategy / Watchlist / AlertPlan / Advice） |
| `~/.luoome/reports/` | workflow 产物（日报 / 周报 / 诊断） |
| `~/.luoome/luoome.log` | （如果开启 `LUOOME_LOG=info`） |

覆盖路径：设置 `LUOOME_HOME=/path` 即可让 luoome 用别的根目录。

---

## 10. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LUOOME_HOME` | `~/.luoome` | 数据根目录 |
| `LUOOME_HOST` | `127.0.0.1` | Web 监听地址；默认不暴露到局域网 |
| `LUOOME_MARKET_PROVIDER` | 必填 | 仅支持 `real`（Eastmoney → Tencent → Sina，仅 A 股） |
| `LUOOME_MARKET_SOURCES` | `eastmoney,tencent,sina` | 行情源顺序；可显式加入 `tushare`（需 `TUSHARE_TOKEN`）/ `fuyao`（需 `FUYAO_API_KEY`） |
| `LUOOME_STOCK_UNIVERSE_SOURCES` | `eastmoney,sina` | 股票目录源顺序；支持 `eastmoney,sina,tushare` |
| `LUOOME_AI_CONFIG` | `$LUOOME_HOME/ai-models.json` | AI SDK 模型目录路径 |
| provider 密钥变量 | 由模型目录指定 | `apiKeyEnv` 引用的环境变量，密钥不写入目录 |
| `LUOOME_RESEARCH_VAULT` | — | Obsidian Vault 绝对路径；推荐直接在 Web「研究」页配置 |
| `LUOOME_RESEARCH_ROOT` | `Research` | Vault 内参与扫描的相对目录；设为 `.` 可扫描整个 Vault |
| `LUOOME_RESEARCH_MANAGED_ROOT` | `Research/Luoome` | luoome 受管文件目录，必须是 research root 的子目录 |
| `LUOOME_RESEARCH_EMBEDDING_ENABLED` | `false` | 显式挂载 Research embedding 外部 capability；默认仍为本地 FTS5 |
| `LUOOME_RESEARCH_EMBEDDING_CONFIG` | `$LUOOME_HOME/research-embeddings.json` | embedding 模型目录路径；密钥由目录里的 `apiKeyEnv` 从环境读取 |
| `LUOOME_RESEARCH_REMOTE_SYNC` | `false` | `git` 启用独立安全拉取 workflow；不配置则完全不装配 |
| `LUOOME_EXPOSE_WRITE` | `false` | MCP 追加 write tool；Web 放行 write tool 与 outcome 回填端点 |
| `LUOOME_EXPOSE_EXTERNAL` | `false` | MCP 放行外部副作用；Web 放行白名单内 external tool（fetch_quote、盯盘 run-once 等） |
| `LUOOME_EXPOSE_TRADE` | `false`（**硬卡**） | `=true` 时启动即抛错退出 |
| `LUOOME_FEISHU_WEBHOOK_URL` | — | 飞书通知 webhook；也可在 Web 设置页配置，缺失降级为 log channel |
| `LUOOME_LOG` | info | `debug` / `info` / `warn` / `error` / `silent` |
| `LUOOME_PORT` | 5173 | Web 端口（与 `--port` 等价） |

只读路径（read + advice）永远默认全部放行；write / external / trade 必须显式 opt-in。

---

## 11. FAQ / 故障排查

### 11.1 `bun: command not found`

按官网安装 Bun 或用 `npx bun`。

### 11.2 Web 端打开是空白，console 报 `await is only valid in async functions`

检查 `apps/web/public/js/app.js` 与 `pages.js` 是否被浏览器当 ES module 解析——确认 `<script type="module">` 或 http 头 `content-type: text/javascript`。

### 11.3 TUI 报「需要交互式终端」

TUI 依赖 opentui 渲染器，必须在真 TTY 跑。CI / pipe / `nohup` 都会触发。请改用 `luoome web serve` 或 tool/workflow CLI 走文件输出。

### 11.4 Eastmoney / Tencent 失败 → 自动切 Sina 还是空？

`LUOOME_MARKET_PROVIDER=real` 按 `LUOOME_MARKET_SOURCES` 从左到右尝试已注册能力；默认顺序是
Eastmoney、Tencent、Sina。所有源都失败时明确返回行情源错误，不生成价格。Sina 当前只提供
沪深目录和 qfq 日线，不会伪装成实时快照或搜索来源；未覆盖的市场返回 not_supported。

### 11.5 启动时报 AI 模型目录或 provider 密钥缺失

首次启动会自动生成 `$LUOOME_HOME/ai-models.json`，内置默认值与格式可参考仓库根目录的
`ai-models.example.json`；也可以设置 `LUOOME_AI_CONFIG` 指向自定义配置文件。再设置当前
profile 所用 provider 的 `apiKeyEnv` 引用的环境变量；显式配置的目录缺失、未知 provider
或缺密钥都会在需要 AI 的调用处明确报错；CLI/TUI/MCP 可先以配置模式启动并使用不依赖 AI 的
行情、账户和审计能力，不会用 mock LLM 冒充真实推理。

Web 设置页已内置 Kimi（`kimi-k3` / `MOONSHOT_API_KEY`）与 DeepSeek
（`deepseek-v4-pro` / `DEEPSEEK_API_KEY`）推荐值；切换 provider 后点击保存即可写入同一份
模型目录和本地密钥文件。

也可以启动 Web 后进入「设置 → LLM 设置」完成可视化配置。Web 在模型尚未配置或
配置损坏时会进入配置模式，不会阻止设置页启动；保存后配置立即生效。API Key 只写入
本地 `0600` 密钥文件，页面只显示“已配置”状态，不会读取或回显原值。

### 11.6 `get_confidence_calibration` 全 0 桶

历史 advice 还没回填 outcome。灌 5–10 条 outcome 就能看到形状：`luoome advice outcome <id> --followed true --pnl 100 --holding-hours 24`。

### 11.7 切账户后持仓没变？

Web 端确认当前路由已 reload（页面状态行的「账户已切换」提示）。TUI 按 `[r]` 也可强制刷新。如果仍然没变，说明该账户本来就没持仓——用 `add_trade` 灌一笔。

### 11.8 Advice 看不到 / 全部过期

`validUntil` 已过：默认 `get_advice` 不返回过期 advice（`includeExpired=true` 可强行列）。`analyze_stock` 会自动重新生成。

### 11.9 如何卸载？

```bash
rm -rf ~/.luoome          # 删数据
brew uninstall luoome     # 卸载 brew 安装的 luoome
```

---

## 12. 更多阅读

- [文档导航](./README.md) — 产品需求、技术设计、运维手册与历史归档
- [ARCHITECTURE.md](./ARCHITECTURE.md) — 模块 / 数据流 / advisor 模型
- [luoome Skill](../skills/luoome/SKILL.md) — 外部 Agent 接入、工具编排与安全规则
- [AGENTS.md](../AGENTS.md) — 编码 Agent 仓库开发规范
- [ROADMAP.md](./ROADMAP.md) — 版本演进
- [CONTRIBUTING.md](./CONTRIBUTING.md) — 贡献者指南
- [SECURITY.md](./SECURITY.md) — 副作用分级 + advice 安全
- [BACKLOG.md](./BACKLOG.md) — 一致性 / 工程债清单
