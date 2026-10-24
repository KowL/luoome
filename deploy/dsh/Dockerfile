ARG BUN_IMAGE=oven/bun:1.3.14
ARG NODE_IMAGE=node:22.22.3-bookworm-slim
ARG DSH_VERSION=0.2.1-rc.2

FROM ${BUN_IMAGE} AS bun
FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY infra/dsh ./infra/dsh
RUN bun --no-env-file install --frozen-lockfile --ignore-scripts
RUN bun --no-env-file run build
RUN bun --no-env-file run build:dsh

FROM ${NODE_IMAGE}
ARG DSH_VERSION
WORKDIR /app
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN npm install --omit=dev --global @deepseek-ai/dsh@${DSH_VERSION}
COPY --from=dependencies /app /app
COPY .dsh /app/.dsh
COPY deploy/dsh /app/deploy/dsh
# 运行用户是 1000，构建上下文里的文件权限不统一（可执行位、只读位），
# 这里统一成「人人可读、入口脚本可执行」，否则容器会以 Permission denied 退出。
RUN chmod 755 /app/deploy/dsh/entrypoint.sh \
  && chmod -R a+rX /app \
  && mkdir -p /var/lib/dsh /var/lib/luoome /workspace \
  && chown -R 1000:1000 /var/lib/dsh /var/lib/luoome /workspace
USER 1000:1000
ENV DSH_HOME=/var/lib/dsh LUOOME_HOME=/var/lib/luoome DSH_WORKSPACE=/workspace
EXPOSE 3080
CMD ["deploy/dsh/entrypoint.sh", "web"]
