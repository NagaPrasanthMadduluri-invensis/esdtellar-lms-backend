# syntax=docker/dockerfile:1
# Multi-stage build for the NestJS API (and the background worker — same image,
# WORKER=1 picks the worker entrypoint, see src/main.ts).

# ---- builder: install all deps, typecheck + compile, prune to prod ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Toolchain, in case a transitive dep needs to compile a native addon.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
# `npm run build` is `tsc --noEmit && nest build`; nest-cli.json copies the
# migrations/*.sql into dist so the boot-time runner can apply them.
RUN npm run build

RUN npm prune --omit=dev

# ---- runtime: no toolchain, non-root --------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Local storage roots (SCORM packages, uploads). Mount volumes here in prod so
# they survive a redeploy; a single box can also just let them live in the image
# layer's writable space, but a volume is correct.
RUN mkdir -p storage/scorm storage/uploads && chown -R node:node storage

USER node
EXPOSE 3001
# API by default; the worker runs the SAME image with WORKER=1 (see compose).
CMD ["node", "dist/main"]
