ARG BUN_IMAGE=oven/bun:1.3.14
ARG NODE_IMAGE=node:22.22.3-bookworm-slim
ARG DSH_VERSION=0.2.1-rc.2
ARG DSH_POCKET_VERSION=2.12.0

# 构建阶段：Bun 只负责构建/打包 dsh-luoome 插件（host + client + skills）。
# 运行阶段不再需要 Bun；DSH 与插件都跑在 Node 上。
FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY infra/dsh ./infra/dsh
RUN bun --no-env-file install --frozen-lockfile --ignore-scripts
RUN bun --no-env-file run build:dsh-luoome
RUN mkdir -p /out \
  && cd packages/dsh-luoome \
  && bun pm pack --destination /out

FROM ${NODE_IMAGE}
ARG DSH_VERSION
ARG DSH_POCKET_VERSION
WORKDIR /app
RUN npm install --omit=dev --global @deepseek-ai/dsh@${DSH_VERSION}
RUN npm install --omit=dev --ignore-scripts --global dsh-pocket@${DSH_POCKET_VERSION}
COPY deploy/dsh /app/deploy/dsh
RUN node /app/deploy/dsh/pocket-prefix.mjs /usr/local/lib/node_modules/dsh-pocket/lib/proxy.mjs
COPY --from=build /out/ /app/plugin/
# 固定产物名供 entrypoint 默认引用；构建产物里只有插件 tarball。
RUN mv /app/plugin/dsh-luoome-*.tgz /app/plugin/dsh-luoome.tgz
# 运行用户是 1000，构建上下文里的文件权限不统一（可执行位、只读位），
# 这里统一成「人人可读、入口脚本可执行」，否则容器会以 Permission denied 退出。
RUN chmod 755 /app/deploy/dsh/entrypoint.sh \
  && chmod -R a+rX /app \
  && mkdir -p /var/lib/dsh /var/lib/luoome /workspace \
  && chown -R 1000:1000 /var/lib/dsh /var/lib/luoome /workspace
USER 1000:1000
ENV DSH_HOME=/var/lib/dsh LUOOME_HOME=/var/lib/luoome DSH_WORKSPACE=/workspace
EXPOSE 3081
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 CMD ["node", "/app/deploy/dsh/dsh-web-probe.mjs", "--health"]
CMD ["deploy/dsh/entrypoint.sh", "web"]
