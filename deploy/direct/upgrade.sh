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

# 备份保留策略（task-36）：
# - 默认留最近 5 份；`LUOOME_BACKUP_KEEP` 可覆盖，**必须是正整数**。
# - 候选集用**白名单**：目录名必须匹配 `^[0-9]{8}T[0-9]{6}Z$` 才进候选，
#   于是 `pre-*` / `retention-*` / `workspace.json.*` 这些手工产物天然不会被碰到。
# - **KEEP=0 / 负数 / 非数字一律 fail**：一个笔误就能把全部回滚能力删光。
BACKUP_ROOT="${DEPLOY_ROOT}/backups"
BACKUP_STAMP_PATTERN='^[0-9]{8}T[0-9]{6}Z$'
# 单份备份的保守估算（实测 460-464M，取 900M 留余量）；预检要求 ≥ 2 份空间。
BACKUP_ESTIMATE_MB="${LUOOME_BACKUP_ESTIMATE_MB:-900}"
REQUIRED_FREE_MB="$((BACKUP_ESTIMATE_MB * 2))"

require_positive_keep() {
  local raw="${LUOOME_BACKUP_KEEP:-5}"
  case "${raw}" in
    '' | *[!0-9]*) fail "LUOOME_BACKUP_KEEP 必须是正整数（当前：'${raw}'）；拒绝继续，避免误清空备份" ;;
  esac
  [ "${raw}" -gt 0 ] || fail "LUOOME_BACKUP_KEEP 必须 ≥ 1（当前：${raw}）；拒绝继续，避免误清空备份"
  printf '%s' "${raw}"
}

# 部署**写任何东西之前**先看磁盘：写一半满盘会留下半成品 profile 与半截 db，
# 比不部署更糟（回滚也要读这些文件）。
require_disk_space() {
  local available_mb
  available_mb="$(df -Pm "${DEPLOY_ROOT}" | awk 'NR==2 {print $4}')"
  [ -n "${available_mb}" ] || fail "无法读取 ${DEPLOY_ROOT} 的可用空间"
  if [ "${available_mb}" -lt "${REQUIRED_FREE_MB}" ]; then
    fail "可用空间不足：剩余 ${available_mb}M，需要至少 ${REQUIRED_FREE_MB}M（单份备份约 ${BACKUP_ESTIMATE_MB}M）。先清理 ${BACKUP_ROOT} 再重试"
  fi
}

# 只删**匹配时间戳白名单**的目录，且永远保留最近 keep 份（按名字倒序 = 时间倒序）。
# 删之前把清单打到 stderr，便于事后追溯。
prune_backups() {
  local keep="$1"
  [ -d "${BACKUP_ROOT}" ] || return 0
  local candidates=()
  local entry
  for entry in "${BACKUP_ROOT}"/*; do
    [ -d "${entry}" ] || continue
    [[ "$(basename "${entry}")" =~ ${BACKUP_STAMP_PATTERN} ]] || continue
    candidates+=("$(basename "${entry}")")
  done
  [ "${#candidates[@]}" -eq 0 ] && return 0
  # 时间戳格式可按字典序排序，所以排序即按时间。
  # 不用 `mapfile`：macOS 自带 bash 3.2 没有它，而这份脚本也要能在开发机上被测。
  local sorted index=0 name
  sorted="$(printf '%s\n' "${candidates[@]}" | sort -r)"
  while IFS= read -r name; do
    [ -n "${name}" ] || continue
    index=$((index + 1))
    [ "${index}" -le "${keep}" ] && continue
    log "清理旧备份：${name}（保留最近 ${keep} 份）"
    rm -rf -- "${BACKUP_ROOT}/${name}"
  done <<<"${sorted}"
}

KEEP_BACKUPS="$(require_positive_keep)"
require_disk_space

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_ROOT}/${STAMP}"
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

# 清理**只在部署成功后**执行：失败回滚时那份备份是唯一的回退依据，绝不能删。
# 候选集白名单见 `prune_backups`；手工备份（`pre-*` 等）永不在候选里。
prune_backups "${KEEP_BACKUPS}"

log "升级完成：${PLUGIN_ARTIFACT}"
log "备份保留：最近 ${KEEP_BACKUPS} 份（${BACKUP_ROOT}；可用 LUOOME_BACKUP_KEEP 调整）"
