# luoome v0.8.0 MVP 验收记录

验收日期：2026-07-23
范围：看板、持仓、分组、盯盘

## 结论

MVP 四条核心链路已连通，可从全新 `LUOOME_HOME` 启动、操作并持久化：

1. 看板读取持仓 PnL、建议、分组/池数量、watch 心跳和最近触发。
2. 持仓支持建仓、加仓、减仓、纠错、平仓，并显示近期交易流水。
3. 分组支持 manual / holdings / formula / llm 创建与编辑、启停、删除；动态分组可刷新并显示 stale。
4. 盯盘池可绑定分组、配置规则、启停、编辑、删除；手动试跑落触发审计但不发送通知。

## 自动化验证

```text
typecheck   PASS（packages/* + apps/*）
lint        PASS（Biome，294 files）
build       PASS（10 workspace entries）
vitest      PASS（88 files / 661 tests）
db contract PASS（memory + drizzle，155 tests）
web         PASS（26 tests）
```

关键新增契约：

- `list_trades`
- `list_watch_triggers`
- `WatchRun` memory / drizzle repository
- `record_watch_run`
- `get_watch_status`
- Web token bootstrap（0600 文件）
- loopback mutation 鉴权、跨站 Origin 拒绝
- 非 loopback 全 API 鉴权
- `notify=false` 试跑不占通知 cooldown

## 浏览器黄金路径

使用临时目录、测试专用 fake 行情和 Playwright CLI：

```text
LUOOME_HOME=/private/tmp/luoome-mvp-e2e
LUOOME_WEB_TOKEN=e2e-token
```

实际完成：

1. 首屏切换到默认模拟账户，看到 6 条持仓、总市值和 PnL。
2. 设置页保存服务端 token。
3. 创建 manual 分组 `core-watch`，成员 `002594.SZ / 600519.SH`。
4. 创建盯盘池 `core-price-watch`，绑定 `core-watch`，阈值 3%。
5. 点击“立即跑一轮”：评估 2 个池 / 6 只股票 / 5 条触发。
6. 验证最近 WatchRun 为 healthy，触发流水展示价格、原因、证据和通知状态。
7. 验证手动试跑 `notify=false`：通知计数为 0，触发标记为“仅记录”。
8. 浏览器控制台 0 error；桌面布局完成视觉检查。

## 启动验证

```bash
LUOOME_HOME=/private/tmp/luoome-start-e2e \
LUOOME_WEB_TOKEN=start-e2e-token \
./bin/luoome start --no-watch --port 5182
```

`GET /api/dashboard` 返回 200，默认分组 `holdings-default` 和默认池
`holdings-watch` 自动创建。`Ctrl+C` 后监听进程退出。

## 使用入口

```bash
# 完整 MVP：Web + 盘中长驻盯盘
luoome start

# 仅 Web
luoome web serve

# 仅跑一轮盯盘
luoome watch --once --no-notify
```

默认只监听 `127.0.0.1`。首次启动生成 `$LUOOME_HOME/web-token`，将文件内容粘贴到
Web「设置」页后即可执行 mutation。
