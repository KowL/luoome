#!/bin/sh
# luoome 一键安装脚本 —— 无需 git clone，curl 一条命令装好 luoome
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/KowL/luoome/main/install.sh | sh
#
# 可覆盖项（环境变量）：
#   LUOOME_REF      源码 ref（分支 / tag / commit），默认 main
#   LUOOME_HOME     数据与源码根目录，默认 ~/.luoome（源码放在 $LUOOME_HOME/src）
#
# 重复执行即升级到最新 $LUOOME_REF。
#
# 注意：luoome 已无独立 CLI，只以 DSH 插件安装（见 packages/dsh-luoome/README.md）。
# 本脚本只负责把源码与工作区依赖装好，不再生成任何命令入口。

set -eu

REPO="KowL/luoome"
REF="${LUOOME_REF:-main}"
LUOOME_HOME="${LUOOME_HOME:-$HOME/.luoome}"
SRC_DIR="$LUOOME_HOME/src"

log() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin | Linux) ;;
  *) fail "仅支持 macOS / Linux（Windows 请用 install.ps1：https://raw.githubusercontent.com/KowL/luoome/main/install.ps1，或走 WSL2）" ;;
esac
command -v curl >/dev/null 2>&1 || fail "需要 curl"
command -v tar >/dev/null 2>&1 || fail "需要 tar"

# 1. Bun：luoome 全程跑裸 Bun TS 解释 + bun:sqlite，Bun 是硬运行时依赖
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "$HOME/.bun/bin/bun" ]; then
    PATH="$HOME/.bun/bin:$PATH"
  else
    log "==> 未找到 bun，开始安装 Bun"
    curl -fsSL https://bun.sh/install | bash
    PATH="$HOME/.bun/bin:$PATH"
  fi
fi
export PATH
command -v bun >/dev/null 2>&1 || fail "Bun 安装失败，请手动安装：https://bun.sh"
log "==> Bun $(bun --version)"

# 2. 下载源码 tarball（codeload 支持分支 / tag / commit，不需要 git）
log "==> 下载 luoome 源码（$REPO @ $REF）"
mkdir -p "$LUOOME_HOME"
TARBALL="$LUOOME_HOME/.install-$$.tar.gz"
trap 'rm -f "$TARBALL"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$TARBALL" ||
  fail "源码下载失败，请检查 ref 是否存在：$REF"

rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR"
tar -xzf "$TARBALL" -C "$SRC_DIR" --strip-components=1
rm -f "$TARBALL"
trap - EXIT

# 3. 工作区依赖
log "==> 安装依赖（bun install --frozen-lockfile）"
(cd "$SRC_DIR" && bun install --frozen-lockfile)

# 4. 无独立 CLI：luoome 只以 DSH 插件安装
log ""
log "==> 源码与依赖已就绪（luoome 不再提供独立 CLI）"
log "    安装 DSH 插件：见 $SRC_DIR/packages/dsh-luoome/README.md"
log "    （在 DSH 中以本地目录安装该包，随后在「投资设置」里配置）"
log ""
log "源码：$SRC_DIR"
log "升级：重新执行本脚本即可；卸载：删除 $SRC_DIR"
