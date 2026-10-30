## 这个 PR 做了什么

<!-- 一句话说清改动与动机；关联 issue / task 编号。 -->

## 检查清单

- [ ] `bun run typecheck` 通过
- [ ] `bun run test:all` 通过
- [ ] `bun run check:layers` 通过
- [ ] `bun run test:plugin-install` 通过（涉及插件 / host / 工具面时必跑）

## 测试数量与基线

- [ ] **测试数量变化必须重跑 `bun run test:baseline` 更新基线，不得手改常量**
      （`infra/test-baseline.json` 由脚本生成；手改等于让基线撒谎）
- [ ] **覆盖率差因 ≤ 2pp**（与基线 `coverage` 段比较；超过 2pp 需在本节说明原因与补偿计划）

基线对比（粘贴 `bun run test:baseline` 输出或 `git diff infra/test-baseline.json` 摘要）：

```text
# 例：segments.test.tests 3286 → 3301（+15），coverage.statements 85.19 → 85.31（+0.12pp）
```

## 行为与风险

- [ ] 写操作仍走精确 Operation policy（没有新增自动交易路径）
- [ ] 新增 / 修改的能力已在对应文档同步（ARCHITECTURE / USER_GUIDE / SECURITY）
- [ ] 涉及 UI 的改动已实际启动并用浏览器验证
