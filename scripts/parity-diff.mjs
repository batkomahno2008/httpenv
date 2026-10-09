#!/usr/bin/env node
// parity-diff.mjs - compare the observable behaviour of two httpenv servers.
//
// A is the reference (the Go implementation), B is the candidate (the
// TypeScript port). Every difference between them is either matched by an
// entry of the explicit ALLOW_LIST below (each one documented in
// docs/behaviour-contract.md, section "Intentional differences") or reported
// as an unexplained difference, which makes the script exit 1.
//
// Zero dependencies: Node.js >= 18 built-ins only (plus the docker CLI for
// --a-image/--b-image). See `node scripts/parity-diff.mjs --help`.

import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';

const execFileP = promisify(execFile);

const USAGE = `Usage:
  node scripts/parity-diff.mjs --a-url URL   --b-url URL   [options]
  node scripts/parity-diff.mjs --a-image IMG --b-image IMG [options]
  node scripts/parity-diff.mjs --a-cmd CMD   --b-cmd CMD   [options]

Modes:
  --a-url/--b-url      Compare two already running servers (e.g. http://127.0.0.1:8080).
                       Their environments are NOT controlled by this script, so only
                       the HTTP cases are run.
  --a-image/--b-image  Start both images with docker, with an identical fixture
                       environment and hostname, on random loopback ports. Also
                       compares startup output, SIGTERM handling and runtime UID.
  --a-cmd/--b-cmd      Start each command (argv split on whitespace, no shell) with
                       ONLY the fixture environment (plus PATH), one after the other,
                       each listening on --port. Also compares startup output and
                       SIGTERM handling.

Options:
  --port N             Port the server listens on in --*-cmd mode (default 8080).
  --container-port N   Port exposed by the images in --*-image mode (default 8080).
  --ignore-key KEY     Ignore this env key in bodies (repeatable). Shown in the report.
  --strict             Disable the allow-list: every difference is unexplained.
  --report FILE        Also write the full machine-readable report as JSON.
  --timeout MS         Per-request / readiness timeout (default 15000).
  -h, --help           Show this help.

Exit codes: 0 = no unexplained differences, 1 = unexplained differences,
            2 = usage or infrastructure error.`;

// ---------------------------------------------------------------------------
// Fixture environment used in --*-image and --*-cmd modes. Exercises every
// value-level contract item (see docs/behaviour-contract.md, "Body").
// Values that cannot be passed through docker/Node (raw invalid UTF-8, an
// entry without '=', an empty name) are covered by unit tests instead.
// ---------------------------------------------------------------------------
const FIXTURE_ENV = {
  PARITY_SIMPLE: 'bar',
  PARITY_EMPTY: '',
  PARITY_EQUALS: 'a=b=c',
  PARITY_HTML: '<a href="x">&amp;</a>',
  PARITY_UNICODE: 'h\u00e9llo \u65e5\u672c \u{1F680}',
  PARITY_QUOTES: '"q" \\back\\ \'s\'',
  PARITY_NEWLINE: 'line1\nline2',
  PARITY_TAB: 'a\tb',
  PARITY_CONTROL: 'x\u0001y\u001fz',
  PARITY_LINESEP: 'x\u2028y\u2029z',
  PARITY_SPACES: '  leading and trailing  ',
  PARITY_LONG: 'L'.repeat(4096),
  parity_lowercase: 'lower',
  'PARITY.DOT-DASH': 'punctuated key',
};
const FIXTURE_HOSTNAME = 'parity-host';

