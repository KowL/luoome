# DSH 插件构建与验收

当前默认部署是 Node 运行 DSH + dsh-luoome，包含 host/client、四个业务面板、DSH 内的投资设置与随包技能；不启动 MCP、Bun CLI 或常驻 worker。固定 SDK 依赖和解析图见 [artifacts.json](./artifacts.json) 与 [bun.lock](../../bun.lock)。

从仓库根目录运行：

```sh
bun --no-env-file run build:dsh-luoome
bun --no-env-file run test:plugin-install
bun --no-env-file run test:panels-browser
bun --no-env-file run test:mvp-journeys
bun --no-env-file infra/dsh/plugin-switch-acceptance.ts
```

安装验收在临时目录用 npm 安装 tarball 并启动独立 DSH；旅程脚本在真实 Node 24/SDK 中验证个人版零审批直接执行，使用脚本模型，不等同真实模型质量。浏览器验收使用本机 Chrome，`KEEP=1` 可保留截图和证据。切换验收使用合成数据库做备份、更新、旧实例关闭和回退，不操作生产服务器。

本机已有 Node 24 时，可设置 `NODE24_PATH` 为其可执行文件，安装与旅程验收会直接使用该运行时，避免重复解析 npm 的 Node 包。浏览器脚本可由这个 Node 24 直接运行，DSH 子进程复用相同运行时。

浏览器验收由 Node 24 运行 DSH 与测试反向代理，覆盖 `/dsh/` 公网挂载、完整会话连接、四个业务面板与 DSH 原生投资设置；使用合成 FUYAO 网关验证浏览器保存后下一次真实行情请求立即使用新地址和密钥，并验证重新打开与刷新后保留配置；另注入情绪失败，确认独立指数结果仍然显示。

这些脚本不读取真实个人库、不继承模型密钥。真实模型验收另在临时 DSH_HOME 中进行，密钥只进入子进程环境；验收记录见[插件详细设计](../../docs/ddd/dsh-luoome-plugin-detailed-design.md)。部署与手动任务授权步骤见[用户手册](../../docs/USER_GUIDE.md#7-dsh-单机用法)。

`build.ts` / `acceptance.ts` 及 dsh-bridge 的旧代理产物只保留给兼容开发验收，不是当前产品运行入口。旧托管 Host、网关模型代理与计费运行时已退役，历史设计见[归档](../../docs/archive/dsh-plugin-platform-development-plan.md)。
