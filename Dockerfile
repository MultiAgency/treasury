# One payout executor with private dashboard/RPC and public invoice listeners; both share its grant.
# Secrets come from the host environment, never from this image.
FROM node:24-slim

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src

# The money lock, the ops log (.ops/) and the invoices' record (.invoices/) are written to the working
# directory: mount the executor's existing volume at /data. Preserve SQLite and its journals.
# Do not run another executor for this agent on a different host or volume.
WORKDIR /data
ENV NODE_ENV=production INVOICES_HOST=0.0.0.0 TRUST_PROXY=true
EXPOSE 8080
CMD ["/app/node_modules/.bin/tsx", "/app/src/invoices-server.ts"]