// ---------------------------------------------------------------------------
// HTTP cases. `tags` let allow-list rules target specific cases.
// ---------------------------------------------------------------------------
const CASES = [
  { name: 'GET /', method: 'GET', path: '/' },
  { name: 'GET nested path', method: 'GET', path: '/some/deep/path/' },
  { name: 'GET file-like path', method: 'GET', path: '/favicon.ico' },
  { name: 'GET query string', method: 'GET', path: '/q?x=1&y=%3Cz%3E&x=2' },
  { name: 'GET encoded dot-dot', method: 'GET', path: '/%2e%2e/%2Fetc' },
  { name: 'GET Accept: text/html', method: 'GET', path: '/', headers: { Accept: 'text/html' } },
  { name: 'POST with JSON body', method: 'POST', path: '/', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' },
  { name: 'PUT with body', method: 'PUT', path: '/put', body: 'payload' },
  { name: 'PATCH', method: 'PATCH', path: '/patch', body: 'x' },
  { name: 'DELETE', method: 'DELETE', path: '/delete' },
  { name: 'OPTIONS', method: 'OPTIONS', path: '/' },
  { name: 'TRACE', method: 'TRACE', path: '/' },
  { name: 'HEAD /', method: 'HEAD', path: '/' },
  { name: 'GET unclean path /a/../b', method: 'GET', path: '/a/../b', tags: ['uncleanPath'] },
  { name: 'GET unclean path //x', method: 'GET', path: '//x', tags: ['uncleanPath'] },
  { name: 'extension method FOO', method: 'FOO', path: '/', tags: ['extensionMethod'] },
];

// Response headers that are inherently variable or pure transport framing
// (contract section "Headers"). Never compared, not even with --strict.
const IGNORED_HEADERS = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length']);

// ---------------------------------------------------------------------------
// ALLOW_LIST: the only differences that do not fail the run. Each id matches a
// row in docs/behaviour-contract.md "Intentional differences".
// A finding is {case, field, a, b, ctx}. A rule returns true to allow it.
// ---------------------------------------------------------------------------
const GO_CONTENT_TYPE = 'text/plain; charset=utf-8';
const JSON_CONTENT_TYPE = /^application\/json;\s*charset=utf-8$/i;
const RUNTIME_ENV_KEYS = new Set(['NODE_VERSION', 'YARN_VERSION']);

const ALLOW_LIST = [
  {
    id: 'D2-content-type',
    why: 'B sends Content-Type: application/json; charset=utf-8; Go sniffs text/plain',
    allows: (f) => f.field === 'header content-type' && f.a === GO_CONTENT_TYPE && JSON_CONTENT_TYPE.test(f.b ?? ''),
  },
  {
    id: 'D3-sigterm-exit',
    why: 'Go dies from the signal (143); B shuts down gracefully and exits 0',
    allows: (f) => f.field === 'shutdown exit code' && f.a === 143 && f.b === 0,
  },
  {
    id: 'D6-path-clean-redirect',
    why: 'Go ServeMux redirects unclean paths (301 up to Go 1.24, 307 in newer Go); B serves them like any other path',
    allows: (f) => f.tags.includes('uncleanPath') && [301, 307, 308].includes(f.ctx.a.status) && f.ctx.b.status === 200
      && f.ctx.bBodyEqualsRootA,
  },
  {
    id: 'D7-extension-method',
    why: 'node:http rejects non-standard methods (400) before the handler runs',
    allows: (f) => f.tags.includes('extensionMethod') && f.ctx.a.status === 200
      && [400, 405, 501].includes(f.ctx.b.status),
  },
  {
    id: 'D9-runtime-env-keys',
    why: 'env keys injected by the Node base image, present only in B',
    allows: (f) => f.field.startsWith('body key ') && f.a === undefined && RUNTIME_ENV_KEYS.has(f.key),
  },
  {
    id: 'D10-serialization',
    why: 'same JSON value, different bytes (key order / escaping of <>& U+2028 U+2029)',
    allows: (f) => f.field === 'body bytes',
  },
];

// ---------------------------------------------------------------------------
function fail(msg) {
  process.stderr.write(`parity-diff: ${msg}\n`);
  process.exit(2);
}

function httpRequest(base, c, timeout) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || 80,
      method: c.method,
      path: c.path,
      headers: { ...(c.headers || {}), ...(c.body !== undefined ? { 'Content-Length': Buffer.byteLength(c.body) } : {}) },
      agent: false,
      timeout,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeout}ms`)));
    req.on('error', reject);
    if (c.body !== undefined) req.write(c.body);
    req.end();
  });
}

async function waitReady(base, timeout, isAlive = () => true) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error('server process exited before becoming ready');
    try {
      await httpRequest(base, { method: 'GET', path: '/' }, 1000);
      return;
    } catch (e) { last = e; }
    await sleep(100);
  }
  throw new Error(`not ready at ${base} after ${timeout}ms: ${last?.message}`);
}

function parseJson(buf) {
  try {
    const v = JSON.parse(buf.toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch { return undefined; }
}

async function runCases(base, timeout) {
  const out = {};
  for (const c of CASES) {
    try {
      const r = await httpRequest(base, c, timeout);
      out[c.name] = { status: r.status, headers: r.headers, bodyText: r.body.toString('utf8'), bodyLength: r.body.length };
    } catch (e) {
      out[c.name] = { error: `${e.code || ''} ${e.message}`.trim() };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------
async function docker(args, opts = {}) {
  const { stdout, stderr } = await execFileP('docker', args, { maxBuffer: 64 << 20, ...opts });
  return { stdout, stderr };
}

async function runImage(image, label, opts) {
  const name = `parity-${label}-${process.pid}-${Date.now()}`;
  const envArgs = Object.entries(FIXTURE_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  cleanups.push(() => execFileP('docker', ['rm', '-f', name]).catch(() => {}));
  await docker(['run', '-d', '--name', name, '--hostname', FIXTURE_HOSTNAME,
    '-p', `127.0.0.1::${opts.containerPort}`, ...envArgs, image]);
  try {
    const { stdout: portOut } = await docker(['port', name, `${opts.containerPort}/tcp`]);
    const hostPort = portOut.trim().split('\n')[0];
    const base = `http://${hostPort}`;
    await waitReady(base, opts.timeout);
    const cases = await runCases(base, opts.timeout);
    let uid = null;
    try { uid = (await docker(['exec', name, 'id', '-u'])).stdout.trim(); } catch { uid = 'unknown (no `id` in image)'; }
    const grace = 10;
    const t0 = Date.now();
    await docker(['stop', '-t', String(grace), name]);
    const stopSeconds = (Date.now() - t0) / 1000;
    const exitCode = Number((await docker(['inspect', '-f', '{{.State.ExitCode}}', name])).stdout.trim());
    const logs = await docker(['logs', name]);
    return {
      base, cases, uid,
      stdout: logs.stdout, stderr: logs.stderr,
      shutdown: { exitCode, seconds: stopSeconds, graceful: exitCode !== 137 && stopSeconds < grace },
    };
  } finally {
    await execFileP('docker', ['rm', '-f', name]).catch(() => {});
  }
}

