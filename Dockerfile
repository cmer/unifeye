# syntax=docker/dockerfile:1
# Build caches (apt downloads, the pnpm store, Next's compiler cache) live in BuildKit cache mounts:
# they survive between builds on the same machine but never end up in an image layer.
FROM node:24-bookworm-slim AS base
# The base image deletes apt downloads after every install; keep them for the cache mounts below.
RUN rm -f /etc/apt/apt.conf.d/docker-clean

FROM base AS deps
WORKDIR /app
# better-sqlite3 compiles from source when no prebuilt binary matches this Node version.
# The toolchain stays in the build stages; the run stage only gets the compiled module.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update && apt-get install -y --no-install-recommends python3 make g++
ENV COREPACK_HOME=/corepack
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
  corepack enable && pnpm install --frozen-lockfile --store-dir=/pnpm-store

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# .next/cache holds Turbopack's build cache, so an unchanged module is not compiled again.
RUN --mount=type=cache,id=next-cache,target=/app/.next/cache pnpm build

FROM base AS run
# FFmpeg probes and retimes recorded video for playback and clip exports (stream copy, plus
# audio analysis), resizes the low-resolution stretches of adaptive clips, and generates mock mode's
# simulated media. Live video is relayed by MediaMTX. The VAAPI drivers let that resize use an
# Intel (Quick Sync) or AMD GPU when the host passes one in; without one, FFmpeg uses the CPU.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates mesa-va-drivers \
    $([ "$(dpkg --print-architecture)" = amd64 ] && echo intel-media-va-driver)
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 HOOK_HOST=0.0.0.0 HOOK_PORT=3001 \
    DATABASE_PATH=/data/unifeye.sqlite BACKUP_DIR=/data/backups MEDIA_CACHE_DIR=/cache MIGRATIONS_DIR=/app/drizzle
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/dist/cli.mjs ./cli.mjs
# cli.mjs imports better-sqlite3 by name. The standalone output only links it under .next/node_modules,
# so expose the same traced copy at the top level for the CLI.
RUN ln -s "$(ls -d node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 | head -n1 | sed 's#^node_modules/##')" node_modules/better-sqlite3 \
  && node --input-type=module -e "import D from 'better-sqlite3'; new D(':memory:').close()"
RUN mkdir -p /data /cache && chown -R node:node /data /cache
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
