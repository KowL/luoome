#!/usr/bin/env bash
# 宿主机直部署安装器：把 DSH 装到宿主机并交给 systemd 托管。
#
# 只负责安装面（Node、npm 全局包、pocket 补丁、profile、systemd 单元、配置骨架）。
# 数据迁移、启停和验收由运维分步执行：安装器不会接管正在跑的服务，
# 出错也不会把半成品推到线上。
set -euo pipefail

log() { printf '[install] %s\n' "$*" >&2; }
fail() {
  printf '[install] 错误：%s\n' "$*" >&2
  exit 1
}

NODE_VERSION="${NODE_VERSION:-22.22.3}"
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.2}"
DSH_POCKET_VERSION="${DSH_POCKET_VERSION:-2.12.0}"
SERVICE_USER="${SERVICE_USER:-luoome}"
SERVICE_HOME="${SERVICE_HOME:-/home/luoome}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/luoome/dsh}"
DSH_HOME="${DSH_HOME:-${DEPLOY_ROOT}/home}"
LUOOME_HOME="${LUOOME_HOME:-${DEPLOY_ROOT}/luoome-home}"
DSH_WORKSPACE="${DSH_WORKSPACE:-${DEPLOY_ROOT}/workspace}"
CADDY_ROOT="${CADDY_ROOT:-/opt/luoome/caddy}"
PROFILE="${PROFILE:-luoome-web}"
PLUGIN_ARTIFACT="${PLUGIN_ARTIFACT:-${DEPLOY_ROOT}/releases/dsh-luoome.tgz}"
PUBLIC_URL="${PUBLIC_URL:-http://134.175.83.56/dsh/}"
TRUSTED_HOST="${TRUSTED_HOST:-134.175.83.56}"
PUBLIC_IP="${PUBLIC_IP:-134.175.83.56}"
DSH_PORT="${DSH_PORT:-3080}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_DEPLOY_SOURCE="${DSH_DEPLOY_SOURCE:-$(cd "${SCRIPT_DIR}/../dsh" 2>/dev/null && pwd || true)}"

[ "$(id -u)" -eq 0 ] || fail '需要 root 权限'
[ -n "${DSH_DEPLOY_SOURCE}" ] && [ -d "${DSH_DEPLOY_SOURCE}" ] ||
  fail "找不到共享部署脚本目录（DSH_DEPLOY_SOURCE=${DSH_DEPLOY_SOURCE}）"

# --- Node：官方二进制，校验 SHA256 后铺到 /usr/local（与容器同布局）---
install_node() {
  if [ "$(node -v 2>/dev/null || true)" = "v${NODE_VERSION}" ]; then
    log "Node ${NODE_VERSION} 已就位"
    return
  fi
  local archive="node-v${NODE_VERSION}-linux-x64.tar.xz"
  local tmp
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "${tmp}/${archive}"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "${tmp}/SHASUMS256.txt"
  (cd "${tmp}" && grep " ${archive}\$" SHASUMS256.txt | sha256sum -c -) ||
    fail "Node 压缩包校验失败：${archive}"
  tar -xJf "${tmp}/${archive}" -C /usr/local --strip-components=1
  rm -rf "${tmp}"
  log "Node ${NODE_VERSION} 已安装到 /usr/local"
}

install_node

# --- 服务账号：系统账号，无登录 shell、无提权能力 ---
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --home-dir "${SERVICE_HOME}" --create-home \
    --shell /usr/sbin/nologin "${SERVICE_USER}"
  log "已创建服务账号 ${SERVICE_USER}"
else
  log "服务账号 ${SERVICE_USER} 已存在"
fi

# --- 目录：服务账号只写自己的数据面 ---
install -d -m 700 -o "${SERVICE_USER}" -g "${SERVICE_USER}" \
  "${DSH_HOME}" "${LUOOME_HOME}" "${DSH_WORKSPACE}" "${SERVICE_HOME}"
install -d -m 755 "${DEPLOY_ROOT}" "${DEPLOY_ROOT}/releases" "${DEPLOY_ROOT}/backups"
install -d -m 700 -o caddy -g caddy "${CADDY_ROOT}/data" "${CADDY_ROOT}/config"

