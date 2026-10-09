# httpenv, TypeScript image (#31). Platforms: linux/amd64, linux/arm64, linux/arm/v7.
# The legacy Go image is Dockerfile.go (kept for the parity job until cutover, #34).
#
# Base image decision: docs/adr/0001-node-base-image.md
#   - explicit `bookworm` tag: `22-slim`/trixie and Node >= 24 have no arm/v7 image
#   - pinned by multi-arch index digest; Dependabot (#33) bumps it, and every bump
#     must keep all three platforms
# Every stage uses the same digest so the build and runtime Node versions never drift.

# ---------------------------------------------------------------------------
# deps + build: run on the build host's native platform ($BUILDPLATFORM).
# The compiled JavaScript is architecture independent, so `npm ci` and `tsc`
# never run under QEMU, and they run only once for all target platforms.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
WORKDIR /src
COPY package.json package-lock.json ./
# devDependencies are needed for `tsc`; none of them reach the runtime image.
# --ignore-scripts: no third-party install scripts run during the image build.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Output tree /out/app becomes the single application layer of the runtime image:
#   /app/dist/*.js      compiled sources (source maps dropped; stack traces still
#                       point at the JS files, which are readable 1:1 with src/)
#   /app/package.json   minimal: only `"type": "module"` matters at runtime, so
#                       node loads dist/*.js as ES modules without module-syntax
#                       detection (no double parse, no MODULE_TYPELESS warning).
#                       No dependencies, scripts or lockfile are shipped.
RUN npm run build \
    && find dist -name '*.map' -delete \
    && mkdir -p /out/app \
    && cp -R dist /out/app/dist \
    && node -e "const p = require('./package.json'); require('node:fs').writeFileSync('/out/app/package.json', JSON.stringify({ name: p.name, version: p.version, private: true, type: p.type }, null, 2) + '\n');"

# ---------------------------------------------------------------------------
# runtime: one per target platform. Only the compiled JS is added.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime

# One layer, three jobs:
# 1. Contract C1/P7 (docs/behaviour-contract.md): run as `httpenv`, UID/GID 1000,
#    HOME=/home/httpenv. The base image already owns UID/GID 1000 as `node`, so
#    rename that user and group instead of adding a second UID 1000.
# 2. Apply pending Debian security updates. The official image is rebuilt only
#    every few weeks, so it regularly ships fixable CRITICAL/HIGH CVEs (e.g.
#    perl-base on the pinned digest) that would fail the blocking Trivy gate.
#    DEBIAN_FRONTEND is set for this command only: an ENV line would leak into
#    the served JSON (contract C3).
# 3. Remove the package managers (npm, npx, corepack, yarn). The server needs
#    only the node binary, and their bundled dependencies carry fixable HIGH
#    CVEs. The files stay in the base layer (no pull-size saving) but are no
#    longer in the container filesystem, so they cannot be run or scanned.
#    NODE_VERSION/YARN_VERSION stay set by the base image (allowed, D9).
RUN groupmod -n httpenv node \
    && usermod -l httpenv -d /home/httpenv -m -s /usr/sbin/nologin node \
    && apt-get update --error-on=any \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/debconf/*-old /var/log/apt /var/log/dpkg.log \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-v* \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
# Owned by root and not writable by the app user.
COPY --from=build /out/app/ /app/

USER httpenv:httpenv
EXPOSE 8080

# No curl/wget in the slim image: probe with node itself. Exec form, so no shell
# and nothing is added to the server process's environment.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8080/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Contract C3 (no extra env keys): the base ENTRYPOINT is docker-entrypoint.sh, a
# shell script that would add SHLVL and PWD to the served environment. Reset it
# so node is PID 1 directly. The only keys the base adds are NODE_VERSION and
# YARN_VERSION (allowed, D9); do not add ENV lines here (e.g. NODE_ENV): every
# key would show up in the JSON response.
#
# Signals: node as PID 1 gets no default SIGTERM/SIGINT action from the kernel,
# so the app installs its own handlers (src/main.ts, #30; contract D3: graceful
# close, exit 0). No tini: the app spawns no children, so there are no zombies
# to reap. `docker run --init` remains available to operators.
ENTRYPOINT []
CMD ["node", "/app/dist/main.js"]
