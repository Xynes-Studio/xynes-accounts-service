# =============================================================================
# xynes-accounts-service — multi-stage Dockerfile
# =============================================================================
#
# H-2: clones the H-1 pioneer recipe (see
# `xynes-infra/docs/plans/2026-05-13-mvp-release-stories/group-H-dockerfile-prod-targets.md`
# §"Landed implementation notes (2026-06-15)" for the deviation
# rationale).
#
# Stages
#   base  — pinned `oven/bun:1-alpine` by digest; shared install context.
#   dev   — bind-mount-friendly target for the local docker-compose dev
#           stack (already used by xynes-infra/docker-compose.dev.yml).
#   prod  — hardened runtime: non-root, no devDependencies, no test or
#           docs payload, no `.env*` files, HEALTHCHECK wired against
#           the H-2 /health route.
#
# Deviations from the canonical group-H skeleton (operator decision A,
# locked by H-1 — see AGENTS.md H-1 verification block):
#
#   1. Base image is `oven/bun:1-alpine`, NOT `oven/bun:1` (debian-slim).
#      Debian-slim lands the prod image at ~253 MB, blowing the
#      < 200 MB story budget. Alpine lands under 150 MB. Bun's binary is
#      statically linked, so musl libc (alpine) vs glibc (debian) is a
#      no-op for our workload. Digest pinned to the H-1 multi-arch
#      manifest digest so every H-* image picks up the same alpine
#      baseline + future bumps are coordinated.
#
#   2. No `build` stage. xynes-accounts-service runs `src/index.ts`
#      directly through Bun's TS support — there is no compile/bundle
#      step. The `prod` stage installs full deps (verifies `bun.lock`),
#      discards them, reinstalls `--production`, and copies the source
#      tree. The TypeScript correctness gate runs in CI (group-M
#      `ci.yml`), NOT inside the Dockerfile (H-1-FU-1 follow-up).
#
#   3. The healthcheck script uses Bun's built-in fetch instead of
#      `curl`, so the image needs no extra `apk add curl` layer (smaller
#      attack surface + smaller image).
# =============================================================================

# ====================================================
# base — pinned by manifest-list digest (H-1 lockstep)
# ====================================================
FROM oven/bun:1-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS base
WORKDIR /app
COPY package.json bun.lock ./

# ====================================================
# dev — bind-mounted source, hot reload
# ====================================================
FROM base AS dev
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 4203
CMD ["bun", "run", "dev"]

# ====================================================
# prod — hardened runtime
# ====================================================
FROM oven/bun:1-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS prod
WORKDIR /app

# Non-root user (gid/uid 1001 matches the canonical H-* recipe so
# Compose/K8s manifests can rely on a stable runtime UID). Alpine ships
# busybox's `addgroup`/`adduser`, not the debian `groupadd`/`useradd`.
RUN addgroup -S -g 1001 xynes && \
    adduser  -S -u 1001 -G xynes -H xynes

# Build-time: install full deps so dependency resolution is verified
# (catches a stale `bun.lock`), then discard them and reinstall
# production-only. Keeping it in one RUN means devDependencies never
# persist into the final image layers. Typecheck is enforced in CI
# (group-M); see deviation #2 above for rationale.
COPY package.json bun.lock tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle
RUN bun install --frozen-lockfile && \
    rm -rf node_modules && \
    bun install --production --frozen-lockfile && \
    rm -rf /root/.bun /tmp/* && \
    chown -R xynes:xynes /app

USER xynes
EXPOSE 4203

# Per HEALTHCHECK-CONTRACT.md §5 — start-period gives Bun ~15 s to load
# the Hono router + open the DB pool before the probe goes red.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD bun run healthcheck || exit 1

# Run Bun directly against the entrypoint. Env vars are passed in via
# Docker (`-e`, compose `environment:`, or K8s env), not via a file —
# the local-dev wrapper at `scripts/run-with-env.ts` is for the laptop
# stack only.
CMD ["bun", "run", "src/index.ts"]
