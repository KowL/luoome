# dsh-luoome

luoome 的 DeepSeek DSH 插件，提供本地投资事实、策略研究、决策复盘、四个业务面板、DSH 内的投资设置与四条随包技能。运行期使用 Node SQLite，不需要 Bun、MCP server 或常驻分析 worker。

## 安装

要求 Node 22.22.3 或更新版本；已在 Node 24 验收。DSH SDK 固定为 `0.2.1-rc.2`。

在目标 DSH profile 目录安装：

```sh
npm install --save-exact dsh-luoome@0.2.3
```

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

## 使用

- 面板：看盘、持仓、关注、策略、复盘。看盘保留账户概览，持仓明细移至持仓页。看盘页在交易时段每 60 秒自动刷新一次，非交易时段停止轮询、等下一次开盘再恢复；标签页隐藏时不发请求，回到前台立即刷新一次；刷新失败保留最后一次成功画面并提示。策略页分为「结果总览」和「研究工作台」：总览优先显示已发布匹配标的、结果版本与事实日期，规则、诊断和持续运行可展开；最近尝试异常时仍标明正在展示的已发布结果。研究首次进入时加载，同策略切换视图保留草稿和试跑；未保存修改离开前可保存、放弃或继续编辑。「刷新结果」只更新结果，已保存研究修订独立读取。点击匹配股票可查看行情快照与策略依据，并直接开启个股分析对话。
- 关注：可手动新建、编辑、启停或归档列表，添加股票、调整阶段与优先级、移除手动关注；每次修改在面板提交后按冻结输入直接执行并返回 Operation 回执。也可点击「交给 AI 管理」生成当前列表的对话草稿，AI 写入按明确意图直接执行。其他来源有效时，移除手动关注会保留股票。
- 设置：打开 DSH「设置 → 投资设置」，可配置 FUYAO 服务地址与 API Key，并选择最多三个行情源的优先级。将 FUYAO 加入优先级后启用；保存立即生效，重启后保留，已配置的密钥留空则保留且不回显。配置保存在权限为 `0600` 的 `$LUOOME_HOME/.env`。此处也支持直接保存账户改名并查询操作回执。
- 技能：`strategy-lab`、`strategy-result-review`、`post-close-review`、`daily-market-analysis`。
- 策略发布后可按明确意图直接配置持续运行、暂停/恢复和 Watchlist 订阅。StrategySchedule 只决定到期，实际执行由 DSH 定时任务调用 `run_strategy_daily_cycle`；任务查重与精确授权分别执行。策略页显示调度、下次到期和订阅状态，管理入口只生成对话草稿，不自动执行；当前会话只读或草稿未被编辑器采用时会新建可编辑会话，不自动发送消息。
- 个人版写入不再要求人工审批：对话和面板按明确意图直接执行，仍保留 owner/账户绑定、能力白名单、输入冻结、幂等和 Operation 回执。复盘更新省略字段保留原值，显式 `null` 清除可空字段。
- 批处理和自动执行默认关闭。`LUOOME_BATCH_ENABLED=true` 允许直接执行五个批处理入口；`LUOOME_AUTOMATIONS_ENABLED=true` 还需精确任务授权。

策略试跑不等于回测，建议不等于交易。插件不提供自动下单；`LUOOME_EXPOSE_TRADE=true` 会拒绝启动。完整账户维护、其他供应商凭据配置、导入恢复和 external 市场事实持久化尚未全部迁入插件。

源码、部署及备份说明见 [luoome](https://github.com/KowL/luoome)。
