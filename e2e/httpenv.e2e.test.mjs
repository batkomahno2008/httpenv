// httpenv.e2e.test.mjs - container-level black-box e2e suite for httpenv.
//
// Language-agnostic: it only uses the image reference, the docker CLI and HTTP,
// so the same suite validates the Go image and the TypeScript image.
// Contract: docs/behaviour-contract.md. Usage: e2e/README.md.
//
// Configuration (environment; e2e/run.mjs maps its flags onto these):
//   TESTING_IMAGE       image reference under test (required)
//   E2E_IMPL            go | ts - selects the known-failure list (default ts = strict)
//   E2E_READY_TIMEOUT   seconds to wait for GET / to answer 200 (default 20)
//   E2E_STOP_BUDGET     seconds `docker stop` may take (default 3)
//   E2E_PLATFORM        optional `docker run --platform` value, e.g. linux/arm/v7

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_FAILURES, IMPLS } from './known-failures.mjs';
import {
  docker, ensureImage, startContainer, inspect, removeContainer, cleanupAll, request, waitReady,
} from './docker.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function seconds(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of seconds, got "${raw}"`);
  return n;
}

const IMAGE = process.env.TESTING_IMAGE;
if (!IMAGE) throw new Error('TESTING_IMAGE is not set (use: node e2e/run.mjs --image <ref>)');
const IMPL = process.env.E2E_IMPL || 'ts';
if (!IMPLS.includes(IMPL)) throw new Error(`E2E_IMPL must be one of ${IMPLS.join(', ')}, got "${IMPL}"`);
const READY_TIMEOUT_S = seconds('E2E_READY_TIMEOUT', 20);
const STOP_BUDGET_S = seconds('E2E_STOP_BUDGET', 3);
const PLATFORM = process.env.E2E_PLATFORM || undefined;
const EXPECTED = KNOWN_FAILURES[IMPL];

// Contract values (docs/behaviour-contract.md).
const STARTUP_STDOUT =
  'Starting httpenv listening on port 8080.Please stand by...\n' +
  'Why did the cat refuse to play cards with the dog? Because every time he got a good hand, he wagged his tail!\n';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const SIGTERM_EXIT = { go: 143, ts: 0 }; // D3, reported only
const INJECTED_ENV = { FOO: 'bar', E2E_EQUALS: 'a=b=c' };

// ---------------------------------------------------------------------------
// Scenario wrapper with explicit expected failures (never a silent skip)
// ---------------------------------------------------------------------------
function scenario(id, title, fn) {
  const xfail = EXPECTED[id];
  const name = xfail ? `${id}: ${title} [expected failure for ${IMPL}: ${xfail.ref}]` : `${id}: ${title}`;
  test(name, async (t) => {
    if (!xfail) return fn(t);
    try {
      await fn(t);
    } catch (err) {
      const isDocumented = err?.code === 'ERR_ASSERTION' && xfail.symptom.test(err.message);
      if (!isDocumented) throw err; // a different failure than the documented one
      t.diagnostic(`XFAIL ${xfail.ref}: ${err.message.split('\n')[0]}`);
      t.diagnostic(`reason: ${xfail.reason}`);
      return;
    }
    throw new Error(
      `XPASS: "${id}" is listed in e2e/known-failures.mjs as an expected failure for ` +
        `E2E_IMPL=${IMPL} (${xfail.ref}) but it passed. Remove the entry.`,
    );
  });
}

// ---------------------------------------------------------------------------
// Shared container (scenarios run sequentially in file order; stop is last)
// ---------------------------------------------------------------------------
let main; // { name, id, port }
let ready = false;

function requireReady() {
  // Plain Error (not an assertion) so it can never count as an expected failure.
  if (!ready) throw new Error('container is not ready; see the "ready" scenario');
}

before(async () => {
  await ensureImage(IMAGE, PLATFORM);
});

after(async () => {
  await cleanupAll();
});

test(`config: image=${IMAGE} impl=${IMPL} ready-timeout=${READY_TIMEOUT_S}s stop-budget=${STOP_BUDGET_S}s` +
  `${PLATFORM ? ` platform=${PLATFORM}` : ''}`, (t) => {
  const ids = Object.keys(EXPECTED);
  t.diagnostic(`expected failures for ${IMPL}: ${ids.length ? ids.map((i) => `${i} (${EXPECTED[i].ref})`).join(', ') : 'none (strict)'}`);
});

scenario('ready', `container starts and GET / on 8080 answers within ${READY_TIMEOUT_S} s`, async (t) => {
  main = await startContainer(IMAGE, { env: INJECTED_ENV, platform: PLATFORM });
  t.diagnostic(`container ${main.name} (${main.id.slice(0, 12)}) on 127.0.0.1:${main.port}`);
  const ms = await waitReady(main, READY_TIMEOUT_S * 1000);
  ready = true;
  t.diagnostic(`ready after ${ms} ms`);
});

