# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build

RUN corepack enable
WORKDIR /app

# Install with the lockfile first so dependency layers cache well.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY packages/agents/package.json packages/agents/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Runtime: production dependencies, bundles, config and the built web app.
FROM node:22-bookworm-slim AS runtime

# git is required for worktree isolation; ca-certificates for HTTPS model APIs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3080 \
    DATA_DIR=/data \
    WORKSPACES_DIR=/workspaces

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY packages/agents/package.json packages/agents/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY config ./config
COPY docker-entrypoint.sh /usr/local/bin/corpix-entrypoint.sh
COPY README.md LICENSE CREDITS.md ./
RUN chmod +x /usr/local/bin/corpix-entrypoint.sh

RUN mkdir -p /data /workspaces && groupadd -g 10001 corpix && useradd -u 10001 -g corpix -m corpix \
    && chown -R corpix:corpix /data /workspaces /app
USER corpix

EXPOSE 3080
VOLUME ["/data", "/workspaces"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/corpix-entrypoint.sh"]
CMD ["node", "dist/server.mjs"]
