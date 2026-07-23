# typed: false
# frozen_string_literal: true

# Homebrew formula for luoome — 本地优先的个人投资 advisor agent
# (https://github.com/KowL/luoome).
#
# 用法（v0.8.0 默认从 git HEAD 构建，因为还没有稳定 release tarball）：
#
#   brew tap KowL/luoome
#   brew install luoome                       # 默认 HEAD
#   brew install --HEAD luoome                # 等价语义，显式指定 HEAD
#   brew install --branch <branch> luoome     # 装指定分支
#   LUOOME_MARKET_PROVIDER=real luoome tui
#
# tag 发布后会切到 stable 块（class LuoomeFormula < Formula + url + sha256）。

class Luoome < Formula
  desc "本地优先的个人投资 advisor agent（TUI / Web / MCP 三端）"
  homepage "https://github.com/KowL/luoome"
  url "https://github.com/KowL/luoome.git",
      using: GitProxy,
      branch: "main"           # 显式 branch 字段，避免 GH archive 默认 main 时漏 tag
  version "0.8.0"
  revision 1

  # v0.8.0 走 git build（HEAD 装当前 main）；待首个 release tag 后切到：
  #   url "https://github.com/KowL/luoome/archive/refs/tags/v0.8.0.tar.gz"
  #   sha256 "..."

  license "MIT"

  # 运行时依赖：Bun 必装；git 用于网络拉取（formula 默认装好）。
  depends_on "bun" => :build

  # 真实行情 + 真实 LLM 可能需要的可选依赖。
  # 备注式挂载，不强制：让用户按需补 `brew install python@3.11`。
  # depends_on "python@3.11" => :optional

  def install
    # Bun workspace monorepo：`bun install --production` 拉所有 workspace 依赖；
    # Homebrew 容器内没有 dev toolchain 也能安装。
    system "bun", "install", "--frozen-lockfile"

    # 不做 TS 编译：luoome 全程跑裸 Bun TS 解释（bin/luoome → packages/cli/src/index.ts），
    # 启动期由 Bun 即时编译。v0.6+ 计划出 bun build 单文件二进制。

    # 安装 bin shim 到 Homebrew bin 目录，调用 bun 跑本仓库的 cli 入口。
    # 注意：prefix 路径不能相对展开（Homebrew bottle 阶段会被 relocate）。
    libexec.install Dir["*"]
    (bin/"luoome").write <<~SH
      #!/bin/sh
      exec bun "#{libexec}/packages/cli/src/index.ts" "$@"
    SH
    (bin/"luoome").chmod 0755

    # 文档：README / AGENTS 在仓库根，其余全部文档（ARCHITECTURE / ROADMAP / USER_GUIDE 等）在 docs/。
    doc.install Dir["README.md"], Dir["AGENTS.md"]
    doc.install Dir["docs"] if Dir["docs"].any?
  end

  test do
    # smoke：跑 `luoome --help` 应该打印 COMMAND 列。
    output = shell_output("#{bin}/luoome --version 2>&1")
    assert_match(/0\.5\.\d+/, output, "luoome --version 应打印 0.5.x 版本号")

    # tools list 只读注册表，不初始化行情或 LLM。
    output = shell_output("#{bin}/luoome tools list 2>&1")
    assert_match(/list_accounts/, output, "luoome tools list 应包含 list_accounts")
    assert_match(/get_confidence_calibration/, output,
                 "luoome tools list 应包含 v0.5 W4 confidence 自校准 tool")
  end

  # homebrew-livecheck 钩子：HEAD build 不需要 stable check，但保留结构以备切 stable。
  livecheck do
    url :stable
    strategy :github_latest
  end
end
