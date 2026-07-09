# syntax=docker/dockerfile:1.7

# Build with the repo root as context so the workspace's tsconfigs can resolve their
# `extends: "../tsconfig.*.json"` paths:
#
#   docker build -f relayer-bot/Dockerfile -t ntt-relayer-bot:latest .
#
# One image serves all roles; supply the role via container args, e.g.
#   docker run ntt-relayer-bot:latest --role=worker

# Build stage — compile TS to dual CJS+ESM, drop dev deps.
FROM node:20-alpine AS builder
WORKDIR /app

# The workspace's tsconfigs extend the repo-root tsconfigs at `../tsconfig.*.json`.
COPY tsconfig.json tsconfig.cjs.json tsconfig.esm.json /
COPY relayer-bot/package.json relayer-bot/package-lock.json relayer-bot/tsconfig.cjs.json relayer-bot/tsconfig.esm.json ./
RUN npm ci --no-audit --no-fund

COPY relayer-bot/src ./src
RUN npm run build

RUN npm prune --omit=dev


# Runtime stage — minimal image, non-root user, healthcheck.
FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root user for least-privilege execution.
RUN addgroup -S relayer && adduser -S relayer -G relayer -h /app

COPY --from=builder --chown=relayer:relayer /app/node_modules ./node_modules
COPY --from=builder --chown=relayer:relayer /app/dist ./dist
COPY --from=builder --chown=relayer:relayer /app/package.json ./package.json
# Migrations ship in the image so the `--role=migrate` job (and self-healing startup
# migration) can run them.
COPY --chown=relayer:relayer relayer-bot/migrations ./migrations

USER relayer

# Bind the health server to all interfaces inside the container; the orchestrator
# (Azure Container Apps / AKS) handles network exposure.
ENV NODE_ENV=production \
    RELAYER_HEALTH_HOST=0.0.0.0 \
    RELAYER_HEALTH_PORT=8080

EXPOSE 8080

# Use node directly for the healthcheck so we don't need to install curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAYER_HEALTH_PORT||8080)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Role is supplied via container args, e.g. ["--role=worker"]. Defaults to worker.
ENTRYPOINT ["node", "dist/esm/bin.js"]
CMD ["--role=worker"]
