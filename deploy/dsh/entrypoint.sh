#!/bin/sh
# 纯插件默认部署入口：先把 dsh-luoome 插件（host + client + skills）装配进 DSH profile，
# 再用 Node 启动 DSH Web。运行期不启动 MCP 实例、Bun CLI、旧 Bun Web、analysis worker
# 或 queue probe；旧 MCP/Bun 入口只保留源码（P5 再删除），不在默认部署中调用。
#
# owner 与事实库由部署环境显式提供：缺少 owner 绑定、或 data 目录不可写时直接失败，
# 不回退默认账户/默认数据库。
set -eu

ROLE="${1:-web}"
: "${DSH_HOME:=/var/lib/dsh}"
: "${DSH_WORKSPACE:=/workspace}"
: "${DSH_PROFILE:=luoome-web}"
: "${LUOOME_OWNER_USER_ID:?set LUOOME_OWNER_USER_ID (trusted deployment owner)}"
: "${LUOOME_OWNER_ACCOUNT_ID:?set LUOOME_OWNER_ACCOUNT_ID (existing account id in the Node DB)}"
export DSH_HOME DSH_WORKSPACE

node /app/deploy/dsh/profile-seed.mjs \
  --plugin "${DSH_PLUGIN_ARTIFACT:-/app/plugin/dsh-luoome.tgz}" \
  --profile "$DSH_PROFILE"
cd "$DSH_WORKSPACE"

case "$ROLE" in
  web)
    exec dsh --profile "$DSH_PROFILE" --no-open \
      --host "$DSH_BIND_HOST" \
      --port "$DSH_PORT" \
      --public-url "$DSH_PUBLIC_URL" \
      --trusted-host "$DSH_TRUSTED_HOST"
    ;;
  # 只装配 profile 不启动服务：运维升级前检查/预热，或容器级 smoke。
  seed)
    echo "dsh-luoome profile seeded: $DSH_HOME/profiles/$DSH_PROFILE"
    ;;
  *)
    echo "unknown dsh role: $ROLE; default deployment only runs the pure-plugin web profile" >&2
    exit 2
    ;;
esac
