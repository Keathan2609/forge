# FORGE — multi-stage build producing one image per runtime.
#
# Structure and why:
#
#   deps      installs the full workspace once, with pnpm's store cached across builds
#   build     compiles every package and app once; all five runtimes share that output
#   <target>  a slim runtime stage that copies only what it needs
#
# Building each app from scratch would repeat the same dependency install and the same
# `@forge/engine` compile five times. Sharing the build stage means one compile, and the
# runtime stages stay small because they carry production dependencies only.
#
# Build a specific runtime:
#   docker build -f infra/docker/Dockerfile --target api -t forge-api .

# ---------------------------------------------------------------------------
# Base
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
# `libc6-compat` is required by Prisma's engine on Alpine; `tini` gives us a real PID 1
# so SIGTERM reaches the Node process and graceful shutdown actually runs.
RUN apk add --no-cache libc6-compat tini
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies — cached on the lockfile alone
# ---------------------------------------------------------------------------
FROM base AS deps

# Copy only the manifests first so a source-only change does not invalidate the
# dependency layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY apps/scheduler/package.json ./apps/scheduler/
COPY apps/cli/package.json ./apps/cli/
COPY packages/engine/package.json ./packages/engine/
COPY packages/contracts/package.json ./packages/contracts/
COPY packages/database/package.json ./packages/database/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/observability/package.json ./packages/observability/
COPY packages/config/package.json ./packages/config/
COPY packages/logger/package.json ./packages/logger/
COPY packages/transport/package.json ./packages/transport/
COPY packages/testing/package.json ./packages/testing/

# The Prisma schema is needed *during* install: `packages/database` generates its client
# from a postinstall hook (CONTRIBUTING.md explains why codegen is not part of `build`).
# Copying it here also means a schema change correctly invalidates the install layer, so
# the generated client can never be stale relative to the schema it was built from.
COPY packages/database/prisma ./packages/database/prisma

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Build — one compile shared by every runtime
# ---------------------------------------------------------------------------
FROM deps AS build
COPY . .

# No `prisma generate` here: the deps stage already ran it from the postinstall hook,
# and the schema was copied before that install — so the client is current by
# construction rather than by a second, easily-forgotten step.

# Turborepo resolves the dependency graph, so packages build before the apps that use them.
RUN pnpm turbo run build --filter=@forge/api --filter=@forge/worker --filter=@forge/scheduler --filter=@forge/cli

# The web build is separate: it needs the public API URL baked in at build time, and
# `standalone` output is opt-in (see apps/web/next.config.mjs).
ARG NEXT_PUBLIC_FORGE_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_FORGE_API_URL=$NEXT_PUBLIC_FORGE_API_URL
ENV NEXT_OUTPUT_STANDALONE=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @forge/web build

# Strip development dependencies so the runtime stages copy a lean node_modules.
# `CI=true` is scoped to this one command: without a TTY, pnpm refuses to purge the
# modules directory and asks for confirmation it can never receive. It is set inline
# rather than as a stage-wide ENV so it cannot quietly alter how anything else builds.
RUN CI=true pnpm prune --prod

# ---------------------------------------------------------------------------
# Migrator — runs `prisma migrate deploy` once, then exits
# ---------------------------------------------------------------------------
FROM base AS migrator
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/database ./packages/database
COPY --from=build /app/package.json ./package.json
WORKDIR /app/packages/database
# `migrate deploy` applies committed migrations and never generates new ones — the only
# form of migration that is safe to run automatically on startup.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["npx", "prisma", "migrate", "deploy"]

# ---------------------------------------------------------------------------
# Shared runtime scaffolding for the Node services
# ---------------------------------------------------------------------------
FROM base AS runtime-base
ENV NODE_ENV=production
# Never run as root. The node image already provides an unprivileged `node` user.
USER node
WORKDIR /app
ENTRYPOINT ["/sbin/tini", "--"]

# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
FROM runtime-base AS api
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]

# ---------------------------------------------------------------------------
# Worker
# ---------------------------------------------------------------------------
FROM runtime-base AS worker
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=node:node /app/apps/worker/package.json ./apps/worker/
EXPOSE 9101
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:9101/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
# SIGTERM starts the drain: in-flight tasks finish, then the process exits. Anything the
# grace period does not cover is recovered by lease expiry, so a hard kill is safe too.
STOPSIGNAL SIGTERM
CMD ["node", "apps/worker/dist/main.js"]

# ---------------------------------------------------------------------------
# Control plane
# ---------------------------------------------------------------------------
FROM runtime-base AS scheduler
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/scheduler/dist ./apps/scheduler/dist
COPY --from=build --chown=node:node /app/apps/scheduler/package.json ./apps/scheduler/
EXPOSE 9102
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:9102/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "apps/scheduler/dist/main.js"]

# ---------------------------------------------------------------------------
# Web console
# ---------------------------------------------------------------------------
FROM base AS web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
USER node
WORKDIR /app
# Next's standalone output already contains the traced subset of node_modules, so this
# image does not need the workspace install at all.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# No `public/` copy: the console has no static assets of its own. Its favicon is
# `src/app/icon.svg`, which the app router compiles into the build output above.
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------------------
# CLI — for `docker run forge-cli runs list`
# ---------------------------------------------------------------------------
FROM runtime-base AS cli
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps/cli/dist ./apps/cli/dist
COPY --from=build --chown=node:node /app/apps/cli/package.json ./apps/cli/
ENTRYPOINT ["/sbin/tini", "--", "node", "apps/cli/dist/bin.js"]
CMD ["--help"]
