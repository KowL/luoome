# 个人订阅托管版隔离验收记录

日期：2026-10-11。范围为 H0～H5 的工程实现与 fixture 验证，H6 未实现。
没有连接真实用户、行情/邮件/支付账户，没有购买服务、提交、推送、创建 PR 或部署。
当前运行契约见[运维手册](../runbooks/hosted-personal-subscription.md)，阶段门禁见
[开发计划](../hosted-personal-subscription-development-plan.md)。

## 自动验证

最终 Vitest 2,319、Bun DB 615、Web 623 个测试通过，共 3,557 个；包含独占迁移的完整 DB/Web 回归。
`bun --no-env-file run typecheck` 与 `build` 通过；lint 无错误，仍有 82 条警告（包含既有及测试 non-null 断言）。
平台和 Tenant repository 同时以 memory/Drizzle 运行共享 contract tests。
验证入口包括 `apps/web/src/hosted-server.test.ts`、runtime/config/backup 测试、
`packages/db/src/hosted/*contract.test.ts`、maintenance 测试、platform/hosted Tools 与两个独立 workflow。

重要故障覆盖：

- 服务端绑定 Tenant、客户端身份/配额注入、Origin/CSRF、旧 generic/MCP/Agent 入口拒绝。
- 并发 OTP 只成功一次、会话撤销、无 Account provisioning、旧租户库迁移与句柄边界。
- 导入幂等/来源修订与原子额度、无账户事实摘要与反馈、不可信/缺失行情时间。
- Tenant commit 和平台 settle 后中断，以及真实子进程 `exit(17)` 后停止写者恢复；原报告/回执只提交一次。
- 旧 fence 不能提交、重试耗尽但旧领域 lease 仍忙时保留 held、unknown 成本不能伪造为 0。
- 暂停提醒前已建投递被抑制；通知次数包含实际重试；accepted 与 delivered 区分；unknown 查询无盲重发。
- 支付重复/乱序/晚到、退款和丢回调查单；冻结恢复查原订单一次，旧邮件查无受理后抑制且发送次数为 0。
- 导出私有/哈希/过期、删除跨进程排空、control PII 清理、旧备份恢复使用最新 tombstone。
- 备份覆盖 WAL 与 private 文件，活跃写者/篡改/符号链接/覆盖 live root 拒绝，恢复后旧登录失效。

## 实际浏览器

使用回环地址的隔离 HTTP fixture 包装器，仅为验证页面将 fixture Origin 映射到配置的固定 HTTPS Origin；
生产 Origin 的严格拒绝由 HTTP 集成测试验证。未绕过自签证书警告，未修改生产 CORS/CSRF 行为。
邮箱均为 `.invalid` 测试用户，行情和支付明确显示模拟状态。

| 场景 | 观察结果 |
|---|---|
| 登录、导入、生成摘要 | 两只股票原子导入；可读 partial 摘要显示来源、市场时间及事件/财报缺口 |
| 提醒 | 保存暂停、试跑不写正式边沿；展示数值/市场时点；显式启用/暂停入口可用 |
| 资料与订单 | 模拟续期不扣款；资料导出异步 ready；删除对话框要求同邮箱重新验证及确认文字，UI 验收取消删除 |
| 手机 | 390×844 下 document.scrollWidth=390，表格局部滚动，无整页横向溢出 |
| 桌面 | 1280×900 下 document.scrollWidth=1280，侧栏/双列成员与事实表格完整可读 |
| 断线恢复 | 服务停机时显示中文可恢复提示，重连后原数据仍可读 |
| 会话到期 | fixture 时钟推进超过 7 天 idle TTL 后，两个标签返回登录页 |
| 双标签/换用户 | 一处退出两处清空；第二用户两处均为 0 自选，旧用户/报告不在 DOM 中 |

截图与原始 load JSON 保存在本次聊天的本地 artifact 目录；用户侧可从聊天结果打开。
浏览器 viewport 验收后已恢复默认设置。

## 100 Tenant 压测与恢复

可复现命令（自动创建并清理独立临时数据库，无真实外部服务）：

```sh
bun --no-env-file apps/worker/src/fixture-load.ts --fixture /absolute/artifacts/hosted-fixture-load.json
```

模型：100 Tenant，每个 50 自选、10 条价格规则，30 并发读取、1 worker，runtime 上限 32。
机器：Darwin arm64，10 CPU，16 GiB，Bun 1.3.14。
最终隔离测量（02:18:15 UTC）：300 个 Job（100 初始化、100 条件评估、100 摘要），200 succeeded/100 partial，
partial 原因是明确未配置的事件/财报来源，held research units 为 0。
300 次读取 P50 180.02 ms、P95 280.08 ms、最大 284.53 ms；峰值 32 句柄，结束时 RSS 1,020.61 MiB。
一致备份 0.881 s，171,342,588 bytes；恢复 0.724 s，pendingReview 全 0、未对账回执 0。

该证据只代表此机器的 fixture 路径。行情/邮件/支付配额、真实网络耗时、容器存储、重度用户成本、
生产吞吐、长期内存稳定性及异机 RPO/RTO 尚未验证，JSON 中 `productionCapacityVerified=false`。

## 未通过的外部验收

供应商与数据许可、真实邮件受理/回执、支付沙箱、正式条款及版本化同意、生产容器/TLS/监控、
异机恢复/发布回退、真实用户成本与留存均待完成。Docker daemon 本轮未运行；Compose 配置解析通过
不能替代镜像构建或容器启动。注册默认关闭，不把本记录等同于 S13 对外开放验收。
