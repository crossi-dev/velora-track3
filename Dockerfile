# syntax=docker.io/docker/dockerfile:1

# ---- Base ----
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl tzdata
ENV TZ=America/Argentina/Buenos_Aires

# ---- Deps ----
FROM base AS deps
# python3 make g++ are required to compile pprof (native module used by
# @google-cloud/profiler). They are safe to add to the builder layer only —
# they are NOT copied to the runner stage, so the final image stays lean.
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json* ./
COPY patches ./patches
COPY scripts ./scripts
COPY prisma ./prisma
RUN npm ci --ignore-scripts --legacy-peer-deps \
    && npx patch-package || true \
    && npm rebuild pprof || true

# ---- Builder ----
FROM base AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV SKIP_ENV_VALIDATION=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
# --webpack opts out of Turbopack for the production build. Next.js 16 defaults
# next build to Turbopack, which requires the @next/swc-linux-x64-gnu native
# binding. That binding is compiled for glibc ("gnu"), but this image uses
# node:22-alpine (musl). The libc6-compat shim only partially covers the glibc
# ABI — __register_atfork is missing intermittently, causing a flaky build
# failure: "Turbopack is not supported on this platform because native bindings
# are not available." Using webpack eliminates the native-binding dependency
# entirely and makes the build deterministic.
# Ref: https://nextjs.org/docs/app/guides/upgrading/version-16
RUN npx next build --webpack

# ---- Runner ----
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client

USER nextjs

EXPOSE 8080

CMD ["node", "server.js"]
