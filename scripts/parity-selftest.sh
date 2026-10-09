#!/bin/sh
# parity-selftest.sh - prove that scripts/parity-diff.mjs detects differences.
#
#   1. Go image vs Go image                -> must exit 0 with no differences at all
#   2. Go image vs conforming mutant image -> must exit 0 (allow-listed differences only)
#   3. Go image vs broken mutant image     -> must exit 1 (unexplained differences)
#
# Requires: docker, node (>= 18). Run from the repository root:
#   sh scripts/parity-selftest.sh
# Override base images with GO_IMAGE / NODE_BASE if Docker Hub is unavailable.
set -eu

NODE_BASE=${NODE_BASE:-node:22-alpine}
GO_IMAGE=${GO_IMAGE:-}
root=$(cd "$(dirname "$0")/.." && pwd)
diff="$root/scripts/parity-diff.mjs"

if [ -z "$GO_IMAGE" ]; then
  GO_IMAGE=httpenv-parity-go:selftest
  docker build -q -t "$GO_IMAGE" "$root" >/dev/null
fi

# The mutant image mirrors the Go image's runtime user (httpenv, UID/GID 1000)
# and resets the Node base image's shell entrypoint, as the TS image must.
docker build -q -t httpenv-parity-mutant:selftest -f - "$root/scripts" >/dev/null <<EOF
FROM $NODE_BASE
RUN deluser --remove-home node \
 && addgroup -g 1000 httpenv && adduser -u 1000 -G httpenv -D httpenv
COPY parity-mutant.mjs /parity-mutant.mjs
USER httpenv
EXPOSE 8080
ENTRYPOINT []
CMD ["node", "/parity-mutant.mjs"]
EOF

docker build -q -t httpenv-parity-broken:selftest - >/dev/null <<EOF
FROM httpenv-parity-mutant:selftest
ENV PARITY_MUTANT=broken
EOF

expect() { # expect <code> <description> <args...>
  want=$1; shift; what=$1; shift
  echo "### $what (expect exit $want)"
  set +e; node "$diff" "$@"; got=$?; set -e
  if [ "$got" -ne "$want" ]; then echo "SELFTEST FAIL: $what exited $got, expected $want"; exit 1; fi
  echo "### ok"
}

expect 0 "Go vs Go" --a-image "$GO_IMAGE" --b-image "$GO_IMAGE" --strict
expect 0 "Go vs conforming mutant" --a-image "$GO_IMAGE" --b-image httpenv-parity-mutant:selftest
expect 1 "Go vs conforming mutant, --strict" --a-image "$GO_IMAGE" --b-image httpenv-parity-mutant:selftest --strict
expect 1 "Go vs broken mutant" --a-image "$GO_IMAGE" --b-image httpenv-parity-broken:selftest
echo "parity self-test passed"
