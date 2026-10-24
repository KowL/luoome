#!/bin/sh
# 独立 DSH 入口：先装配 profile，再启动对应运行器。
# 工作目录必须是 DSH 工作区——skill-filesystem 的项目根即 cwd 下的 .dsh/skills。
set -eu

ROLE="${1:-web}"
: "${DSH_HOME:=/var/lib/dsh}"
: "${DSH_WORKSPACE:=/workspace}"
export DSH_HOME DSH_WORKSPACE
cd "$DSH_WORKSPACE"

case "$ROLE" in
  web)
    bun --no-env-file /app/deploy/dsh/bootstrap.ts read
    exec dsh --profile luoome-web --no-open \
      --host "$DSH_BIND_HOST" \
      --port "$DSH_PORT" \
      --public-url "$DSH_PUBLIC_URL" \
      --trusted-host "$DSH_TRUSTED_HOST"
    ;;
  worker)
    bun --no-env-file /app/deploy/dsh/bootstrap.ts worker
    while :; do
      # 队列为空就不唤醒模型：每轮唤醒都是一次真实模型调用，空转是纯成本。
      if bun --no-env-file /app/deploy/dsh/queue-probe.ts >/dev/null 2>&1; then
        dsh --profile luoome-worker "$DSH_WORKER_PROMPT" || echo "dsh worker run failed"
      else
        probe_status=$?
        if [ "$probe_status" -eq 1 ]; then
          echo "queue empty, skip model wakeup"
        else
          echo "queue probe failed, defer model wakeup" >&2
        fi
      fi
      sleep "$DSH_WORKER_INTERVAL"
    done
    ;;
  *)
    echo "unknown dsh role: $ROLE" >&2
    exit 2
    ;;
esac
