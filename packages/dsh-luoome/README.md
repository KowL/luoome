# dsh-luoome

luoome 的 DeepSeek DSH 插件，提供本地投资事实、策略研究、决策复盘、业务面板、DSH 内的投资设置与随包技能。运行期使用 Node SQLite，不需要 Bun、MCP server 或常驻分析 worker。

插件显式依赖 DSH 的 `llm`、`jobs` 等宿主服务，标准 profile 已提供；模型服务存在不代表已配置 provider 或启用自动任务。后台任务由插件持有控制，卸载时先取消并等待生产者收尾，再关闭事实库。

## 安装

要求 Node 22.22.3 或更新版本；已在 Node 24 验收。DSH SDK 固定为 `0.2.1-rc.2`。

在目标 DSH profile 目录安装已验收的插件 tarball（当前源码候选版本为 `0.2.5`）：

```sh
npm install --save-exact /absolute/path/to/dsh-luoome-0.2.5.tgz
```

公开 npm 版本与源码候选独立发布；安装公开版前用 `npm view dsh-luoome version` 核对版本，不将候选包当作已发布版本。

在该 profile 的 `cordis.patch.yml` 中加入插件，保留已有条目：

```yaml
- insert:
    - id: luoome-plugin
      name: dsh-luoome
```

启动 DSH 前设置：

```sh
export LUOOME_HOME=/absolute/path/to/luoome-home
export LUOOME_OWNER_USER_ID=local-owner
export LUOOME_OWNER_ACCOUNT_ID=existing-account-id
```

`LUOOME_HOME/luoome.db` 必须已有对应投资账户；插件不会创建示例账户。模型密钥使用 DSH 的现有模型配置，不填入插件参数。升级前请对业务库做 SQLite 一致性备份。

## 可选后台分析模型

普通队列分析默认不发模型请求。需要执行受信任 workflow 入队的后台分析时，在启动 DSH 前成对设置：

```sh
export LUOOME_ANALYSIS_PROVIDER=PROVIDER_ID
export LUOOME_ANALYSIS_MODEL=MODEL_ID
```

provider/model 必须已在 DSH 中配置；凭据继续由 DSH 管理。也可在插件部署参数中显式指定 `analysisModel: { provider, model }`，优先于环境变量。模型路由在启动时冻结，修改后重启 DSH。只配置其中一项或缺少宿主 `llm`/`jobs` 服务时，插件在打开事实库前启动失败。

此配置只接通内部后台执行器，不增加模型可见的队列生产者，也不扫描、自动领取旧的 pending 任务。每次执行使用领取时的同一事实快照和租约，通过现有完成工具写回 Advice 或 publication；模型无工具权限。单次模型请求限制输出 4096 token、15 分钟超时；截断、无效输出或已有 veto 均不计为完成。提交前收到宿主取消会撤销领域租约并阻止迟到写回，同时中止模型请求，等待资源收尾后保留取消输出。启用模型不等于启用自动任务，自动派发仍受批处理开关、档位和精确授权约束。

## 目标式研究长跑

通过 `stock-deep-dive` 技能按明确目标调用 `start_goal_run`，需要 write/external 能力和成本确认；在请求中显式指定 provider/model、目标、kind/subject、1–10 个 maxRounds、estimatedTokens 与 estimatedDurationMs。目标研究不依赖上节普通队列模型的环境变量，也不自动调度。每轮最多一次修订，最长执行 15 分钟；实际请求没有工具权限，不写 Advice、策略或成交。

用 `get_goal_run` 查看持久化尝试、快照 ID、factIds、dataAsOf、实际 tokenUsed（未报告时为 null）与 blockedCondition。output 非空且 needsRevision=false 的尝试才是该轮最终成果；轮次或预算耗尽不等于达成目标。`cancel_goal_run` 保留已产出证据并停止宿主任务，取消后的迟到提交被 CAS 屏障阻止。宿主任务结束表示执行器收尾，目标是否达成以目标记录的 status 为准。

本机目标审计保存在事实库；重启后可查询和取消遗留状态，不自动恢复或重放模型请求。需要继续研究时发起新的明确请求。

## 使用

- 面板：看盘、持仓、关注、策略、复盘。看盘保留账户概览，持仓明细移至持仓页。看盘页在交易时段每 60 秒自动刷新一次，非交易时段停止轮询、等下一次开盘再恢复；标签页隐藏时不发请求，回到前台立即刷新一次；刷新失败保留最后一次成功画面并提示。策略页分为「结果总览」和「研究工作台」：总览优先显示已发布匹配标的、结果版本与事实日期，规则、诊断和持续运行可展开；最近尝试异常时仍标明正在展示的已发布结果。研究首次进入时加载，同策略切换视图保留草稿和试跑；未保存修改离开前可保存、放弃或继续编辑。「刷新结果」只更新结果，已保存研究修订独立读取。点击匹配股票可查看行情快照与策略依据，并直接开启个股分析对话。
- 关注：可手动新建、编辑、启停或归档列表，添加股票、调整阶段与优先级、移除手动关注；每次修改在面板提交后按冻结输入直接执行并返回 Operation 回执。也可点击「交给 AI 管理」生成当前列表的对话草稿，AI 写入按明确意图直接执行。其他来源有效时，移除手动关注会保留股票。
- 设置：打开 DSH「设置 → 投资设置」，可配置 FUYAO 服务地址与 API Key，并选择最多三个行情源的优先级。将 FUYAO 加入优先级后启用；保存立即生效，重启后保留，已配置的密钥留空则保留且不回显。配置保存在权限为 `0600` 的 `$LUOOME_HOME/.env`。此处也支持直接保存账户改名并查询操作回执。
- 技能：`strategy-lab`、`strategy-result-review`、`post-close-review`、`daily-market-analysis`。
- 策略发布后可按明确意图直接配置持续运行、暂停/恢复和 Watchlist 订阅。StrategySchedule 只决定到期，实际执行由 DSH 定时任务调用 `run_strategy_daily_cycle`；任务查重与精确授权分别执行。策略页显示调度、下次到期和订阅状态，管理入口只生成对话草稿，不自动执行；当前会话只读或草稿未被编辑器采用时会新建可编辑会话，不自动发送消息。
- 个人版写入不再要求人工审批：对话和面板按明确意图直接执行，仍保留 owner/账户绑定、能力白名单、输入冻结、幂等和 Operation 回执。复盘更新省略字段保留原值，显式 `null` 清除可空字段。
- 批处理和自动执行默认关闭。`LUOOME_BATCH_ENABLED=true` 允许直接执行五个批处理入口；`LUOOME_AUTOMATIONS_ENABLED=true` 还需精确任务授权。

策略试跑不等于回测，建议不等于交易。插件不提供自动下单；`LUOOME_EXPOSE_TRADE=true` 会拒绝启动。分析队列默认不开放模型可见生产者，交互分析直接写回 Advice；可按上节显式配置普通后台执行器，手动/隔离 worker 路径继续保留。账户维护（改名、登记成交、平仓、入金/出金/分红/费用）已随持仓面板提供，写入走 Operation 冻结输入 + 业务回执；其他供应商凭据配置、导入恢复和 external 市场事实持久化尚未全部迁入插件。

源码、部署及备份说明见 [luoome](https://github.com/KowL/luoome)。
