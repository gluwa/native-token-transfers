# syntax=docker/dockerfile:1.7

# Build stage — compile TS to JS, drop dev deps.
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund

COPY src ./src
RUN npm run build

RUN npm prune --omit=dev


# Runtime stage — minimal image, non-root user, healthcheck.
FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root user for least-privilege execution.
RUN addgroup -S quoter && adduser -S quoter -G quoter -h /app

COPY --from=builder --chown=quoter:quoter /app/node_modules ./node_modules
COPY --from=builder --chown=quoter:quoter /app/dist ./dist
COPY --from=builder --chown=quoter:quoter /app/package.json ./package.json

USER quoter

# Bind to all interfaces inside the container; the orchestrator (Azure Container
# Apps / AKS) handles network exposure. Override with QUOTER_HOST if needed.
ENV NODE_ENV=production \
    QUOTER_HOST=0.0.0.0 \
    QUOTER_PORT=3000

EXPOSE 3000

# Use node directly for the healthcheck so we don't need to install curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.QUOTER_PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

CMD ["node", "dist/index.js"]