# --- 部署脚本：仓库的 deploy/dsh 与本目录各拷一份到服务器 ---
install -m 644 "${DSH_DEPLOY_SOURCE}/pocket-prefix.mjs" "${DEPLOY_ROOT}/deploy/pocket-prefix.mjs"
install -m 644 "${DSH_DEPLOY_SOURCE}/profile-seed.mjs" "${DEPLOY_ROOT}/deploy/profile-seed.mjs"
install -m 644 "${DSH_DEPLOY_SOURCE}/dsh-web-probe.mjs" "${DEPLOY_ROOT}/deploy/dsh-web-probe.mjs"
install -m 644 "${SCRIPT_DIR}/Caddyfile" "${DEPLOY_ROOT}/Caddyfile"
install -m 644 "${SCRIPT_DIR}/luoome-dsh.service" /etc/systemd/system/luoome-dsh.service
install -m 644 "${SCRIPT_DIR}/luoome-caddy.service" /etc/systemd/system/luoome-caddy.service
# 安装器与升级脚本也留在服务器上：发布时不必再从仓库取。
install -m 755 "${SCRIPT_DIR}/install.sh" "${DEPLOY_ROOT}/deploy/install.sh"
install -m 755 "${SCRIPT_DIR}/upgrade.sh" "${DEPLOY_ROOT}/deploy/upgrade.sh"
log "部署文件已安装到 ${DEPLOY_ROOT}"

# --- npm 全局包 ---
npm install --omit=dev --global "@deepseek-ai/dsh@${DSH_VERSION}"
npm install --omit=dev --ignore-scripts --global "dsh-pocket@${DSH_POCKET_VERSION}"
GLOBAL_MODULES="$(npm root -g)"
log "全局模块目录 ${GLOBAL_MODULES}"

# --- pocket 补丁：/dsh/ 子路径 + 绑定地址可配（默认只绑 loopback）---
node "${DEPLOY_ROOT}/deploy/pocket-prefix.mjs" "${GLOBAL_MODULES}/dsh-pocket"
log "pocket 补丁已应用"

# --- profile 装配：插件 tarball 必须真实存在，不造假 ---
[ -f "${PLUGIN_ARTIFACT}" ] ||
  fail "缺少插件产物 ${PLUGIN_ARTIFACT}：先上传 dsh-luoome.tgz 再重跑"
node "${DEPLOY_ROOT}/deploy/profile-seed.mjs" \
  --plugin "${PLUGIN_ARTIFACT}" \
  --pocket "${GLOBAL_MODULES}/dsh-pocket" \
  --profile "${PROFILE}" \
  --home "${DSH_HOME}" \
  --modules "${GLOBAL_MODULES}"
log "profile ${PROFILE} 已装配到 ${DSH_HOME}/profiles/${PROFILE}"

# --- 配置骨架：已有值一律不覆盖，缺变量才补 ---
ENV_FILE="${DEPLOY_ROOT}/host.env"
touch "${ENV_FILE}"
chmod 640 "${ENV_FILE}"
chown root:"${SERVICE_USER}" "${ENV_FILE}"
ensure_env() {
  local key="$1" value="$2"
  if ! grep -q "^${key}=" "${ENV_FILE}"; then
    printf '%s=%s\n' "${key}" "${value}" >>"${ENV_FILE}"
    log "补齐 ${key}"
  fi
}
# owner 与事实库账户沿用既有部署；缺失就留给 DSH 启动时 fail closed。
if [ -f "${COMPOSE_ENV_FILE:-/opt/luoome/dsh/production.env}" ]; then
  for key in LUOOME_OWNER_USER_ID LUOOME_OWNER_ACCOUNT_ID LUOOME_MARKET_PROVIDER \
    LUOOME_STOCK_UNIVERSE_SOURCES LUOOME_BATCH_ENABLED LUOOME_AUTOMATIONS_ENABLED; do
    value="$(grep -m1 "^${key}=" "${COMPOSE_ENV_FILE}" | cut -d= -f2- || true)"
    [ -n "${value}" ] && ensure_env "${key}" "${value}"
  done
fi
ensure_env DSH_HOME "${DSH_HOME}"
ensure_env LUOOME_HOME "${LUOOME_HOME}"
ensure_env DSH_WORKSPACE "${DSH_WORKSPACE}"
ensure_env DSH_PROFILE "${PROFILE}"
ensure_env DSH_PORT "${DSH_PORT}"
ensure_env DSH_PUBLIC_URL "${PUBLIC_URL}"
ensure_env DSH_TRUSTED_HOST "${TRUSTED_HOST}"
ensure_env HOME "${SERVICE_HOME}"

# --- Caddy 只需要公网 IP：单独一份 env，旧的 basic auth 哈希不跟着进新服务 ---
CADDY_ENV_FILE="${DEPLOY_ROOT}/caddy.env"
printf 'DSH_PUBLIC_IP=%s\n' "${PUBLIC_IP}" >"${CADDY_ENV_FILE}"
chmod 640 "${CADDY_ENV_FILE}"
chown root:caddy "${CADDY_ENV_FILE}"

systemctl daemon-reload
log "安装完成。下一步："
log "  systemctl start luoome-dsh && systemctl start luoome-caddy"
log "  node ${DEPLOY_ROOT}/deploy/dsh-web-probe.mjs --health"