async function runCmd(cmd, opts) {
  const argv = cmd.trim().split(/\s+/);
  const env = { ...FIXTURE_ENV, PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
  const child = spawn(argv[0], argv.slice(1), { env, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.on('error', (e) => { stderr += `spawn error: ${e.message}`; });
  const base = `http://127.0.0.1:${opts.port}`;
  await waitReady(base, opts.timeout, () => child.exitCode === null && child.signalCode === null);
  const cases = await runCases(base, opts.timeout);
  const grace = 10;
  const t0 = Date.now();
  child.kill('SIGTERM');
  let killed = false;
  const res = await Promise.race([exited, sleep(grace * 1000).then(() => null)]);
  let final = res;
  if (!res) { killed = true; child.kill('SIGKILL'); final = await exited; }
  const seconds = (Date.now() - t0) / 1000;
  const SIGNUM = { SIGTERM: 15, SIGKILL: 9, SIGINT: 2 };
  const exitCode = final.signal ? 128 + (SIGNUM[final.signal] ?? 0) : final.code;
  await sleep(50);
  return { base, cases, uid: null, stdout, stderr, shutdown: { exitCode, seconds, graceful: !killed } };
}

async function runUrl(url, opts) {
  await waitReady(url, opts.timeout);
  return { base: url, cases: await runCases(url, opts.timeout) };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------
function show(v) {
  if (v === undefined) return '<absent>';
  const s = JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

function compare(A, B, opts) {
  const findings = [];
  const add = (caseName, field, a, b, extra = {}) => findings.push({ case: caseName, field, a, b, tags: [], ctx: {}, ...extra });
  const ignored = new Set(opts.ignoreKeys);
  const rootA = A.cases['GET /'] && parseJson(Buffer.from(A.cases['GET /'].bodyText ?? ''));
  const caseResults = [];

  for (const c of CASES) {
    const a = A.cases[c.name];
    const b = B.cases[c.name];
    const before = findings.length;
    const tags = c.tags || [];
    const bJson = b && !b.error ? parseJson(Buffer.from(b.bodyText)) : undefined;
    const ctx = { a: a || {}, b: b || {}, bBodyEqualsRootA: rootA !== undefined && bJson !== undefined && envDiff(rootA, bJson, ignored).filter((d) => !(d.a === undefined && RUNTIME_ENV_KEYS.has(d.key))).length === 0 };
    const extra = { tags, ctx };

    if (a.error || b.error) {
      if (a.error !== b.error) add(c.name, 'transport', a.error, b.error, extra);
    } else {
      if (a.status !== b.status) add(c.name, 'status', a.status, b.status, extra);
      const names = new Set([...Object.keys(a.headers), ...Object.keys(b.headers)]);
      for (const h of [...names].sort()) {
        if (IGNORED_HEADERS.has(h)) continue;
        if (show(a.headers[h]) !== show(b.headers[h])) add(c.name, `header ${h}`, a.headers[h], b.headers[h], extra);
      }
      // Framing: Content-Length may be absent (chunked) but, when present on a
      // response with a body, must equal the body length.
      for (const [side, r] of [['A', a], ['B', b]]) {
        const cl = r.headers['content-length'];
        if (c.method !== 'HEAD' && cl !== undefined && Number(cl) !== r.bodyLength) {
          add(c.name, `content-length mismatch (${side})`, side === 'A' ? `${cl} != ${r.bodyLength}` : undefined, side === 'B' ? `${cl} != ${r.bodyLength}` : undefined, extra);
        }
      }
      const aJson = parseJson(Buffer.from(a.bodyText));
      if (aJson && bJson) {
        for (const d of envDiff(aJson, bJson, ignored)) add(c.name, `body key ${JSON.stringify(d.key)}`, d.a, d.b, { ...extra, key: d.key });
        // Byte comparison is meaningless when an ignored key is present.
        const hasIgnored = [...ignored].some((k) => Object.hasOwn(aJson, k) || Object.hasOwn(bJson, k));
        if (!hasIgnored && a.bodyText !== b.bodyText) add(c.name, 'body bytes', `${a.bodyLength} bytes`, `${b.bodyLength} bytes`, extra);
      } else if (a.bodyText !== b.bodyText) {
        add(c.name, 'body', a.bodyText, b.bodyText, extra);
      }
    }
    caseResults.push({ name: c.name, findings: findings.slice(before) });
  }

  // Process-level checks (only when this script started the servers).
  const proc = [];
  if (A.stdout !== undefined && B.stdout !== undefined) {
    const before = findings.length;
    const norm = (s) => s.replace(/\r\n/g, '\n');
    if (norm(A.stdout) !== norm(B.stdout)) add('process', 'stdout', norm(A.stdout), norm(B.stdout));
    if (norm(A.stderr) !== norm(B.stderr)) add('process', 'stderr', norm(A.stderr), norm(B.stderr));
    if (A.shutdown.graceful !== B.shutdown.graceful) add('process', 'shutdown within grace period', A.shutdown.graceful, B.shutdown.graceful);
    if (A.shutdown.exitCode !== B.shutdown.exitCode) add('process', 'shutdown exit code', A.shutdown.exitCode, B.shutdown.exitCode);
    if (A.uid !== B.uid) add('process', 'runtime uid', A.uid, B.uid);
    proc.push({ name: 'process', findings: findings.slice(before) });
  }

  for (const f of findings) {
    const rule = opts.strict ? undefined : ALLOW_LIST.find((r) => r.allows(f));
    f.allowedBy = rule?.id;
  }
  return { cases: [...caseResults, ...proc], findings };
}

function envDiff(a, b, ignored) {
  const out = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    if (ignored.has(k)) continue;
    const av = Object.hasOwn(a, k) ? a[k] : undefined;
    const bv = Object.hasOwn(b, k) ? b[k] : undefined;
    if (av !== bv) out.push({ key: k, a: av, b: bv });
  }
  return out;
}

// ---------------------------------------------------------------------------
const cleanups = [];
async function cleanup() { for (const f of cleanups.splice(0)) await f(); }
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        'a-url': { type: 'string' }, 'b-url': { type: 'string' },
        'a-image': { type: 'string' }, 'b-image': { type: 'string' },
        'a-cmd': { type: 'string' }, 'b-cmd': { type: 'string' },
        port: { type: 'string', default: '8080' },
        'container-port': { type: 'string', default: '8080' },
        'ignore-key': { type: 'string', multiple: true, default: [] },
        strict: { type: 'boolean', default: false },
        report: { type: 'string' },
        timeout: { type: 'string', default: '15000' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (e) { fail(`${e.message}\n\n${USAGE}`); }
  if (values.help) { process.stdout.write(`${USAGE}\n`); return 0; }

  const opts = {
    port: Number(values.port), containerPort: Number(values['container-port']),
    timeout: Number(values.timeout), strict: values.strict, ignoreKeys: values['ignore-key'],
  };
  const modes = ['url', 'image', 'cmd'].filter((m) => values[`a-${m}`] || values[`b-${m}`]);
  if (modes.length !== 1 || !values[`a-${modes[0]}`] || !values[`b-${modes[0]}`]) {
    fail(`give exactly one pair of --a-X/--b-X (X = url, image or cmd)\n\n${USAGE}`);
  }
  const mode = modes[0];
  const a = values[`a-${mode}`];
  const b = values[`b-${mode}`];

  let A; let B;
  try {
    if (mode === 'url') { A = await runUrl(a, opts); B = await runUrl(b, opts); }
    if (mode === 'image') { [A, B] = await Promise.all([runImage(a, 'a', opts), runImage(b, 'b', opts)]); }
    if (mode === 'cmd') { A = await runCmd(a, opts); B = await runCmd(b, opts); }
  } catch (e) {
    await cleanup();
    fail(`could not run targets: ${e.message}`);
  }
  await cleanup();

  const result = compare(A, B, opts);
  const unexplained = result.findings.filter((f) => !f.allowedBy);
  const allowed = result.findings.filter((f) => f.allowedBy);

  const lines = [];
  lines.push(`parity-diff mode=${mode}${opts.strict ? ' (strict: allow-list disabled)' : ''}`);
  lines.push(`  A (reference): ${a}`);
  lines.push(`  B (candidate): ${b}`);
  if (opts.ignoreKeys.length) lines.push(`  ignored env keys (--ignore-key): ${opts.ignoreKeys.join(', ')}`);
  if (mode === 'url') lines.push('  note: url mode cannot control the environment or check startup/shutdown');
  for (const c of result.cases) {
    if (c.findings.length === 0) { lines.push(`= ${c.name}`); continue; }
    const mark = c.findings.some((f) => !f.allowedBy) ? '!' : '~';
    lines.push(`${mark} ${c.name}`);
    for (const f of c.findings) {
      const tag = f.allowedBy ? `~ allowed [${f.allowedBy}]` : '! UNEXPLAINED';
      lines.push(`    ${tag} ${f.field}: A=${show(f.a)} B=${show(f.b)}`);
    }
  }
  lines.push(`summary: ${result.cases.length} checks, ${result.cases.filter((c) => !c.findings.length).length} identical, `
    + `${allowed.length} allowed difference(s), ${unexplained.length} unexplained difference(s)`);
  process.stdout.write(`${lines.join('\n')}\n`);

  if (values.report) {
    const strip = ({ ctx, tags, ...rest }) => rest;
    writeFileSync(values.report, `${JSON.stringify({
      mode, a, b, strict: opts.strict, ignoreKeys: opts.ignoreKeys,
      allowList: ALLOW_LIST.map(({ id, why }) => ({ id, why })),
      unexplained: unexplained.map(strip), allowed: allowed.map(strip),
      raw: { a: A, b: B },
    }, null, 2)}\n`);
  }
  return unexplained.length ? 1 : 0;
}

main().then((code) => process.exit(code), async (e) => { await cleanup(); fail(e.stack || String(e)); });
