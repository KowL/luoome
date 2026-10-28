#!/usr/bin/env bash
# 插件升级：换 tarball → 重装 profile → 重启 → 探针验收 → 失败回滚。
#
# 这是宿主机直部署的发布路径：不构建镜像、不动 Caddy，
# 插件改动只需要重新装配 profile 并重启 DSH 进程。
set -euo pipefail

log() { printf '[upgrade] %s\n' "$*" >&2; }
fail() {
  printf '[upgrade] 错误：%s\n' "$*" >&2
  exit 1
}

SERVICE_USER="${SERVICE_USER:-luoome}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/luoome/dsh}"
DSH_HOME="${DSH_HOME:-${DEPLOY_ROOT}/home}"
LUOOME_HOME="${LUOOME_HOME:-${DEPLOY_ROOT}/luoome-home}"
PROFILE="${PROFILE:-luoome-web}"
SERVICE="${SERVICE:-luoome-dsh.service}"
PLUGIN_ARTIFACT="${1:-}"

[ "$(id -u)" -eq 0 ] || fail '需要 root 权限'
[ -n "${PLUGIN_ARTIFACT}" ] || fail '用法：upgrade.sh <dsh-luoome.tgz>'
[ -f "${PLUGIN_ARTIFACT}" ] || fail "找不到插件产物 ${PLUGIN_ARTIFACT}"

ENV_FILE="${DEPLOY_ROOT}/production.env"
[ -f "${ENV_FILE}" ] || fail "缺少 ${ENV_FILE}：先跑 install.sh"
# shellcheck disable=SC1090
set -a
. "${ENV_FILE}"
set +a
DSH_PORT="${DSH_PORT:-3080}"
PUBLIC_URL="${DSH_PUBLIC_URL:?production.env 缺少 DSH_PUBLIC_URL}"
GLOBAL_MODULES="$(npm root -g)"
PIN_FILE="${DSH_HOME}/dsh-pocket/token"
[ -f "${PIN_FILE}" ] || fail "缺少访问密码文件 ${PIN_FILE}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${DEPLOY_ROOT}/backups/${STAMP}"
mkdir -p "${BACKUP_DIR}"
sha256sum "${PLUGIN_ARTIFACT}" >"${BACKUP_DIR}/plugin.sha256"

# 备份：profile 原样留一份；事实库必须用 SQLite backup API 取在线一致性快照，
# 直接复制主文件会漏掉 WAL 里未合并的数据。快照压缩后落盘。
cp -a "${DSH_HOME}/profiles/${PROFILE}" "${BACKUP_DIR}/profile"
if [ -f "${LUOOME_HOME}/luoome.db" ]; then
  LUOOME_DB="${LUOOME_HOME}/luoome.db" BACKUP_DB="${BACKUP_DIR}/luoome.db" \
    node --input-type=module -e "
import { DatabaseSync, backup } from 'node:sqlite';
const db = new DatabaseSync(process.env.LUOOME_DB);
await backup(db, process.env.BACKUP_DB);
db.close();
"
  gzip -f "${BACKUP_DIR}/luoome.db"
fi
log "已备份到 ${BACKUP_DIR}"

rollback() {
  log "验收失败，回滚到 ${BACKUP_DIR}"
  systemctl stop "${SERVICE}" || true
  rm -rf "${DSH_HOME}/profiles/${PROFILE}"
  cp -a "${BACKUP_DIR}/profile" "${DSH_HOME}/profiles/${PROFILE}"
  if [ -f "${BACKUP_DIR}/luoome.db.gz" ]; then
    # 恢复前先清掉旧的 WAL/SHM：残留的 WAL 会盖掉刚恢复的库。
    rm -f "${LUOOME_HOME}/luoome.db-wal" "${LUOOME_HOME}/luoome.db-shm"
    gzip -dc "${BACKUP_DIR}/luoome.db.gz" >"${LUOOME_HOME}/luoome.db"
  fi
  systemctl start "${SERVICE}" || true
}

# 装配：tarball 就地重装 profile。运行中的进程仍持有旧文件，重启才切过去。
if ! node "${DEPLOY_ROOT}/deploy/profile-seed.mjs" \
  --plugin "${PLUGIN_ARTIFACT}" \
  --pocket "${GLOBAL_MODULES}/dsh-pocket" \
  --profile "${PROFILE}" \
  --home "${DSH_HOME}" \
  --modules "${GLOBAL_MODULES}"; then
  rollback
  fail 'profile 装配失败，已回滚'
fi

systemctl restart "${SERVICE}"

# 验收：先等监听，再跑完整的鉴权矩阵（401/403/200/101）。
for _ in $(seq 1 30); do
  if DSH_PORT="${DSH_PORT}" node "${DEPLOY_ROOT}/deploy/dsh-web-probe.mjs" --health >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! node "${DEPLOY_ROOT}/deploy/dsh-web-probe.mjs" "${PUBLIC_URL}" "${PIN_FILE}"; then
  rollback
  fail '探针验收失败，已回滚'
fi

log "升级完成：${PLUGIN_ARTIFACT}"
