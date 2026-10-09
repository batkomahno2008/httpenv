# httpenv behaviour contract

This document is the observable contract of `httpenv`. The Go implementation (`httpenv.go`) is the reference; the Node.js/TypeScript port must reproduce every item below **except** the rows listed under [Intentional differences](#intentional-differences). The parity script [`scripts/parity-diff.mjs`](../scripts/parity-diff.mjs) checks the contract mechanically.

Key words: **MUST** = contract (a difference fails parity unless allow-listed); **SHOULD** = recommended, not checked as a failure; **non-contract** = may differ freely.

## Provenance

Every statement below was observed, not inferred, on 2026-10-09:

| Reference build | How it was run |
|---|---|
| `go build httpenv.go` with Go 1.24.7 (linux/amd64) | `env -i FOO=bar ... ./httpenv`, plus raw `execve` with hand-built `envp` for malformed entries |
| `docker build .` (current `Dockerfile`: `golang:alpine` resolved to Go 1.27.2, runtime `alpine`) | `docker run -p 127.0.0.1::8080 ...` |

Requests were made with `curl -i` / `curl --path-as-is` and with the parity script. Where the two Go versions differ, both values are given.

## 1. Process

| # | Item | Observed Go behaviour | Contract |
|---|---|---|---|
| P1 | Listen address | `:8080`, i.e. TCP port 8080 on all interfaces | MUST |
| P2 | Port configuration | None. No flag, no `PORT` variable | MUST (port behaviour only, no new features) |
| P3 | Startup output | Exactly two lines on **stdout**, printed before the listener is bound (see below) | MUST, byte-for-byte |
| P4 | stderr during normal operation | Empty. Nothing is logged per request | MUST |
| P5 | Port already in use | Prints the two startup lines, then `panic: listen tcp :8080: bind: address already in use` + goroutine trace on stderr, exit code 2 | Non-zero exit and an error on stderr: MUST. Exact text and code: non-contract |
| P6 | `SIGTERM` | Process dies immediately from the signal: exit status 143 (128+15), no draining. Also true as PID 1 in the container (`docker stop` returned in < 1 s, exit code 143) because the Go runtime installs its own handler | See [D3](#intentional-differences) |
| P7 | Runtime user (container) | `uid=1000(httpenv) gid=1000(httpenv)`, PID 1 is `/httpenv` | MUST (UID/GID 1000, non-root, retained) |

Startup output, exact bytes (note: no space after `8080.`):

```text
Starting httpenv listening on port 8080.Please stand by...
Why did the cat refuse to play cards with the dog? Because every time he got a good hand, he wagged his tail!
```

Each line ends with a single `\n`.

## 2. Requests: every method, every path

The handler is registered on the `/` pattern, which matches every path. Request bodies, query strings and request headers are ignored.

| Request | Go result | Contract |
|---|---|---|
| `GET /` | 200, env JSON | MUST |
| `GET /some/deep/path/`, `/favicon.ico`, `/a/`, `/a%2Fb`, `/%2e%2e/` | 200, same body as `GET /` | MUST |
| `GET /q?x=1&y=%3Cz%3E&x=2` | 200, same body (query ignored) | MUST |
| `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `TRACE` (with or without a body) | 200, same body | MUST |
| `HEAD /` | 200, same headers as `GET`, no body | MUST (status, Content-Type, empty body) |
| `GET` with `Accept: text/html` or `Accept: application/json` | 200, same body and Content-Type (no content negotiation) | MUST |
| `OPTIONS * HTTP/1.1` | 200, same body | non-contract |
| Unclean path `/a/../b`, `//x`, `/./`, `/.` | **Redirect** to the cleaned path: 301 (Go 1.24.7) / 307 (Go 1.27.2), `Content-Type: text/html; charset=utf-8`, `Location: /b`, small HTML body. This is Go `ServeMux` behaviour, not handler code | See [D6](#intentional-differences) |
| Extension method, e.g. `FOO /` | 200, same body | See [D7](#intentional-differences) |
| `CONNECT` | 200, same body | See [D7](#intentional-differences) |
| HTTP/1.1 request without `Host` | 400 (Go `net/http`) | non-contract (protocol error handling; `node:http` also answers 400) |
| HTTP/1.0 request | 200, `HTTP/1.0 200 OK` | MUST (status and body) |
| Keep-alive: several requests on one connection | Supported | SHOULD |

## 3. Response status and headers

Observed for a small environment (`env -i FOO=bar ...`, 218-byte body):

```http
HTTP/1.1 200 OK
Date: Fri, 09 Oct 2026 10:50:52 GMT
Content-Length: 218
Content-Type: text/plain; charset=utf-8
```

| # | Item | Go | Contract |
|---|---|---|---|
| H1 | Status | Always 200 (except the `ServeMux` redirects above and a malformed env entry, see [D1](#intentional-differences)) | MUST |
| H2 | `Content-Type` | Not set by the code; Go content-sniffs the JSON and sends `text/plain; charset=utf-8` | See [D2](#intentional-differences): TS MUST send `application/json; charset=utf-8` |
| H3 | Framing | Bodies that fit Go's ~2 KiB write buffer get `Content-Length` (218 B observed); larger bodies are sent `Transfer-Encoding: chunked` with no `Content-Length` (4.7 KiB observed). `HEAD` mirrors this (no `Content-Length` for a large env) | Non-contract. When `Content-Length` is present it MUST equal the body length. TS SHOULD always send `Content-Length` (also on `HEAD`) |
| H4 | `Date` | Present | Present: SHOULD. Value: non-contract |
| H5 | Other headers | None (no `Connection`, `Keep-Alive`, `Server`, `X-*`, CORS, caching headers) | MUST NOT add application headers. `Connection`/`Keep-Alive` emitted by `node:http` are non-contract ([D8](#intentional-differences)) |

## 4. Body

The body is one JSON object built from the process environment (`os.Environ()`):

| # | Item | Go | Contract |
|---|---|---|---|
| B1 | Shape | Flat object; every key and every value is a JSON string. No nesting, no arrays, no numbers/booleans/null | MUST |
| B2 | Key/value split | Split on the **first** `=`: `EQ=a=b=c` becomes `"EQ":"a=b=c"` | MUST |
| B3 | Empty value | `EMPTY=` becomes `"EMPTY":""` | MUST |
| B4 | Duplicate names | `A=first` then `A=second` gives `{"A":"first"}` (first wins; Go's `syscall` drops later duplicates). Node's `process.env` behaves the same | MUST |
| B5 | Empty envp entry (`""`) | Skipped | MUST |
| B6 | Empty environment | `{}` | MUST |
| B7 | Names | Case preserved (`parity_lowercase`), punctuation preserved (`PARITY.DOT-DASH`) | MUST |
| B8 | Values | Preserved exactly: leading/trailing spaces, quotes, backslashes, `\n`, `\t`, control characters, U+2028/U+2029, non-ASCII (`héllo 日本 🚀`), long values (4 KiB tested) | MUST (same decoded JSON value) |
| B9 | Invalid UTF-8 in a value (`BAD=\xff\xfe`) | Each invalid byte becomes U+FFFD: `"BAD":"\ufffd\ufffd"`. Node decodes it to the same two U+FFFD characters | MUST (verified for Node by hand; not reachable from the parity script, see [section 8](#8-what-the-parity-script-cannot-check)) |
| B10 | Key order | Sorted by byte value (Go sorts map keys) | SHOULD (parity compares key-order-insensitively) |
| B11 | Escaping | `json.Marshal` escapes `<`, `>`, `&` as `\u003c`, `\u003e`, `\u0026`, U+2028/U+2029 as `\u2028`/`\u2029`, control characters as `\u00XX` (except `\n` `\r` `\t`), and writes other non-ASCII as raw UTF-8 | Non-contract ([D10](#intentional-differences)): only the decoded JSON value must match. TS SHOULD match Go's bytes anyway |
| B12 | Trailing newline | None; the body ends with `}` | SHOULD |

Exact Go body for the probe environment `FOO=bar EQ=a=b=c EMPTY= HTML=<a href="x">&amp;</a> UNI=héllo 日本 🚀 QUOTE="q"\back NL=line1<LF>line2 LS=x<U+2028>y BAD=<FF FE> CTL=<01><TAB>`:

```json
{"BAD":"\ufffd\ufffd","CTL":"\u0001\t","EMPTY":"","EQ":"a=b=c","FOO":"bar","HTML":"\u003ca href=\"x\"\u003e\u0026amp;\u003c/a\u003e","LS":"x\u2028y","NL":"line1\nline2","QUOTE":"\"q\"\\back","UNI":"héllo 日本 🚀"}
```

## 5. Container environment

The response is the container's environment, so the image is part of the contract. The Go image, run with `-e FOO=bar`, serves:

```json
{"FOO":"bar","HOME":"/home/httpenv","HOSTNAME":"<container id>","PATH":"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}
```

| # | Item | Contract |
|---|---|---|
| C1 | `HOME=/home/httpenv`: follows from running as user `httpenv` | MUST. The TS image must run as a user named `httpenv`, UID/GID 1000 (the `node` user also has UID 1000 but gives `HOME=/home/node`) |
| C2 | `PATH` as above | MUST |
| C3 | No extra keys | MUST. Note that the `node` images' default `ENTRYPOINT` (`docker-entrypoint.sh`) is a shell script that adds `SHLVL=1` and `PWD=/`; the TS image must override it (for example `ENTRYPOINT []` with `CMD ["node", ...]`) |
| C4 | `NODE_VERSION`, `YARN_VERSION` from a Node base image | Allowed ([D9](#intentional-differences)) |
| C5 | `HOSTNAME` | Varies per container; the parity script pins it with `--hostname` |

## 6. Go defects and intended TS behaviour

| Go defect | Observed | Intended TS behaviour |
|---|---|---|
| Panic on an env entry without `=` | Only at **request** time, not at startup: `strings.SplitN` returns one element and `keyval[1]` panics (`index out of range [1] with length 1`). `net/http` recovers it per connection: the client gets the connection closed with **no response**, stderr gets `http: panic serving <addr>: ...` plus a stack trace, and the process keeps running. Every request fails while the entry exists | Skip the malformed entry, answer 200 with the remaining variables, never crash or drop the connection ([D1](#intentional-differences)). Node's `process.env` already omits such entries |
| No `Content-Type` | `text/plain; charset=utf-8` by sniffing | `Content-Type: application/json; charset=utf-8` ([D2](#intentional-differences)) |
| No `SIGTERM` handling | No graceful shutdown: in-flight requests are cut, exit status 143. Correction to the issue text: Go does **not** hang as PID 1, because its runtime installs a handler and exits. Node, unlike Go, ignores `SIGTERM` as PID 1 unless the program handles it, so the port must add a handler | On `SIGTERM` (and `SIGINT`): stop accepting connections, let in-flight responses finish, exit 0, well inside Docker's default 10 s grace period ([D3](#intentional-differences)) |
| Unreachable marshal-error branch (`w.Write([]byte("{}"))`) | `json.Marshal` of a `map[string]string` cannot fail; invalid UTF-8 is replaced, not rejected | Do not port the `{}` fallback; there is no corresponding branch to test ([D4](#intentional-differences)) |

## Intentional differences

This is the complete list of accepted differences between Go (A) and TS (B). The parity script allow-lists exactly the rule IDs in the last column; every other difference fails the run.

| ID | Difference | Status | Parity rule |
|---|---|---|---|
| D1 | Env entry without `=`: Go closes the connection with no response and logs a panic; TS ignores the entry and answers 200 | Fixed decision (master issue §2.5) | Not reachable through docker or Node `spawn` (both refuse to create such an entry); covered by unit tests |
| D2 | `Content-Type`: Go `text/plain; charset=utf-8`, TS `application/json; charset=utf-8` | Fixed decision (§2.5) | `D2-content-type`: A must be exactly Go's value and B exactly `application/json; charset=utf-8` |
| D3 | `SIGTERM`: Go exits 143 immediately; TS shuts down gracefully and exits 0 | Fixed decision (§2.5) | `D3-sigterm-exit`: only the A=143 / B=0 pair is allowed; both must stop within the grace period (a SIGKILL or 137 is a failure) |
| D4 | No `{}` fallback for a marshal error | Not observable | None needed |
| D5 | Entry with an empty name (`=val`): Go serves `"":"val"`; Node's `process.env` cannot see it, so TS omits it | Proposed: tech-lead sign-off on this PR | Not reachable through docker or Node `spawn`; document it in unit tests |
| D6 | Unclean paths (`/a/../b`, `//x`, `/./`): Go `ServeMux` redirects (301/307); TS serves them like any other path (200, env JSON) | Proposed: tech-lead sign-off | `D6-path-clean-redirect`: A is 301/307/308 and B is 200 with the same env as `GET /` on A |
| D7 | Extension methods (`FOO`) and `CONNECT`: Go answers 200; `node:http` rejects unknown methods with 400 before the handler runs, and handles `CONNECT` as a tunnel | Proposed: tech-lead sign-off (unavoidable with `node:http`, master issue §2.1) | `D7-extension-method`: A 200, B 400/405/501. `CONNECT` is not probed |
| D8 | Transport headers: `Date` value, `Connection`, `Keep-Alive`, `Transfer-Encoding` and `Content-Length` (chunked vs length) | Non-contract | Always ignored, also in `--strict`; a `Content-Length` that is present is checked against the body length |
| D9 | `NODE_VERSION`, `YARN_VERSION` present only in the TS image | Environment, not code | `D9-runtime-env-keys`: only these keys, only when present in B and absent in A |
| D10 | Same JSON value, different bytes (key order, `\u003c` vs `<`, `\u2028` vs a raw U+2028) | Non-contract | `D10-serialization` |

Retained, not a difference: non-root UID/GID 1000 (P7, C1).

## 7. Parity script

`scripts/parity-diff.mjs` compares a reference A (Go) with a candidate B (TS) and prints a normalized diff: `=` identical check, `~` difference matched by an allow-list rule (rule ID shown), `!` unexplained difference.

```sh
# Two images, identical fixture env and hostname, random loopback ports (recommended for CI):
node scripts/parity-diff.mjs --a-image httpenv-go:ref --b-image httpenv-ts:candidate

# Two local commands, each started with ONLY the fixture env (+PATH), one after the other on --port:
node scripts/parity-diff.mjs --a-cmd ./httpenv --b-cmd "node dist/server.js"

# Two servers that are already running (env not controlled; HTTP checks only):
node scripts/parity-diff.mjs --a-url http://127.0.0.1:8080 --b-url http://127.0.0.1:8081 --ignore-key HOSTNAME
```

| Checked | url | image | cmd |
|---|---|---|---|
| 16 HTTP cases (section 2 methods/paths): status, headers except D8, `Content-Length` correctness, body as decoded JSON compared key by key, body bytes | yes | yes | yes |
| Fixture env (section 4 value cases: `=` in value, empty, HTML, Unicode, quotes, newline, tab, control chars, U+2028/9, spaces, 4 KiB value, lowercase and punctuated names) | no | yes | yes |
| stdout and stderr over the whole run (startup lines) | no | yes | yes |
| `SIGTERM`: stopped within 10 s, exit code | no | yes (`docker stop`) | yes |
| Runtime UID (`id -u` in the container) | no | yes | no |

Options: `--strict` disables the allow-list (every difference fails), `--ignore-key KEY` (repeatable, shown in the report), `--report FILE` writes a JSON report with raw responses, `--port`, `--container-port`, `--timeout`. Exit codes: 0 no unexplained differences, 1 unexplained differences, 2 usage or infrastructure error.

Self-test: `sh scripts/parity-selftest.sh` builds the Go image and a deliberately different Node server (`scripts/parity-mutant.mjs`, test fixture only) and asserts: Go vs Go `--strict` exits 0 with zero differences; Go vs a mutant that only has the intentional differences exits 0 (and exits 1 with `--strict`); Go vs a broken mutant exits 1.

Why a Node script: it needs only Node built-ins (`node:http`, `node:child_process`, `node:util`), which every later stage already requires, so it adds no runtime or dev dependency. It can send exact methods and unnormalized paths (`/a/../b`, `FOO`), capture raw body bytes next to the decoded JSON, and drive processes and signals portably. A POSIX `sh` + `curl` + `jq` version would depend on `jq` and `curl` versions on each runner and would make key-by-key JSON diffs and process control harder to keep correct.

Note for the parity job (batkomahno2008/httpenv#28): the current `Dockerfile` builds from the unpinned `golang:alpine`, so the reference drifts with Go releases (the D6 redirect changed from 301 to 307). Pin the Go reference image (for example the rollback tag) when wiring the script into CI.

## 8. What the parity script cannot check

The script passes the fixture through `docker run -e` and Node `child_process.spawn`. Neither can create an entry without `=` (`-e NAME` means "copy NAME from the host", and `spawn` takes an object), docker rejects an empty name (`invalid environment variable: =val`), and `spawn` takes JavaScript strings, so it cannot send raw invalid UTF-8. These cases (B9, D1, D5) were verified by hand with a raw `execve` and must be covered by the TS unit tests (batkomahno2008/httpenv#22, batkomahno2008/httpenv#23), for example by feeding crafted entries to the function that builds the response object rather than going through `process.env`.
