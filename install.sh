#!/bin/sh
# luoome 一键安装脚本 —— 无需 git clone，curl 一条命令装好 luoome
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/KowL/luoome/main/install.sh | sh
#
# 可覆盖项（环境变量）：
#   LUOOME_REF      源码 ref（分支 / tag / commit），默认 main
#   LUOOME_HOME     数据与源码根目录，默认 ~/.luoome（源码放在 $LUOOME_HOME/src）
#   LUOOME_BIN_DIR  luoome 命令安装目录，默认 ~/.local/bin
#
# 重复执行即升级到最新 $LUOOME_REF。

set -eu

REPO="KowL/luoome"
REF="${LUOOME_REF:-main}"
LUOOME_HOME="${LUOOME_HOME:-$HOME/.luoome}"
SRC_DIR="$LUOOME_HOME/src"
BIN_DIR="${LUOOME_BIN_DIR:-$HOME/.local/bin}"

log() { printf '%s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin | Linux) ;;
  *) fail "仅支持 macOS / Linux（Windows 请走 WSL2）" ;;
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

# 4. luoome 命令 shim
mkdir -p "$BIN_DIR"
cat >"$BIN_DIR/luoome" <<EOF
#!/bin/sh
# luoome CLI 入口 —— Bun 直接跑 TS，无构建步骤
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "\$HOME/.bun/bin/bun" ]; then
    PATH="\$HOME/.bun/bin:\$PATH"
    export PATH
  else
    echo "error: 未找到 bun（期望 ~/.bun/bin/bun）" >&2
    exit 1
  fi
fi
exec bun "$SRC_DIR/packages/cli/src/index.ts" "\$@"
EOF
chmod +x "$BIN_DIR/luoome"

# 5. PATH 提示 + 验证
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    log ""
    log "注意：$BIN_DIR 不在 PATH 中，请将下面这行加入 ~/.zshrc 或 ~/.bashrc："
    log "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

log "==> 验证安装"
"$BIN_DIR/luoome" --version >/dev/null 2>&1 ||
  fail "luoome 安装后无法运行，请查看上方输出"

log ""
log "安装完成："
log "  源码：$SRC_DIR"
log "  命令：$BIN_DIR/luoome"
log ""
log "下一步："
log "  luoome start        # 启动 Web + 长驻盯盘（浏览器打开 http://127.0.0.1:5173）"
log "  luoome --help       # 查看全部命令"
log ""
log "升级：重新执行本脚本即可；卸载：删除 $SRC_DIR 与 $BIN_DIR/luoome"
