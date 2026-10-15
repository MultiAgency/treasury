# Agentic Treasury gateway and isolated Treasury executors in one container.
# Secrets come from the host environment and the volume, never from this image.
FROM node:24-slim

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY evidence ./evidence
ARG PUBLIC_TREASURY_ONLY=true
RUN pnpm build:web
COPY deploy ./deploy

# All state lives on the volume mounted at /data (see deploy/dashboard-entrypoint.sh). One replica only:
# no other host may execute for the treasury agent.
ENV NODE_ENV=production DASHBOARD_FILE=/app/deploy/treasury.json TRUST_PROXY=true
EXPOSE 8080
CMD ["/app/deploy/dashboard-entrypoint.sh"]
