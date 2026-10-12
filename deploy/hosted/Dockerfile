ARG BUN_IMAGE=oven/bun:1.3.14
FROM ${BUN_IMAGE} AS dependencies
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN bun --no-env-file install --frozen-lockfile --ignore-scripts
RUN bun --no-env-file run build

FROM ${BUN_IMAGE}
WORKDIR /app
COPY --from=dependencies /app /app
RUN mkdir -p /var/lib/luoome /var/lib/luoome-deletions /app/operator \
  && chown -R 1000:1000 /var/lib/luoome /var/lib/luoome-deletions /app/operator
USER 1000:1000
ENV LUOOME_MODE=hosted PORT=5173 LUOOME_HOST=0.0.0.0
EXPOSE 5173
CMD ["bun", "--no-env-file", "apps/web/src/index.ts"]
