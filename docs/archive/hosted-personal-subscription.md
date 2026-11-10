# 个人订阅服务运行与恢复

本手册当前入口为 `hosted-web-v2`：在原 Web 上接入登录、用户隔离、订阅和唯一默认投资账户。
Web 不再按 `LUOOME_MODE` 分流，所有启动入口均需要登录，生产注册默认关闭。
旧 `hosted-facts-v1` 只供历史测试，公开启动入口拒绝该策略。
v2 本轮实现与验证见[改造计划 §2.3](../hosted-personal-subscription-development-plan.md#23-本轮落地与验收记录)；
旧事实版工程证据见[历史验收记录](../archive/hosted-personal-subscription-fixture-acceptance.md)。
真实 SMTP 验证码已实现；实际投递、支付、完整业务调度及异机恢复仍须验收，不能据此开放收费。

## 1. 启动契约

所有命令从仓库根运行。服务进程和启动它的 Bun 父进程均必须禁用隐式 dotenv：

```sh
bun --no-env-file run web
bun --no-env-file run worker
```

Web 不启动本地 scheduler。worker 是独立进程，串行执行持久任务；首期每节点只运行一个 worker。
`luoome start`、`luoome web serve` 使用同一登录入口，不加载个人 `.env`。
CLI 在存在 `HOSTED_DATA_ROOT` 时拒绝打开单机业务库；单机工具继续使用自己的环境配置。

| 变量 | 约束 |
|---|---|
| `HOSTED_ENVIRONMENT` | `development` 或 `production` |
| `HOSTED_DATA_ROOT` | 专用绝对路径，不能使用个人本地数据目录 |
| `HOSTED_DELETION_LEDGER_ROOT` | 生产必填，必须在 data root 的真实路径之外，独立持久卷 |
| `PUBLIC_ORIGIN` | 通知链接默认 origin 及传输策略，不限制访问域名或端口；默认 HTTPS，无路径、用户信息或尾部 `/` |
| `HOSTED_ALLOW_INSECURE_HTTP` | 默认 `false`；临时 HTTP 功能验证时显式设为 `true` |
| `HOSTED_AUTH_SECRET_FILE` | 推荐 secret 文件；与 `HOSTED_AUTH_SECRET` 互斥，至少 32 字符，文件不超过 4 KiB |
| `HOSTED_PRODUCT_POLICY` | 默认且公开启动只接受 `hosted-web-v2`，无需设置 |
| `HOSTED_PROVIDER_MODE` | `fixture` 仅开发；生产必须 `configured` |
| `HOSTED_PLAN_FILE` | 内置装配必填，绝对 JSON 路径，符合 `PlanVersionSchema`；套餐由运营审核 |
| `HOSTED_ENTITLEMENT_REQUIRED` | 默认 `true`；未启用订阅收费的部署可显式 `false`，权益缺失/过期不再阻断业务写与后台任务 |
| `HOSTED_JOB_BUDGET_MICRO` | 内置装配必填，单任务成本预算，正整数微元 |
| `HOSTED_PROVIDERS_MODULE` | 可选可信运营代码的绝对路径；覆盖内置装配 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_FROM` | SMTP 主机、端口（默认 465）、单一发件邮箱 |
| `SMTP_USER` / `SMTP_PASSWORD_FILE` | 认证用户名和密码文件；密码文件不超过 4 KiB，与 `SMTP_PASSWORD` 互斥 |
| `SMTP_SECURE` | 默认按端口判定；465 使用 `true`，587 使用 `false` 并强制 STARTTLS，始终验证证书 |
| `HOSTED_AI_ENABLED` / `LUOOME_AI_CONFIG` | 默认关闭 AI；启用须显式提供绝对模型目录和对应密钥，不读取个人模型文件 |
| `LUOOME_EXPOSE_WRITE` / `LUOOME_EXPOSE_EXTERNAL` | 分别显式 `true`，否则相应能力关闭 |
| `LUOOME_EXPOSE_TRADE` | 禁止 `true`，启动硬拒绝 |
| `HOSTED_REGISTRATION_ENABLED` | 默认关闭；开放前必须完成 §7 |
| `HOSTED_REGISTRATION_LIMIT` | 默认 30，上限 100；用于首批邀请容量限制，不是邀请码系统 |
| `HOSTED_RUNTIME_LIMIT` | 每进程最多打开的 Tenant DB，默认 16，上限 100 |
| `HOSTED_TRUSTED_PROXY_IP` | 可选，单一明确 IP；只信任该连接地址传入的单值有效 X-Forwarded-For |
| `LUOOME_HOST` / `PORT` | Web 默认回环地址；Compose 内为 `0.0.0.0:5173`，不发布该端口 |

### 临时 HTTP 注册登录

暂不配置 TLS 时，可显式设置 `HOSTED_ALLOW_INSECURE_HTTP=true`，并将 `PUBLIC_ORIGIN` 设为
通知链接使用的 HTTP origin（含非默认端口）。Compose 默认仍由 `HOSTED_DOMAIN` 生成 HTTPS origin；
显式 `PUBLIC_ORIGIN` 会覆盖该默认值。HTTP 直连的端口映射由部署环境提供。
访问域名和端口无需逐一登记；浏览器请求的 Origin 必须与实际 Host（含端口）及配置的传输协议一致。
反向代理必须透传原始 Host（Nginx 使用 `$http_host` 保留端口）；不通过转发头接受任意来源。

该入口会明文传输验证码和会话，只用于临时功能验证，不满足 §7 的正式生产放行要求。
HTTP 使用独立 `luoome_http_session` Cookie，保留 HttpOnly、SameSite=Lax、同源 Origin、CSRF、
验证码限流与租户隔离；HTTPS 继续使用带 Secure 的 `__Host-luoome_session`，不接受 HTTP Cookie。
切换回 HTTPS 后须重新登录，并关闭 HTTP 开关及直连映射。

注册仍由 `HOSTED_REGISTRATION_ENABLED` 显式控制，并受 `HOSTED_REGISTRATION_LIMIT` 限制；
关闭注册不妨碍已有用户登录。验证码邮件必须由 SMTP 受理后才返回成功，结果未知或失败会提示重试。
页面提供 60 秒重发倒计时和 5 分钟有效期；首次邮箱验证自动创建 User/Tenant，worker 幂等初始化
唯一默认投资账户，初始化完成后进入原 Web。`GET /api/auth/config` 只公开邮件配置、注册与传输开关。
| `HOSTED_WORKER_INSTANCE_ID` | worker 健康文件标识，Compose 固定 `primary` |
| `HOSTED_TLS_CERT_FILE` / `HOSTED_TLS_KEY_FILE` | 可选本机 TLS，必须成对设置；生产由 Caddy 终止 TLS |

内置装配使用真实 SMTP、真实行情/股票目录 manager 和运营套餐，初始股票目录为空，不注入测试数据。
真实支付与研究通知邮件当前未装配，返回不可用；可选 providers 模块导出 `createHostedProviders(config)`
覆盖这些端口及任务价格/预算策略。生产装配拒绝 fixture provider、fake-market 与 fixture 套餐。
SMTP 未配置时仅允许注册关闭的预上线启动；`/health/ready` 返回 503，不能称为登录服务就绪。
SMTP 适配器只把最终成功回执记为 accepted；明确拒绝记 failed，可能已发送的超时/断线记 unknown，
不自动重发，不记录验证码或 SMTP 凭证。配置有效不等于已经验证邮箱送达。
v2 通过可选 `createTenantContext(base)` 补全租户专用的 LLM/Agent、行情 manager、Vault 和通知能力；
不得注入其他租户的数据库、共享私人缓存或可读取任意路径的 adapter。Web 始终重新绑定可信身份和仓储。
未装配能力返回不可用；fixture 的模拟 LLM 不代表真实 AI 服务已验收。
首次注册授予一次 7 天试用；套餐价格由服务器发布，浏览器不能传入价格、权益或额度。
模块是可信部署代码，禁止用户上传或通过产品设置修改。SMTP 的实际供应商和凭证由部署者提供。

目录结构：

```text
HOSTED_DATA_ROOT/
  control.sqlite                 身份、订阅、任务、计量、投递和支付元数据
  operator/
    plan.json                    套餐定义（部署提供）
    ai-settings.json             管理员 AI 配置（含密钥）
    market.env                   管理员行情数据源配置（含密钥）
  tenants/<opaque-tenant-id>/
    identity.json                owner、generation、schemaVersion
    luoome.db                    私人业务事实、输入、回执和 outbox
    vault/
    exports/
  worker-health-primary.json     worker 循环心跳
  restore-review.json            离线恢复检查报告
HOSTED_DELETION_LEDGER_ROOT/      不随业务备份回退的删除 tombstone
```

目录权限 `0700`，文件 `0600`；拒绝符号链接和不匹配的 manifest。控制库、业务库及 WAL/SHM
只能由同一受控用户访问；SQLite 必须位于单节点本地持久存储，不使用跨机共享文件系统。

## 2. 部署骨架

配置位于 [deploy/hosted](../../deploy/hosted/compose.yaml)。生产参考文件为
[production.env.example](../../deploy/hosted/production.env.example)，需由运营替换占位符、审核并固定镜像版本。
`operator/plan.json`、`secrets/hosted-auth-key` 与 `secrets/smtp-password` 由部署管理提供，均不进入 Git。
SMTP 尚未配置时提供空密码文件并保持 `SMTP_HOST` 为空。管理员可登录“管理 → AI 服务配置”，
填写 OpenAI 兼容 API 地址、模型、密钥、人民币 Token 费率和预算，并启用服务。
配置原子写入持久卷的 `operator/ai-settings.json`（目录 0700、文件 0600），包含密钥，不得复制到 Git 或日志。
管理员配置优先于环境 AI 开关；Web 和 worker 在新请求或任务上下文中读取，无需重启。运行中的调用保留原配置快照。
尚无管理员配置时保留环境装配：显式模型文件与凭据，仅支持既有 DeepSeek Flash 计量。
保存配置不会测试连接或自动调用模型。费用按管理员填写的费率和真实用量记录，不代表供应商账单；订阅会员配额不适用按 Token 的人民币费率。
供应商缺少缓存用量时，仅在缓存与普通输入同价时可结算；缺失必需用量仍保留 unknown。
管理员还可在“设置 → 数据源”调整全站行情源开关与排序并测试连通性；配置原子写入持久卷的
`operator/market.env`（0600），保存后立即重建共享行情栈，worker 按文件 mtime 同步，均无需重启。
该文件包含数据源密钥，不得复制到 Git 或日志。
股票目录（stock universe）不读 `operator/market.env`，仍由启动环境装配：默认 `LUOOME_STOCK_UNIVERSE_SOURCES=eastmoney,sina`，
可选 `tushare`（需在部署 env 提供 `TUSHARE_TOKEN`，可选 `TUSHARE_URL`）；生产如遇单一源不可达，按实际出口调整顺序。
全市场盘后数据准备受请求协调器限流：`LUOOME_MARKET_REQUESTS_PER_WINDOW`（默认 30/分钟/源）与
`LUOOME_MARKET_FAILURE_COOLDOWN_MS`（默认 60000）按出口与供应商配额调整；冷启动全市场缓存需要多轮周期逐步预热。
恢复集包含管理员 AI 配置与行情数据源配置文件，须按密钥文件保护。
应用进程为 UID/GID 1000，根文件系统只读、移除 Linux capabilities，只有 Caddy 发布 80/443。
80 端口用于 ACME HTTP 校验与 HTTPS 跳转，业务请求通过 443 反向代理；应用 5173 不对外发布。
真实 provider 的凭证由部署 secret 或管理员专属配置提供，不能写在 providers 源码中；普通用户无权查看或修改。

```sh
docker compose --env-file /absolute/operator/production.env -f deploy/hosted/compose.yaml config --quiet
docker compose --env-file /absolute/operator/production.env -f deploy/hosted/compose.yaml build
docker compose --env-file /absolute/operator/production.env -f deploy/hosted/compose.yaml up -d
```

宿主机 secret 文件须让容器 UID 1000 可读且其他用户不可读；文件 bind 的权限不会由 Compose
secret 的声明自动纠正。持久卷也须预先分配给 UID/GID 1000。不要通过放宽目录权限解决启动失败。
生产进入服务前验证真实 HTTPS、代理地址、网络出口、存储加密/备份权限和供应商限流。

## 3. 健康与日常对账

- `/health/live` 表示进程存活；`/health/ready` 在写屏障冻结/排空或 SMTP 未配置时返回 503，不包含私人内容。
- `worker-health-primary.json` 的循环心跳超过 120 秒或 `stopped=true` 判为不健康。
- 检查 pending/needs-review Job、held reservation、unknown provider cost、支付/退款积压、
  unknown 邮件和未完成删除；数据库本身不直接暴露为管理 HTTP API。
- 观察队列等待、租户轮转、SQLite 锁等待、DB 句柄、内存、上游失败与预算，不记录邮件正文或投资内容。
- 正常 worker 每 60 秒领取到期的原订单/退款查单机会；重复进程共享原子领取，不重新下单/申请退款。
- 邮件默认关闭、上海时间 22:00–08:00 安静时段。暂停/修改条件、退出成员、到期和退订会拦截待发送通知。
  渠道 `accepted` 仅表示受理，`delivered` 必须有可信回执；unknown 先查询，不能盲重发。

```sh
bun --no-env-file run ops status
```

status 只输出屏障状态和积压计数。真实支付及研究通知渠道尚未接入，生产未知成本的供应商账单取证、
告警接收渠道和定时异地备份仍需运营实现并演练。

## 4. 一致备份

Worker 收到 SIGTERM/SIGINT 后，盘后 Strategy 在工具边界停止启动业务步骤，日线批次不再启动
排队请求或重试。已开始的请求和原子 StrategyRun 会完成收尾；中断的日循环记录失败审计、释放
执行槽和调度租约，并保留原到期时间供后继 worker 补跑。已有正式结果按交易日去重，接管时补齐观察。
这不是强制终止网络请求：发布时仍需等待容器正常退出，不能把发送停止信号当作写者已排空。

运维命令仍需显式服务环境配置。备份可在进程存活时执行：共享 control 屏障先阻止新写、等待所有
Web/worker/provider 活动完成，再冻结并执行 `VACUUM INTO`。空闲 DB 句柄不算写活动，不能遗漏 WAL 内容。

```sh
bun --no-env-file run ops backup --destination /absolute/backups/new-recovery-set
```

目标必须是新的 data root 外目录。备份包含 control、全部 Tenant DB、manifest、vault 和导出文件；
每份文件记录大小、SHA-256、schema 与应用版本，文件及目录 fsync 后才写完成 manifest。
不直接复制活库的 SQLite 文件，不手动删除 WAL/SHM，不覆盖已有恢复集。
删除 ledger 独立保存并另做安全备份；恢复时需要其**最新**版本，不能随业务恢复集回退。
恢复集应由受控运营用户保存，哈希用于完整性检查，不是公开下载授权或签名。

备份失败且写者未排空时不会复制私人文件。普通失败解除自己持有的屏障；进程硬退出留下的活动不会
按超时/PID自动清除，按 §6 处理。异地加密副本、保留策略及生产 RPO/RTO 尚待演练确认。

## 5. 恢复、对账与恢复开放

先停 Web、worker、callback 入口及所有运营写进程，确认容器没有自动重启，再使用 `--writers-stopped`。
这个参数是运营对停写事实的显式断言，不会替你停止进程。

```sh
bun --no-env-file run ops restore --source /absolute/backups/recovery-set --destination /absolute/new-data-root --deletion-ledger /absolute/latest-deletion-ledger --writers-stopped
bun --no-env-file run ops status --data-root /absolute/new-data-root
bun --no-env-file run ops reconcile --data-root /absolute/new-data-root --deletion-ledger /absolute/latest-deletion-ledger --writers-stopped
```

只允许恢复到新目录；验证文件哈希、SQLite integrity、平台版本与 Tenant manifest。
恢复后保持 `restore:<backupId>` 屏障冻结：旧 challenge/session/CSRF 和执行 fence 撤销，
最新 tombstone 阻止已删除用户复活，旧导出失效，未发邮件抑制，发送中邮件转 unknown。
根据 Tenant receipt/outbox 收敛原额度和结果，不重新生成报告或通知。
运行中或已尝试的 Job 没有确切回执时保留 needs-review/held；不能把租约过期当作执行已停止。

供应商查询是独立的固定运维入口，需要 write/external 双 opt-in 和可信 configured providers：

```sh
bun --no-env-file run ops reconcile-external --data-root /absolute/new-data-root --writers-stopped
```

每轮有界查询原订单、退款和 unknown 邮件，保持冻结，不发信、不重新下单、不申请退款。
邮件得到确切“未受理”后也抑制旧通知；不支持幂等查询的 provider 不能用模糊的 not-found 解除 unknown。
仍 pending/unknown 的订单、退款、费用或无回执 Job 留待可信运营核对。
费用必须凭原 provider attempt 和供应商实际用量/账单通过平台 Tool 记账，禁止手改 SQLite 或猜成 0；
这种真实渠道取证、审查与结算流程在生产放行前必须完成供应商专项验收。

```sh
bun --no-env-file run ops resume --data-root /absolute/new-data-root --writers-stopped
```

只有同一恢复报告的 `unresolvedResults=0` 且全部 pendingReview 计数为 0，resume 才解除屏障。
恢复不会自动打开注册。将部署 data root 指向新目录后启动服务，验证旧 cookie 拒绝、新登录、
原结果、额度与删除事实，再完成真实邮件/支付验收。

## 6. 硬退出与发布回退

崩溃后“看不到原进程”不等于没有旧执行者。停止所有进程和自动重启，确认没有外部发送/成本请求
仍在执行，再显式恢复残留活动：

```sh
bun --no-env-file run ops recover-stopped-writers --deletion-ledger /absolute/latest-deletion-ledger --writers-stopped
```

该操作将当前库冻结为新的 restore owner、撤销旧凭证/fence，并按回执离线对账；随后仍需 §5 的
external reconciliation、审查和 resume。未查明的 provider 状态不能通过这个命令消除。

发布前保存匹配的应用镜像、配置、schema 和完整恢复集。优雅退出最多等待 120 秒；强制杀进程后走上述恢复。
租户首次打开的迁移受共享写活动与 runtime 存在登记保护，LRU 再打开不反复执行 DDL。
回退不直接用旧程序覆盖新 live DB；停写、恢复到新目录、应用最新删除 ledger、对账后运行与该 schema
兼容的固定镜像。未经迁移兼容验证不能降级 schemaVersion；保持注册关闭直到恢复验收完成。

## 7. 生产放行门禁

当前开发登录复选框是非绑定的 fixture 告知。正式条款、隐私/退款说明、版本化同意事实及投诉联系流程
尚未准备并接入，现有 `acceptTerms` 布尔值不能当作正式法律同意记录。
试用 7 天、到期 30 天历史可读窗口及资料保留政策也须在正式条款中确认。
当前 v2 原业务已限制到期后的写入/外部调用，30 天历史读取窗口尚未在全部原业务入口统一执行；
需同时验证窗口关闭后仍能访问订阅续费、导出与删除入口。

| 门禁 | 尚需的真实证据 |
|---|---|
| 数据与经营范围 | 获准的展示/缓存/派生/复用范围、实际报价、运营主体与产品范围审查 |
| 邮件 | 真实 OTP、通知受理/失败、unknown 查询及送达回执，不依赖 fixture |
| 支付 | 沙箱下单/重复回调/晚到/退款/unknown 全闭环、真实商户与服务器价格 |
| 部署 | 固定镜像构建运行、生产 TLS/secret/非 root 权限、监控与出口验证 |
| 恢复 | 异机恢复最新删除 ledger、未终态交易和成本取证、发布回退及真实 RPO/RTO |
| 邀请试运行 | 首批 20～30 人容量与供应商配额、成本/留存/退款证据 |

外部门禁未满足时保持注册关闭。原策略/AI/复盘入口已纳入 v2；完整定时业务队列、逐项额度计量、
个人通知到原业务投递链及真实 provider 仍须按改造计划验收。自动证券交易始终禁止。
