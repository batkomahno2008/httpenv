# ADR 0001: Node.js version and base image for linux/arm/v7

- Status: Accepted (Tech Lead), 2026-10-09
- Issue: batkomahno2008/httpenv#18 (master: batkomahno2008/httpenv#41)
- Consumers: batkomahno2008/httpenv#29 (TS scaffold, `engines`),
  batkomahno2008/httpenv#31 (multi-arch Dockerfile),
  batkomahno2008/httpenv#27 (arm64/arm-v7 job), batkomahno2008/httpenv#32 (Node CI),
  batkomahno2008/httpenv#33 (Dependabot)

## Decision

| Item | Decision |
|---|---|
| Node.js line | **Node.js 22 "Jod" (Maintenance LTS, EOL 2027-04-30)** |
| `package.json` `engines` | `"node": ">=22.12.0 <23"` |
| Base image, all platforms | **`node:22-bookworm-slim`**, pinned by index digest in the Dockerfile |
| Digest at decision time | `sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392` (Node v22.23.3, Debian 12.15) |
| Platforms | `linux/amd64`, `linux/arm64`, `linux/arm/v7` (one multi-arch tag, one Dockerfile) |
| Size budget | see [Size budget](#size-budget) |

Per platform, the same tag resolves to:

| Platform | Image | Node binary source |
|---|---|---|
| linux/amd64 | `node:22-bookworm-slim` | official `linux-x64` release (Tier 1) |
| linux/arm64 | `node:22-bookworm-slim` | official `linux-arm64` release (Tier 1) |
| linux/arm/v7 | `node:22-bookworm-slim` | official `linux-armv7l` release (Tier 1 for v22) |

Rules for implementers:

1. Use the explicit Debian codename tag `22-bookworm-slim`, **not** `22-slim`.
   Today `22-slim` resolves to the same digest, but `22-trixie-slim` has **no**
   arm/v7 manifest. If the upstream default moves to trixie, `22-slim` would
   quietly lose arm/v7.
2. Pin by digest (`node:22-bookworm-slim@sha256:...`). Dependabot's `docker`
   ecosystem (#33) bumps it. Every bump must keep all three platforms; #31/#27
   must fail if a platform is missing.
3. Compile TypeScript in a build stage running on
   `FROM --platform=$BUILDPLATFORM`. The JS output does not depend on the
   architecture, so `tsc` never runs under QEMU. Only the runtime stage is
   per-platform.
4. The base image already has user `node` with UID/GID 1000. To keep the
   `httpenv` UID/GID 1000 contract (#19), rename or replace that user (for
   example `groupmod -n httpenv node && usermod -l httpenv -d /home/httpenv -m node`).
   Do not add a second UID 1000.
5. Do not ship `node_modules` in the runtime image. There are zero runtime
   dependencies.

## Why not the alternatives

| Option | arm/v7 published? | Works on arm/v7? | Why rejected |
|---|---|---|---|
| `node:24-*` / `node:lts-*` (24, Active LTS until 2026-10-20) | **No** (alpine and slim: amd64, arm64, s390x/ppc64le only) | n/a | Node 24 downgraded armv7 to *Experimental* and publishes no `linux-armv7l` binary |
| `node:26-*` (LTS from 2026-10-28) | **No** | n/a | Same: no armv7l binary, no arm/v7 manifest |
| `node:22-alpine` / `22-alpine3.22` / `22-alpine3.23` | Yes | Yes (verified) | ~10 MB smaller compressed, but musl builds are *Experimental* upstream (x64 only). docker-node builds the arm/v7 musl binary from source. Startup under QEMU arm/v7 was **~19 s against ~3.5 s** for slim, which would make the emulated e2e job (#27) slow and flaky |
| `node:22-trixie-slim` | **No** | n/a | No arm/v7 manifest |
| `gcr.io/distroless/nodejs22-debian12` / `-debian13` | Yes (manifest) | **No, broken** | arm/v7 container exits 127: `/nodejs/bin/node: error while loading shared libraries: libatomic.so.1` (both debian12 and debian13) |
| `gcr.io/distroless/nodejs24-*` | No | n/a | No arm/v7 manifest |
| `node:20-*` | Yes | not tested | Node 20 reached EOL 2026-04-30 |

## Evidence (collected 2026-10-09)

### Manifests: `docker buildx imagetools inspect <ref>`

Images were pulled through `mirror.gcr.io/library/node` (a Docker Hub mirror
with the same digests) because of the Docker Hub rate limit in the sandbox.
`unknown/unknown` attestation entries are omitted.

```
22-alpine          linux/amd64 linux/arm/v6 linux/arm/v7 linux/arm64/v8 linux/s390x
22-slim            linux/amd64 linux/arm/v7 linux/arm64/v8 linux/ppc64le
22-bookworm-slim   linux/amd64 linux/arm/v7 linux/arm64/v8 linux/ppc64le   (digest == 22-slim)
22-trixie-slim     linux/amd64 linux/arm64/v8 linux/ppc64le linux/s390x     <- no arm/v7
24-alpine          linux/amd64 linux/arm64/v8 linux/s390x
24-slim            linux/amd64 linux/arm64/v8 linux/ppc64le
24-bookworm-slim   linux/amd64 linux/arm64/v8 linux/ppc64le
lts-alpine         linux/amd64 linux/arm64/v8 linux/s390x
lts-slim           linux/amd64 linux/arm64/v8 linux/ppc64le
26-alpine          linux/amd64 linux/arm64/v8
26-slim            linux/amd64 linux/arm64/v8 linux/ppc64le linux/s390x
gcr.io/distroless/nodejs22-debian12   amd64 arm64/v8 arm/v7 s390x ppc64le
gcr.io/distroless/nodejs22-debian13   amd64 arm64/v8 arm/v7 s390x ppc64le
gcr.io/distroless/nodejs24-debian12   amd64 arm64/v8 s390x ppc64le
gcr.io/distroless/nodejs24-debian13   amd64 arm64/v8 s390x ppc64le
```

### Upstream support

- `https://nodejs.org/dist/index.json`: the newest release of each line and
  whether a `linux-armv7l` binary exists:
  `v26.11.1 NO`, `v24.21.0 (LTS) NO`, `v22.23.3 (LTS) yes`, `v20.20.2 (LTS, EOL) yes`.
- `nodejs/node` `BUILDING.md`:
  - v22.x: `GNU/Linux armv7 ... Tier 1`
  - v24.x: `GNU/Linux armv7 ... Experimental | Downgraded as of Node.js 24`
- `nodejs/Release` `schedule.json`: v22 end 2027-04-30; v24 maintenance
  2026-10-20, end 2028-04-30; v26 LTS 2026-10-28, end 2029-04-30.

### Build and run on three platforms (buildx + QEMU)

Host: x86_64, Docker 29.8.2, buildx v0.37.1, QEMU registered with
`tonistiigi/binfmt --install arm,arm64`. The throwaway server was a minimal
`node:http` handler returning `process.env` as JSON with
`Content-Type: application/json`, plus a SIGTERM handler, running as UID 1000.

```dockerfile
# throwaway spike Dockerfile (not a repo file; the production one is #31)
ARG BASE=node:22-bookworm-slim
FROM ${BASE}
RUN userdel -r node \
 && groupadd -g 1000 httpenv && useradd -u 1000 -g httpenv -M -s /usr/sbin/nologin httpenv
COPY --chown=httpenv:httpenv server.mjs /app/server.mjs
USER httpenv
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
```

```
docker buildx build --platform <p> --build-arg BASE=<base> --load -t spike:<p> .
docker run -d --platform <p> -p 18080:8080 -e SPIKE=ok spike:<p>; curl -D - localhost:18080/
```

Results for `node:22-bookworm-slim` (the chosen image):

| Platform | Log line | HTTP | Body has `SPIKE=ok` | `id` | `docker stop` |
|---|---|---|---|---|---|
| linux/amd64 | `ready v22.23.3 x64 linux` | 200, `application/json` | yes | uid=1000(httpenv) | exit 0, ~0.2 s |
| linux/arm64 | `ready v22.23.3 arm64 linux` | 200, `application/json` | yes | uid=1000(httpenv) | exit 0, ~0.3 s |
| **linux/arm/v7** | **`ready v22.23.3 arm linux`** | **200, `application/json`** | **yes** | **uid=1000(httpenv)** | **exit 0, ~0.26 s** |

`node:22-alpine` gave the same results on all three platforms. On arm/v7,
both distroless Node 22 images failed with the `libatomic.so.1` error.

### Image sizes

Compressed size is the sum of the registry layer sizes for each platform
manifest (`imagetools inspect --raw`). That is what a node pulls. Unpacked size
is the `docker export` tar size of the spike image (base plus a few KB of app).

| Image | amd64 compressed / unpacked | arm64 compressed / unpacked | arm/v7 compressed / unpacked |
|---|---|---|---|
| current Go image (`alpine` + static binary) | ~9.2 MB (gzip of export) / 18.4 MB | n/a | n/a |
| **`node:22-bookworm-slim`** | **79.8 MB / 228.8 MB** | **79.8 MB / 248.5 MB** | **70.2 MB / 193.0 MB** |
| `node:22-alpine` (3.24) | 60.7 MB / 169.9 MB | 61.1 MB / 166.0 MB | 56.4 MB / 147.8 MB |
| `gcr.io/distroless/nodejs22-debian13` | 54.6 MB / 154.0 MB | 54.7 MB / 161.9 MB | 47.6 MB / broken |

The `node` binary alone is ~103-107 MB unpacked. npm, corepack and yarn add
~18 MB unpacked. Deleting them in a later layer shrinks the unpacked size but
**not** the pull size, because the original layer still ships. Only a
multi-stage copy onto a smaller base would remove them from the pull. That is
an optional optimisation for #31, not a requirement.

### Startup time (container start to first HTTP 200), 3 runs each

| Image | amd64 (native) | arm64 (QEMU) | arm/v7 (QEMU) |
|---|---|---|---|
| current Go image | 457 / 397 / 386 ms | n/a | n/a |
| `node:22-bookworm-slim` | 526 / 532 / 499 ms | 3760 / 3730 / 3677 ms | 3386 / 3460 / 3586 ms |
| `node:22-alpine` | 604 / 609 / 580 ms | 4118 / 4233 / 4330 ms | 21607 / 18669 / 18399 ms |

On amd64, Node adds ~100-150 ms over Go. The QEMU numbers matter for CI
timeouts only, not for production. #27 should use readiness polling with a
timeout of at least 60 s on arm/v7.

## Size budget

Enforced by #31, and checked in CI by #27/#31 on every PR that builds the image:

| Metric (per platform) | Budget | Measured base (amd64 / arm64 / arm/v7) |
|---|---|---|
| Compressed (registry) image size | **<= 90 MB** | 79.8 / 79.8 / 70.2 MB |
| Unpacked image size | **<= 275 MB** | 228.8 / 248.5 / 193.0 MB |
| App layers above the base image | **<= 1 MB** | a few KB (compiled JS, no `node_modules`) |

The budget leaves ~10% headroom for base-image patch bumps. A breach fails the
build. Raising the budget needs Tech Lead approval on the PR. The Go image
(~10 MB) is the floor and Node cannot reach it. The ~8x growth is the accepted
cost of fixed decision §2.1 (Node.js + TypeScript).

## Consequences and risks

- **Node 22 is the newest LTS line with official arm/v7 support, and it reaches
  EOL on 2027-04-30.** No later line (24, 26) publishes armv7l binaries or
  arm/v7 images. Before 2027-04-30 the owner must choose one of:
  1. Self-build Node >= 24 for armv7 (from source, or from Node's
     unofficial-builds project if it publishes armv7l; not verifiable from this
     sandbox), and own its patching.
  2. Keep arm/v7 on EOL Node 22 while amd64/arm64 move on. Not recommended,
     because it means unpatched CVEs.
  3. Drop `linux/arm/v7`. This changes fixed decision §2.2 and needs owner
     approval.

  This does not block waves 1+. It is a dated follow-up for the owner, to be
  tracked as a separate issue.
- Debian 12 "bookworm" is past regular Debian security support and now relies
  on Debian LTS. Trivy (#37) will surface base-image CVEs, and Dependabot
  digest bumps (#33) keep it patched.
- `22-trixie-slim` lacks arm/v7, so a future docker-node move to trixie as
  the default would also hit arm/v7. Rule 1 above (explicit `bookworm` tag)
  guards against that.
- CI should also run a non-blocking Node 24 job (#32), so the eventual
  migration is not a surprise.
