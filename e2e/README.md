# Container e2e suite

This is a black-box test suite for an `httpenv` container image. It knows nothing about the language inside the image: it gets an image reference and talks to the container only through the `docker` CLI and HTTP. The same suite therefore checks both the Go image and the TypeScript image. Every expectation comes from [`docs/behaviour-contract.md`](../docs/behaviour-contract.md).

It needs Node.js 22 or later and a working `docker` CLI, and nothing else. There are no npm dependencies. The suite uses the built-in `node:test` runner and starts containers through `docker`.

## Run it

```sh
# Strict mode (the default): every scenario must pass. Use this for the TypeScript image.
make e2e IMAGE=ghcr.io/batkomahno2008/httpenv:candidate

# Against the Go reference image, with its documented known failures.
make e2e IMAGE=httpenv:go E2E_IMPL=go

# The same, without make.
node e2e/run.mjs --image httpenv:go --impl go
TESTING_IMAGE=httpenv:go E2E_IMPL=go node e2e/run.mjs
```

If the image is not available locally, the suite pulls it before any timing starts. Exit codes are:

- `0`: every scenario passed. An expected failure that failed in the documented way counts as passed.
- `1`: at least one scenario failed.
- `2`: usage error.

## Configuration

| Flag (`e2e/run.mjs`) | Environment / `make` variable | Default | Meaning |
|---|---|---|---|
| `--image REF` | `TESTING_IMAGE` (`IMAGE` for `make`) | required | Image under test |
| `--impl go\|ts` | `E2E_IMPL` | `ts` | Which known-failure list to apply. `ts` has none, so it is strict |
| `--ready-timeout S` | `E2E_READY_TIMEOUT` | `20` | Seconds allowed for `GET /` to answer 200 after `docker run`. Use at least `60` for arm/v7 under QEMU |
| `--stop-budget S` | `E2E_STOP_BUDGET` | `3` | Seconds `docker stop` may take |
| `--platform P` | `E2E_PLATFORM` | not set | Passed to `docker run --platform`, for example `linux/arm/v7` |
| `-- <args>` | none | none | Extra arguments for `node --test`, for example reporters |

Without a reporter argument, `node --test` prints TAP when stdout is not a terminal, which is the case in CI. To also write a JUnit file:

```sh
node e2e/run.mjs --image "$IMAGE" -- \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=junit --test-reporter-destination=e2e-junit.xml
```

## Scenarios

The scenarios run in the order listed below. One container is started with `-e FOO=bar -e E2E_EQUALS=a=b=c`, and its port 8080 is published on a random port on `127.0.0.1`.

| ID | Checks | Contract |
|---|---|---|
| `ready` | The container starts and `GET /` answers 200 within the ready timeout. A bare TCP accept is not enough, because `docker-proxy` accepts connections before the app is listening | P1 |
| `json-env` | `GET /` returns 200 and a flat JSON object whose values are all strings. The object includes `FOO=bar` and `E2E_EQUALS=a=b=c`. If a `Content-Length` header is present, it equals the body length | B1, B2, H3 |
| `content-type` | `Content-Type` is `application/json; charset=utf-8` | H2, D2 |
| `hostname` | `HOSTNAME` is the 12-character short container ID and matches `docker inspect` `Config.Hostname`. A second container started with `--hostname e2e-custom-host` must report that name | C5 |
| `uid` | `Uid` and `Gid` of PID 1 are 1000, read from `/proc/1/status` with `docker exec cat`, which works on Alpine and Debian slim. If the image has no `cat`, the suite falls back to `docker top` | P7, C1 |
| `startup-log` | `docker logs` stdout is exactly the two startup lines, byte for byte, and stderr is empty | P3, P4 |
| `sigterm-stop` | `docker stop` returns within the stop budget and the exit code is not 137. 137 would mean Docker had to send SIGKILL. The exit code itself is reported but not asserted: under D3, Go exits 143 and TS exits 0 | P6, D3 |

Containers are named `httpenv-25-e2e-<pid>-<random>`. The suite removes them after the run, including when a scenario fails or the run is interrupted with SIGINT or SIGTERM.

## Known failures

[`known-failures.mjs`](known-failures.mjs) is the only place where expected failures are listed. Each entry names an implementation (`E2E_IMPL`), a scenario ID, a contract reference and a `symptom` regular expression. These scenarios are never skipped. They always run, and the result is handled as follows:

- **XFAIL:** the assertion fails with a message that matches `symptom`. The test is reported as passed and a diagnostic line shows the failure.
- **XPASS:** the scenario passes. The test fails and asks you to remove the entry, so a fixed defect cannot stay hidden.
- **Any other error:** a different assertion, or the container not becoming ready, fails the test.

Current list:

| `E2E_IMPL` | Scenario | Ref | Why |
|---|---|---|---|
| `go` | `content-type` | D2 | Go never sets `Content-Type`, so `net/http` content-sniffs the JSON and sends `text/plain; charset=utf-8` |
| `ts` | none | | Strict |

`sigterm-stop` is **not** a known failure for Go. The original issue expected Go to hang as PID 1, but the contract corrects this (P6): the Go runtime exits with 143 in under 1 s.
