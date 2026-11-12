# The Treasury app server, with the app it serves (docs/deploy.md). One replica: its audit trail and stored
# requests are files on the volume at /data, each with one writer.
FROM node:24.22.0-slim AS build
WORKDIR /app
RUN npm install --global --allow-scripts=pnpm pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
COPY web/package.json web/
# pnpm links the SDK's approved agent skills (pnpm-workspace.yaml) into .claude/skills, and refuses to install without it.
RUN mkdir -p .claude/skills && pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @treasury/web build

FROM node:24.22.0-slim AS runtime
WORKDIR /app
RUN npm install --global --allow-scripts=pnpm pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/core/package.json packages/core/
COPY web/package.json web/
RUN mkdir -p .claude/skills && pnpm install --frozen-lockfile --prod --filter @treasury/server && npm uninstall --global pnpm && rm -rf .claude
COPY apps/server/src apps/server/src
COPY packages/core/src packages/core/src
COPY --from=build /app/web/dist web/dist
ENV NODE_ENV=production TREASURY_PAGE_DIR=/app/web/dist
# Root, as the platform's image runs: Railway mounts the volume owned by root. Every file the server writes is 0600.
WORKDIR /app/apps/server
CMD ["node", "src/start.ts"]
