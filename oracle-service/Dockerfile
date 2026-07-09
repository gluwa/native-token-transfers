# syntax=docker/dockerfile:1.7

# Build with the repo root as context so the workspace's tsconfigs can resolve their
# `extends: "../tsconfig.*.json"` paths:
#
#   docker build -f oracle-service/Dockerfile -t ntt-oracle-service:latest .

# Build stage — compile TS to dual CJS+ESM, drop dev deps.
FROM node:20-alpine AS builder
WORKDIR /app

# The workspace's tsconfigs extend the repo-root tsconfigs at `../tsconfig.*.json`.
COPY tsconfig.json tsconfig.cjs.json tsconfig.esm.json /
COPY oracle-service/package.json oracle-service/package-lock.json oracle-service/tsconfig.cjs.json oracle-service/tsconfig.esm.json ./
# npm ci resolves from oracle-service/package-lock.json — a Docker-build-only lockfile
# (the repo's workspaces install from the ROOT lockfile). Keep them in sync when bumping
# deps: cd oracle-service && npm install --package-lock-only
RUN npm ci --no-audit --no-fund

COPY oracle-service/src ./src
RUN npm run build

RUN npm prune --omit=dev


# Runtime stage — minimal image, non-root user, heartbeat healthcheck.
FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root user for least-privilege execution.
RUN addgroup -S oracle && adduser -S oracle -G oracle -h /app

COPY --from=builder --chown=oracle:oracle /app/node_modules ./node_modules
COPY --from=builder --chown=oracle:oracle /app/dist ./dist
COPY --from=builder --chown=oracle:oracle /app/package.json ./package.json

USER oracle

ENV NODE_ENV=production \
    ORACLE_HEARTBEAT_FILE=/tmp/oracle-heartbeat

# Liveness via heartbeat file: the runner touches ORACLE_HEARTBEAT_FILE after every
# successful push. We treat the service as unhealthy if the file is missing or older
# than 3 push intervals plus one receipt-wait timeout (so one transient skipped cycle
# — including a tick spent waiting out a stuck transaction — doesn't flap the probe).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const fs=require('fs');const f=process.env.ORACLE_HEARTBEAT_FILE||'/tmp/oracle-heartbeat';const maxAge=3*Number(process.env.ORACLE_PUSH_INTERVAL_MS||60000)+Number(process.env.ORACLE_TX_WAIT_TIMEOUT_MS||120000);try{if(Date.now()-fs.statSync(f).mtimeMs>maxAge)process.exit(1)}catch{process.exit(1)}"

CMD ["node", "dist/esm/bin.js"]
