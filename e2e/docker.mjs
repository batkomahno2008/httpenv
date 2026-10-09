// docker.mjs - minimal helpers around the docker CLI and node:http.
// Node.js built-ins only; no npm dependencies.

import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const NAME_PREFIX = 'httpenv-25-e2e';
const live = new Set();

/** Run `docker <args>`; resolves {stdout, stderr}, rejects with stderr in the message. */
export function docker(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const why = err.killed ? `timed out after ${timeoutMs} ms` : `exit ${err.code}`;
          reject(new Error(`docker ${args.join(' ')} failed (${why}): ${String(stderr).trim()}`));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** Pull the image only if it is not present locally, so pulls never count against timeouts. */
export async function ensureImage(image, platform) {
  try {
    await docker(['image', 'inspect', image]);
  } catch {
    await docker(['pull', ...(platform ? ['--platform', platform] : []), image], {
      timeoutMs: 600_000,
    });
  }
}

/**
 * Start a detached container publishing 8080 on a random loopback port.
 * Returns { name, id, port }. The container is removed by cleanupAll().
 */
export async function startContainer(image, { env = {}, hostname, platform } = {}) {
  const name = `${NAME_PREFIX}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const args = ['run', '-d', '--name', name, '-p', '127.0.0.1::8080'];
  if (platform) args.push('--platform', platform);
  if (hostname) args.push('--hostname', hostname);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(image);
  live.add(name);
  const { stdout } = await docker(args);
  const id = stdout.trim();
  const { stdout: mapping } = await docker(['port', name, '8080/tcp']);
  const first = mapping.trim().split('\n')[0];
  const port = Number(first.slice(first.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port <= 0)
    throw new Error(`cannot parse published port from "${mapping}"`);
  return { name, id, port };
}

export async function inspect(name) {
  const { stdout } = await docker(['inspect', name]);
  return JSON.parse(stdout)[0];
}

export async function removeContainer(name) {
  try {
    await docker(['rm', '-f', '-v', name], { timeoutMs: 30_000 });
  } catch {
    // already gone
  }
  live.delete(name);
}

export async function cleanupAll() {
  await Promise.all([...live].map(removeContainer));
}

// Last-resort cleanup if the run is interrupted (Ctrl-C, CI cancellation).
function cleanupSync() {
  for (const name of live) {
    try {
      execFileSync('docker', ['rm', '-f', '-v', name], { stdio: 'ignore', timeout: 30_000 });
    } catch {
      // ignore
    }
  }
  live.clear();
}
process.once('exit', cleanupSync);
for (const [sig, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
]) {
  process.once(sig, () => {
    cleanupSync();
    process.exit(code);
  });
}

/** One HTTP request to 127.0.0.1:port. Resolves { status, headers, body: Buffer }. */
export function request(port, { method = 'GET', path = '/', timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, agent: false, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Poll GET / until it answers 200 or the deadline passes. A TCP accept alone is
 * not enough: docker-proxy accepts on the host port before the app listens.
 * Fails fast if the container exits. Resolves with the elapsed milliseconds.
 */
export async function waitReady(container, timeoutMs) {
  const start = Date.now();
  let last = 'no attempt';
  while (Date.now() - start < timeoutMs) {
    const state = (await inspect(container.name)).State;
    if (!state.Running) {
      const logs = await docker(['logs', container.name]).catch((e) => ({
        stdout: '',
        stderr: e.message,
      }));
      throw new Error(
        `container exited before becoming ready (exit ${state.ExitCode}).\n` +
          `stdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`,
      );
    }
    try {
      const remaining = timeoutMs - (Date.now() - start);
      const res = await request(container.port, {
        timeoutMs: Math.max(250, Math.min(2_000, remaining)),
      });
      if (res.status === 200) return Date.now() - start;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await sleep(200);
  }
  throw new Error(`not ready within ${timeoutMs} ms (last attempt: ${last})`);
}