scenario('json-env', 'GET / returns a flat JSON object of strings with the injected env', async () => {
  requireReady();
  const res = await request(main.port);
  assert.equal(res.status, 200);
  if (res.headers['content-length'] !== undefined) {
    assert.equal(Number(res.headers['content-length']), res.body.length, 'Content-Length must equal the body length');
  }
  let body;
  assert.doesNotThrow(() => { body = JSON.parse(res.body.toString('utf8')); }, 'body must be valid JSON');
  assert.ok(body !== null && typeof body === 'object' && !Array.isArray(body), 'body must be a JSON object');
  for (const [k, v] of Object.entries(body)) assert.equal(typeof v, 'string', `value of ${k} must be a string`);
  for (const [k, v] of Object.entries(INJECTED_ENV)) assert.equal(body[k], v, `injected -e ${k}=${v}`);
});

scenario('content-type', `Content-Type is ${CONTENT_TYPE}`, async () => {
  requireReady();
  const res = await request(main.port);
  const got = String(res.headers['content-type'] ?? '(none)');
  const norm = got.toLowerCase().replace(/\s+/g, '');
  assert.equal(norm, CONTENT_TYPE.replace(/\s+/g, ''), `Content-Type is "${got}", want "${CONTENT_TYPE}"`);
});

scenario('hostname', 'HOSTNAME equals the container ID (12-char short ID) and follows --hostname', async (t) => {
  requireReady();
  const info = await inspect(main.name);
  const shortId = info.Id.slice(0, 12);
  const body = JSON.parse((await request(main.port)).body.toString('utf8'));
  assert.equal(body.HOSTNAME, shortId, 'HOSTNAME must be the short container ID');
  assert.equal(info.Config.Hostname, shortId, 'docker inspect Config.Hostname');

  // HOSTNAME must come from the container, not be hard-coded: --hostname changes it.
  const custom = 'e2e-custom-host';
  const other = await startContainer(IMAGE, { hostname: custom, platform: PLATFORM });
  try {
    await waitReady(other, READY_TIMEOUT_S * 1000);
    const otherBody = JSON.parse((await request(other.port)).body.toString('utf8'));
    assert.equal(otherBody.HOSTNAME, custom, 'HOSTNAME with --hostname');
    t.diagnostic(`HOSTNAME=${body.HOSTNAME}; with --hostname: ${otherBody.HOSTNAME}`);
  } finally {
    await removeContainer(other.name);
  }
});

scenario('uid', 'PID 1 runs as UID/GID 1000, not root', async (t) => {
  requireReady();
  let uids;
  let gids;
  try {
    // Works on Alpine (busybox) and Debian slim images alike.
    const { stdout } = await docker(['exec', main.name, 'cat', '/proc/1/status']);
    const field = (key) => stdout.match(new RegExp(`^${key}:\\s+(.*)$`, 'm'))?.[1].trim().split(/\s+/).map(Number);
    uids = field('Uid'); // real, effective, saved, filesystem
    gids = field('Gid');
    t.diagnostic(`/proc/1/status Uid: ${uids?.join(' ')} Gid: ${gids?.join(' ')}`);
  } catch (err) {
    // Fallback for images without `cat`: ask the host's ps through docker top.
    t.diagnostic(`docker exec failed (${err.message.split('\n')[0]}); falling back to docker top`);
    const { stdout } = await docker(['top', main.name, '-o', 'pid,uid,gid,args']);
    const row = stdout.trim().split('\n')[1].trim().split(/\s+/);
    uids = [Number(row[1])];
    gids = [Number(row[2])];
    t.diagnostic(`docker top: ${stdout.trim().split('\n')[1].trim()}`);
  }
  assert.ok(uids && uids.length > 0, 'could not read the UID of PID 1');
  for (const u of uids) assert.equal(u, 1000, `UID of PID 1 must be 1000 (got ${uids.join(' ')})`);
  for (const g of gids ?? []) assert.equal(g, 1000, `GID of PID 1 must be 1000 (got ${gids.join(' ')})`);
});

scenario('startup-log', 'stdout is exactly the two startup lines and stderr is empty', async () => {
  requireReady();
  const { stdout, stderr } = await docker(['logs', main.name]);
  assert.equal(stdout, STARTUP_STDOUT, 'startup lines on stdout (contract P3, byte for byte)');
  assert.equal(stderr, '', 'nothing on stderr during normal operation (contract P4)');
});

scenario('sigterm-stop', `docker stop (SIGTERM) terminates the container within ${STOP_BUDGET_S} s`, async (t) => {
  requireReady();
  const start = process.hrtime.bigint();
  await docker(['stop', '-t', '10', main.name], { timeoutMs: 30_000 });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const state = (await inspect(main.name)).State;
  t.diagnostic(
    `stopped in ${ms.toFixed(0)} ms, exit code ${state.ExitCode} ` +
      `(contract D3: go exits ${SIGTERM_EXIT.go}, ts exits ${SIGTERM_EXIT.ts}; exit code reported, not asserted)`,
  );
  assert.equal(state.Running, false, 'container must not be running after docker stop');
  assert.notEqual(state.ExitCode, 137, 'exit 137 means docker had to SIGKILL it: SIGTERM was ignored');
  assert.ok(ms < STOP_BUDGET_S * 1000, `docker stop took ${ms.toFixed(0)} ms, budget ${STOP_BUDGET_S * 1000} ms`);
});
